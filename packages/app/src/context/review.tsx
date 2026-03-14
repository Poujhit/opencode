import { createMemo, createRoot, createEffect, onCleanup } from "solid-js"
import { createStore, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useParams } from "@solidjs/router"
import { Persist, persisted } from "@/utils/persist"
import { createScopedCache } from "@/utils/scoped-cache"
import { useSync } from "@/context/sync"
import { cloneReview, deriveReview, pending, renderReview, reviewSig, type ReviewFile, type ReviewView, syncReview } from "./review-state"

const WORKSPACE = "__workspace__"
const MAX = 20

type ReviewStore = {
  file: Record<string, ReviewFile>
  dismiss: Record<string, string>
}

function sessionKey(dir: string, id: string | undefined) {
  return `${dir}\n${id ?? WORKSPACE}`
}

function decode(key: string) {
  const idx = key.lastIndexOf("\n")
  if (idx < 0) return { dir: key, id: WORKSPACE }
  return {
    dir: key.slice(0, idx),
    id: key.slice(idx + 1),
  }
}

function order(store: Store<ReviewStore>) {
  return Object.values(store.file).slice().sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time
    return a.file.localeCompare(b.file)
  })
}

function patch(
  store: Store<ReviewStore>,
  setStore: SetStoreFunction<ReviewStore>,
  file: string,
  edit: (item: ReviewFile) => ReviewFile,
) {
  const item = store.file[file]
  if (!item) return
  const next = edit(cloneReview(item))
  setStore("file", file, reconcile(next))
  return next
}

function createReviewSessionState(store: Store<ReviewStore>, setStore: SetStoreFunction<ReviewStore>) {
  return {
    list: () => order(store),
    unresolved: () => order(store).filter((item) => pending(item) > 0),
    get: (file: string) => store.file[file],
    view: (file: string): ReviewView | undefined => {
      const item = store.file[file]
      if (!item) return
      return renderReview(item)
    },
    sync: (items: ReviewFile[]) => {
      setStore("file", reconcile(syncReview(store.file, items, store.dismiss)))
    },
    approve: (file: string, idx: number) =>
      patch(store, setStore, file, (item) => {
        const hunk = item.hunks[idx]
        if (!hunk || hunk.state !== "pending") return item
        hunk.state = "accepted"
        return item
      }),
    reject: (file: string, idx: number) =>
      patch(store, setStore, file, (item) => {
        const hunk = item.hunks[idx]
        if (!hunk || hunk.state !== "pending") return item
        hunk.state = "rejected"
        return item
      }),
    approveAll: (file: string) =>
      patch(store, setStore, file, (item) => {
        item.hunks = item.hunks.map((hunk) => ({ ...hunk, state: "accepted" }))
        return item
      }),
    rejectAll: (file: string) =>
      patch(store, setStore, file, (item) => {
        item.hunks = item.hunks.map((hunk) => ({ ...hunk, state: "rejected" }))
        return item
      }),
    set: (file: string, item: ReviewFile) => {
      setStore("dismiss", (map) => {
        if (!(file in map)) return map
        const next = { ...map }
        delete next[file]
        return next
      })
      setStore("file", file, reconcile(cloneReview(item)))
    },
    clear: (file: string) => {
      const item = store.file[file]
      if (item) setStore("dismiss", file, reviewSig(item))
      setStore("file", (map) => {
        if (!(file in map)) return map
        const next = { ...map }
        delete next[file]
        return next
      })
    },
  }
}

export function createReviewSessionForTest(files: Record<string, ReviewFile> = {}) {
  const [store, setStore] = createStore<ReviewStore>({ file: files, dismiss: {} })
  return createReviewSessionState(store, setStore)
}

function createReviewSession(dir: string, id: string | undefined) {
  const legacy = `${dir}/review${id ? "/" + id : ""}.v1`
  const [store, setStore, _, ready] = persisted(
    Persist.scoped(dir, id, "review", [legacy]),
    createStore<ReviewStore>({
      file: {},
      dismiss: {},
    }),
  )
  const state = createReviewSessionState(store, setStore)
  return {
    ready,
    ...state,
  }
}

export const { use: useReview, provider: ReviewProvider } = createSimpleContext({
  name: "Review",
  gate: false,
  init: () => {
    const params = useParams()
    const sync = useSync()

    const cache = createScopedCache(
      (key) => {
        const value = decode(key)
        return createRoot((dispose) => ({
          value: createReviewSession(value.dir, value.id === WORKSPACE ? undefined : value.id),
          dispose,
        }))
      },
      {
        maxEntries: MAX,
        dispose: (item) => item.dispose(),
      },
    )

    onCleanup(() => cache.clear())

    const session = createMemo(() => cache.get(sessionKey(params.dir!, params.id)).value)
    const msgs = createMemo(() => {
      const id = params.id
      if (!id) return []
      return sync.data.message[id]
    })

    createEffect(() => {
      if (params.id && msgs() === undefined) return
      session().sync(deriveReview(msgs()))
    })

    return {
      ready: () => session().ready(),
      list: () => session().list(),
      unresolved: () => session().unresolved(),
      get: (file: string) => session().get(file),
      view: (file: string) => session().view(file),
      approve: (file: string, idx: number) => session().approve(file, idx),
      reject: (file: string, idx: number) => session().reject(file, idx),
      approveAll: (file: string) => session().approveAll(file),
      rejectAll: (file: string) => session().rejectAll(file),
      set: (file: string, item: ReviewFile) => session().set(file, item),
      clear: (file: string) => session().clear(file),
    }
  },
})
