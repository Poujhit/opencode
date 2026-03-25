import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { getFilename } from "@opencode-ai/util/path"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createPathHelpers } from "./file/path"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { createFileTreeStore } from "./file/tree-store"
import { invalidateFromWatcher } from "./file/watcher"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type LspDiagnostic,
  type LspLocation,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState, LspDiagnostic, LspLocation }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    useSync()
    const params = useParams()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk.directory)
    const path = createPathHelpers(scope)
    const tabs = layout.tabs(() => `${params.dir}${params.id ? "/" + params.id : ""}`)

    const inflight = new Map<string, Promise<void>>()
    const diag = new Map<string, number>()
    const diagBusy = new Set<string>()
    const edit = new Map<string, { version: number; content: string; timer?: ReturnType<typeof setTimeout> }>()
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    const tree = createFileTreeStore({
      scope,
      normalizeDir: path.normalizeDir,
      list: (dir) => sdk.client.file.list({ path: dir }).then((x) => x.data ?? []),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: message,
        })
      },
    })

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
          }),
        )
      })
    }

    createEffect(() => {
      scope()
      inflight.clear()
      diag.clear()
      diagBusy.clear()
      for (const item of edit.values()) {
        if (item.timer) clearTimeout(item.timer)
      }
      edit.clear()
      resetFileContentLru()
      batch(() => {
        setStore("file", reconcile({}))
        tree.reset()
      })
    })

    const viewCache = createFileViewCache()
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
        }),
      )
    }

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
        }),
      )
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const syncDiagnostics = (input: string) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()
      if (diagBusy.has(file)) return Promise.resolve()

      const dir = scope()
      const id = (diag.get(file) ?? 0) + 1
      diag.set(file, id)
      diagBusy.add(file)

      return sdk.client.lsp
        .editorDiagnostics({ path: file })
        .then((x) => {
          if (scope() !== dir) return
          if (diag.get(file) !== id) return
          setStore(
            "file",
            file,
            produce((draft) => {
              draft.diagnostics = x.data ?? []
            }),
          )
        })
        .catch(() => {
          if (scope() !== dir) return
          if (diag.get(file) !== id) return
        })
        .finally(() => {
          diagBusy.delete(file)
        })
    }

    const pushEditor = (file: string, item: { version: number; content: string }) =>
      sdk.client.lsp
        .editorSync({
          path: file,
          content: item.content,
          version: item.version,
        })
        .then(() => syncDiagnostics(file))
        .catch(() => {})

    const syncEditor = (input: string, content: string, wait = 200) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()
      ensure(file)
      const item = edit.get(file) ?? { version: -1, content }
      item.version += 1
      item.content = content
      if (item.timer) clearTimeout(item.timer)
      edit.set(file, item)
      if (wait <= 0) return pushEditor(file, item)
      return new Promise<void>((resolve) => {
        item.timer = setTimeout(() => {
          item.timer = undefined
          void pushEditor(file, item).finally(resolve)
        }, wait)
      })
    }

    const closeEditor = (input: string) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()
      const item = edit.get(file)
      if (item?.timer) clearTimeout(item.timer)
      edit.delete(file)
      return sdk.client.lsp.editorClose({ path: file }).catch(() => {})
    }

    const editorDefinition = (input: { file: string; line: number; character: number }) =>
      sdk.client.lsp
        .editorDefinition(input)
        .then((x) => x.data ?? [])
        .catch(() => [])

    const load = (input: string, options?: { force?: boolean }) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const directory = scope()
      const key = `${directory}\n${file}`
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Promise.resolve()

      const pending = inflight.get(key)
      if (pending) return pending

      setLoading(file)

      const promise = sdk.client.file
        .read({ path: file })
        .then((x) => {
          if (scope() !== directory) return
          const content = x.data
          setLoaded(file, content)

          if (!content) return
          touchFileContent(file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (scope() !== directory) return
          setLoadError(file, errorMessage(e, language.t("error.chain.unknown")))
        })
        .finally(() => {
          inflight.delete(key)
        })

      inflight.set(key, promise)
      return promise
    }

    const search = (query: string, dirs: "true" | "false") =>
      sdk.client.find.files({ query, dirs }).then(
        (x) => (x.data ?? []).map(path.normalize),
        () => [],
      )

    const stop = sdk.event.listen((e) => {
      const event = e.details
      invalidateFromWatcher(event, {
        normalize: path.normalize,
        hasFile: (file) => Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        loadFile: (file) => {
          void load(file, { force: true })
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: (dir) => {
          void tree.listDir(dir, { force: true })
        },
      })

      if (event.type !== "lsp.client.diagnostics") return
      const file = path.normalize(event.properties.path)
      if (!file) return
      if (!store.file[file] && !tabs.all().some((tab) => path.pathFromTab(tab) === file)) return
      void syncDiagnostics(file)
    })

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const diagnostics = (input: string) => withPath(input, (file) => store.file[file]?.diagnostics)
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    onCleanup(() => {
      stop()
      viewCache.clear()
    })

    const save = async (input: string, content: string) => {
      const file = path.normalize(input)
      if (!file) return

      const response = await sdk.client.file.write({
        path: file,
        content,
      })

      if (response.error) {
        throw new Error(
          typeof response.error === "string"
            ? response.error
            : ((response.error as any)?.message ?? (response.error as any)?.error ?? "Failed to save file"),
        )
      }

      // Reload file to get updated content, diff, etc.
      await load(file, { force: true })
    }

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        state: tree.dirState,
        children: tree.children,
        expand: tree.expandDir,
        collapse: tree.collapseDir,
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
      },
      get,
      load,
      save,
      scrollTop,
      scrollLeft,
      diagnostics,
      refreshEditorDiagnostics: syncDiagnostics,
      syncEditor,
      closeEditor,
      editorDefinition,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string) => search(query, "false"),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
      searchText: (pattern: string, limit?: number, sensitive = false, word = false) =>
        sdk.client.find
          .text({
            pattern,
            sensitive: sensitive ? "true" : "false",
            word: word ? "true" : "false",
            ...(limit ? { limit } : {}),
          })
          .then((x) => x.data),
      previewReplace: (search: string, replace: string, paths?: string[], sensitive = false, word = false) =>
        sdk.client.find
          .replacePreview({ search, replace, sensitive, word, ...(paths?.length ? { paths } : {}) })
          .then((x) => x.data),
      applyReplace: (search: string, replace: string, paths?: string[], sensitive = false, word = false) =>
        sdk.client.find
          .replaceApply({ search, replace, sensitive, word, ...(paths?.length ? { paths } : {}) })
          .then((x) => x.data),
    }
  },
})
