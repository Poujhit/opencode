import type { FileReplaceFile, FileReplaceItem, FileSearchFile, FileSearchItem } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "./session-layout"

function mark(text: string, ranges: { start: number; end: number }[]) {
  if (ranges.length === 0) return [<span>{text}</span>]

  const out = []
  let at = 0
  for (const item of ranges) {
    if (item.start > at) out.push(<span>{text.slice(at, item.start)}</span>)
    out.push(<mark class="bg-amber-400/25 text-text-strong rounded-sm">{text.slice(item.start, item.end)}</mark>)
    at = item.end
  }
  if (at < text.length) out.push(<span>{text.slice(at)}</span>)
  return out
}

function isPreview(item: FileSearchItem | FileReplaceItem): item is FileReplaceItem {
  return "next" in item
}

export function SessionSearchTab() {
  const file = useFile()
  const language = useLanguage()
  const { tabs, view } = useSessionLayout()
  const [store, setStore] = createStore({
    query: "",
    replace: "",
    loading: false,
    previewing: false,
    applying: false,
    err: undefined as string | undefined,
    result: undefined as Awaited<ReturnType<typeof file.searchText>> | undefined,
    preview: undefined as Awaited<ReturnType<typeof file.previewReplace>> | undefined,
  })
  let input: HTMLInputElement | undefined

  const open = (path: string, line?: number) => {
    const tab = file.tab(path)
    tabs().open(tab)
    tabs().setActive(tab)
    file.load(path)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    if (line) file.setSelectedLines(path, { start: line, end: line })
  }

  const search = async () => {
    const query = store.query.trim()
    if (!query) {
      setStore("result", undefined)
      setStore("preview", undefined)
      setStore("err", undefined)
      return
    }

    setStore("loading", true)
    setStore("err", undefined)
    try {
      const result = await file.searchText(query, 200)
      setStore("result", result)
      setStore("preview", undefined)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Search failed"
      setStore("err", message)
    } finally {
      setStore("loading", false)
    }
  }

  const preview = async (paths?: string[]) => {
    const query = store.query.trim()
    if (!query) return

    setStore("previewing", true)
    setStore("err", undefined)
    try {
      const result = await file.previewReplace(query, store.replace, paths)
      setStore("preview", result)
      if (!paths) setStore("result", undefined)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Preview failed"
      setStore("err", message)
    } finally {
      setStore("previewing", false)
    }
  }

  const apply = async (paths?: string[]) => {
    const query = store.query.trim()
    if (!query) return

    setStore("applying", true)
    setStore("err", undefined)
    try {
      const result = await file.applyReplace(query, store.replace, paths)
      showToast({
        variant: "success",
        title: "Replace applied",
        description: `${result?.replacements ?? 0} replacements in ${result?.files.length ?? 0} files`,
      })
      if (store.replace) {
        await preview(paths)
      } else {
        await search()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Replace failed"
      setStore("err", message)
    } finally {
      setStore("applying", false)
    }
  }

  createEffect(() => {
    const query = store.query.trim()
    const replace = store.replace
    if (!query) {
      setStore("result", undefined)
      setStore("preview", undefined)
      setStore("err", undefined)
      return
    }

    const id = window.setTimeout(() => {
      void search()
    }, 180)

    if (store.preview && replace !== undefined) setStore("preview", undefined)
    onCleanup(() => clearTimeout(id))
  })

  onMount(() => {
    input?.focus()
  })

  const files = () => store.preview?.files ?? store.result?.files ?? []
  const total = () => store.preview?.total_matches ?? store.result?.total_matches ?? 0
  const shown = () => files().length > 0

  return (
    <div class="h-full min-h-0 flex flex-col bg-background-stronger">
      <div class="px-3 pt-3 pb-2 border-b border-border-weaker-base flex flex-col gap-2">
        <input
          ref={input}
          data-file-search-input="project"
          value={store.query}
          placeholder="Search in workspace"
          class="h-9 px-3 rounded-md border border-border-base bg-background-base text-text-strong outline-none"
          onInput={(event) => setStore("query", event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            void search()
          }}
        />
        <div class="flex items-center gap-2">
          <input
            value={store.replace}
            placeholder="Replace"
            class="h-9 px-3 rounded-md border border-border-base bg-background-base text-text-strong outline-none flex-1 min-w-0"
            onInput={(event) => setStore("replace", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "enter") return
              event.preventDefault()
              void preview()
            }}
          />
          <Button variant="ghost" size="small" onClick={() => void preview()} disabled={!store.query.trim() || store.previewing}>
            Preview
          </Button>
          <Button
            variant="primary"
            size="small"
            onClick={() => void apply()}
            disabled={!store.query.trim() || store.applying || !shown()}
          >
            Apply All
          </Button>
        </div>
        <div class="flex items-center justify-between text-12-regular text-text-weak">
          <span>
            {language.t("common.search.placeholder")} · {total()} matches in {files().length} files
          </span>
          <Show when={store.loading || store.previewing || store.applying}>
            <span>{language.t("common.loading")}{language.t("common.loading.ellipsis")}</span>
          </Show>
        </div>
        <Show when={store.err}>
          {(err) => <div class="text-12-regular text-red-400">{err()}</div>}
        </Show>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        <Show when={shown()} fallback={<div class="text-12-regular text-text-weak">No search results</div>}>
          <div class="flex flex-col gap-3">
            <For each={files()}>
              {(item: FileSearchFile | FileReplaceFile) => (
                <div class="rounded-md border border-border-base bg-background-base overflow-hidden">
                  <div class="px-3 py-2 border-b border-border-weaker-base flex items-center gap-2">
                    <button
                      type="button"
                      class="min-w-0 flex-1 text-left text-12-medium text-text-strong truncate"
                      onClick={() => open(item.path, item.matches[0]?.line)}
                    >
                      {item.path}
                    </button>
                    <span class="text-12-regular text-text-weak">
                      {"replacements" in item ? item.replacements : item.matches.length}
                    </span>
                    <Show when={store.replace.trim()}>
                      <Button variant="ghost" size="small" onClick={() => void preview([item.path])}>
                        Preview
                      </Button>
                      <Button variant="secondary" size="small" onClick={() => void apply([item.path])}>
                        Apply
                      </Button>
                    </Show>
                  </div>
                  <div class="divide-y divide-border-weaker-base">
                    <For each={item.matches}>
                      {(match: FileSearchItem | FileReplaceItem) => (
                        <button
                          type="button"
                          class="w-full text-left px-3 py-2 hover:bg-surface-raised-base"
                          onClick={() => open(item.path, match.line)}
                        >
                          <div class="flex items-start gap-3">
                            <div class="w-10 shrink-0 text-12-regular text-text-weak tabular-nums">{match.line}</div>
                            <div class="min-w-0 flex-1 text-12-regular text-text-base font-mono break-all">
                              <div>{mark(match.text, match.ranges)}</div>
                              <Show when={isPreview(match)}>
                                <div class="mt-1 text-emerald-300">{match.next}</div>
                              </Show>
                            </div>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
