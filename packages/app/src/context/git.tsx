import { createSimpleContext } from "@opencode-ai/ui/context"
import type { GitBranch, GitCommit, GitMessage, GitPush, GitStatus } from "@opencode-ai/sdk/v2/client"
import { batch, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "./global-sdk"
import { useSDK } from "./sdk"

const POLL_MS = 5_000

export function summary(input: GitStatus | undefined, include: boolean) {
  if (!input) return undefined
  return include ? input.combined : input.staged
}

export function changes(input: GitStatus | undefined) {
  if (!input) return 0
  return input.combined.files
}

export function active(input: GitStatus | undefined) {
  return Boolean(input?.root || input?.branch)
}

export const { use: useGit, provider: GitProvider } = createSimpleContext({
  name: "Git",
  init: () => {
    const sdk = useSDK()
    const globalSDK = useGlobalSDK()
    let refreshing: Promise<void> | undefined

    const [store, setStore] = createStore({
      status: undefined as GitStatus | undefined,
      branches: [] as GitBranch[],
      loading: false,
      branching: false,
      committing: false,
      pushing: false,
      generating: false,
    })

    const refresh = async () => {
      if (refreshing) return refreshing
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      const first = store.status === undefined
      if (first) setStore("loading", true)
      refreshing = sdk.client.git
        .status()
        .then((result) => {
          setStore("status", result.data)
          if (!active(result.data)) {
            setStore("branches", [])
            return
          }
          if (result.data?.branch && store.branches.length === 0) {
            void load().catch(() => {})
          }
        })
        .catch(() => {
          setStore("status", undefined)
          setStore("branches", [])
        })
        .finally(() => {
          if (first) setStore("loading", false)
          refreshing = undefined
        })
      return refreshing
    }

    const load = async (force = false) => {
      if (store.branches.length > 0 && !force) return store.branches
      setStore("branching", true)
      return sdk.client.git
        .branches()
        .then((result) => {
          const list = result.data ?? []
          setStore("branches", list)
          return list
        })
        .finally(() => {
          setStore("branching", false)
        })
    }

    const checkout = async (branch: string) => {
      setStore("branching", true)
      try {
        const result = await sdk.client.git.checkout({ branch })
        batch(() => {
          setStore("status", result.data)
          setStore("branches", store.branches.map((item) => ({ ...item, current: item.name === branch })))
        })
        return result.data
      } finally {
        setStore("branching", false)
      }
    }

    const commit = async (input: { message?: string; include_unstaged: boolean }) => {
      setStore("committing", true)
      try {
        const result = await sdk.client.git.commit(input)
        setStore("status", result.data?.status)
        return result.data as GitCommit | undefined
      } finally {
        setStore("committing", false)
      }
    }

    const push = async () => {
      setStore("pushing", true)
      try {
        const result = await sdk.client.git.push()
        setStore("status", result.data?.status)
        return result.data as GitPush | undefined
      } finally {
        setStore("pushing", false)
      }
    }

    const generate = async (input: {
      include_unstaged: boolean
      providerID?: string
      modelID?: string
      sessionID?: string
    }) => {
      setStore("generating", true)
      try {
        const result = await sdk.client.git.generate({
          gitGenerate: input,
        })
        return result.data as GitMessage | undefined
      } finally {
        setStore("generating", false)
      }
    }

    onMount(() => {
      void refresh()
      const poll = setInterval(() => {
        void refresh()
      }, POLL_MS)
      const focus = () => {
        void refresh()
      }
      const visible = () => {
        if (document.visibilityState !== "visible") return
        void refresh()
      }
      const stop = [
        sdk.event.on("file.edited", focus),
        sdk.event.on("file.watcher.updated", focus),
        sdk.event.on("vcs.branch.updated", focus),
        globalSDK.event.on("global", (event) => {
          if (event.type !== "server.connected") return
          void refresh()
        }),
      ]
      if (typeof window !== "undefined") {
        window.addEventListener("focus", focus)
        document.addEventListener("visibilitychange", visible)
      }
      onCleanup(() => {
        clearInterval(poll)
        stop.forEach((item) => item())
        if (typeof window !== "undefined") {
          window.removeEventListener("focus", focus)
          document.removeEventListener("visibilitychange", visible)
        }
      })
    })

    return {
      get status() {
        return store.status
      },
      get branches() {
        return store.branches
      },
      get loading() {
        return store.loading
      },
      get branching() {
        return store.branching
      },
      get committing() {
        return store.committing
      },
      get pushing() {
        return store.pushing
      },
      get generating() {
        return store.generating
      },
      active: createMemo(() => active(store.status)),
      changes: createMemo(() => changes(store.status)),
      refresh,
      load,
      checkout,
      commit,
      push,
      generate,
    }
  },
})
