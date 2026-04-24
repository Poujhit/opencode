import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { Instance } from "@/project/instance"
import { Effect, Layer, Context, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { realpathSync } from "fs"
import z from "zod"

const cfg = [
  "--no-optional-locks",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.quotepath=false",
] as const

const out = (result: { text(): string }) => result.text().trim()
const nuls = (text: string) => text.split("\0").filter(Boolean)
const fail = (err: unknown) =>
  ({
    exitCode: 1,
    text: () => "",
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
  }) satisfies Result

export type Kind = "added" | "deleted" | "modified"

export type Base = {
  readonly name: string
  readonly ref: string
}

export type Item = {
  readonly file: string
  readonly code: string
  readonly status: Kind
}

export type Stat = {
  readonly file: string
  readonly additions: number
  readonly deletions: number
}

export interface Result {
  readonly exitCode: number
  readonly text: () => string
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export interface Options {
  readonly cwd: string
  readonly env?: Record<string, string>
}

export interface Interface {
  readonly run: (args: string[], opts: Options) => Effect.Effect<Result>
  readonly branch: (cwd: string) => Effect.Effect<string | undefined>
  readonly prefix: (cwd: string) => Effect.Effect<string>
  readonly defaultBranch: (cwd: string) => Effect.Effect<Base | undefined>
  readonly hasHead: (cwd: string) => Effect.Effect<boolean>
  readonly mergeBase: (cwd: string, base: string, head?: string) => Effect.Effect<string | undefined>
  readonly show: (cwd: string, ref: string, file: string, prefix?: string) => Effect.Effect<string>
  readonly status: (cwd: string) => Effect.Effect<Item[]>
  readonly diff: (cwd: string, ref: string) => Effect.Effect<Item[]>
  readonly stats: (cwd: string, ref: string) => Effect.Effect<Stat[]>
}

const kind = (code: string): Kind => {
  if (code === "??") return "added"
  if (code.includes("U")) return "modified"
  if (code.includes("A") && !code.includes("D")) return "added"
  if (code.includes("D") && !code.includes("A")) return "deleted"
  return "modified"
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Git") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const run = Effect.fn("Git.run")(
      function* (args: string[], opts: Options) {
        const proc = ChildProcess.make("git", [...cfg, ...args], {
          cwd: opts.cwd,
          env: opts.env,
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const handle = yield* spawner.spawn(proc)
        const [stdout, stderr] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
          { concurrency: 2 },
        )
        return {
          exitCode: yield* handle.exitCode,
          text: () => stdout,
          stdout: Buffer.from(stdout),
          stderr: Buffer.from(stderr),
        } satisfies Result
      },
      Effect.scoped,
      Effect.catch((err) => Effect.succeed(fail(err))),
    )

    const text = Effect.fn("Git.text")(function* (args: string[], opts: Options) {
      return (yield* run(args, opts)).text()
    })

    const lines = Effect.fn("Git.lines")(function* (args: string[], opts: Options) {
      return (yield* text(args, opts))
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    })

    const refs = Effect.fnUntraced(function* (cwd: string) {
      return yield* lines(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd })
    })

    const configured = Effect.fnUntraced(function* (cwd: string, list: string[]) {
      const result = yield* run(["config", "init.defaultBranch"], { cwd })
      const name = out(result)
      if (!name || !list.includes(name)) return
      return { name, ref: name } satisfies Base
    })

    const primary = Effect.fnUntraced(function* (cwd: string) {
      const list = yield* lines(["remote"], { cwd })
      if (list.includes("origin")) return "origin"
      if (list.length === 1) return list[0]
      if (list.includes("upstream")) return "upstream"
      return list[0]
    })

    const branch = Effect.fn("Git.branch")(function* (cwd: string) {
      const result = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const prefix = Effect.fn("Git.prefix")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--show-prefix"], { cwd })
      if (result.exitCode !== 0) return ""
      return out(result)
    })

    const defaultBranch = Effect.fn("Git.defaultBranch")(function* (cwd: string) {
      const remote = yield* primary(cwd)
      if (remote) {
        const head = yield* run(["symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd })
        if (head.exitCode === 0) {
          const ref = out(head).replace(/^refs\/remotes\//, "")
          const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ""
          if (name) return { name, ref } satisfies Base
        }
      }

      const list = yield* refs(cwd)
      const next = yield* configured(cwd, list)
      if (next) return next
      if (list.includes("main")) return { name: "main", ref: "main" } satisfies Base
      if (list.includes("master")) return { name: "master", ref: "master" } satisfies Base
    })

    const hasHead = Effect.fn("Git.hasHead")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--verify", "HEAD"], { cwd })
      return result.exitCode === 0
    })

    const mergeBase = Effect.fn("Git.mergeBase")(function* (cwd: string, base: string, head = "HEAD") {
      const result = yield* run(["merge-base", base, head], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const show = Effect.fn("Git.show")(function* (cwd: string, ref: string, file: string, prefix = "") {
      const target = prefix ? `${prefix}${file}` : file
      const result = yield* run(["show", `${ref}:${target}`], { cwd })
      if (result.exitCode !== 0) return ""
      if (result.stdout.includes(0)) return ""
      return result.text()
    })

    const status = Effect.fn("Git.status")(function* (cwd: string) {
      return nuls(
        yield* text(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
          cwd,
        }),
      ).flatMap((item) => {
        const file = item.slice(3)
        if (!file) return []
        const code = item.slice(0, 2)
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const diff = Effect.fn("Git.diff")(function* (cwd: string, ref: string) {
      const list = nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, "--", "."], { cwd }),
      )
      return list.flatMap((code, idx) => {
        if (idx % 2 !== 0) return []
        const file = list[idx + 1]
        if (!code || !file) return []
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const stats = Effect.fn("Git.stats")(function* (cwd: string, ref: string) {
      return nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", ref, "--", "."], { cwd }),
      ).flatMap((item) => {
        const a = item.indexOf("\t")
        const b = item.indexOf("\t", a + 1)
        if (a === -1 || b === -1) return []
        const file = item.slice(b + 1)
        if (!file) return []
        const adds = item.slice(0, a)
        const dels = item.slice(a + 1, b)
        const additions = adds === "-" ? 0 : Number.parseInt(adds || "0", 10)
        const deletions = dels === "-" ? 0 : Number.parseInt(dels || "0", 10)
        return [
          {
            file,
            additions: Number.isFinite(additions) ? additions : 0,
            deletions: Number.isFinite(deletions) ? deletions : 0,
          } satisfies Stat,
        ]
      })
    })

    return Service.of({
      run,
      branch,
      prefix,
      defaultBranch,
      hasHead,
      mergeBase,
      show,
      status,
      diff,
      stats,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))

export const Summary = z.object({
  files: z.number(),
  added: z.number(),
  removed: z.number(),
})
export type Summary = z.infer<typeof Summary>

export const Status = z
  .object({
    root: z.string().optional(),
    branch: z.string().optional(),
    upstream: z.string().optional(),
    ahead: z.number(),
    behind: z.number(),
    staged: z.number(),
    unstaged: z.number(),
    untracked: z.number(),
    changed: z.number(),
    clean: z.boolean(),
    has_upstream: z.boolean(),
    can_push: z.boolean(),
    summary: Summary,
  })
  .meta({ ref: "GitStatus" })
export type Status = z.infer<typeof Status>

export const Branch = z
  .object({
    name: z.string(),
    current: z.boolean(),
  })
  .meta({ ref: "GitBranch" })
export type Branch = z.infer<typeof Branch>

export const Commit = z
  .object({
    sha: z.string(),
    status: Status,
  })
  .meta({ ref: "GitCommit" })
export type Commit = z.infer<typeof Commit>

export const Push = z
  .object({
    status: Status,
  })
  .meta({ ref: "GitPush" })
export type Push = z.infer<typeof Push>

export const Message = z
  .object({
    message: z.string(),
  })
  .meta({ ref: "GitMessage" })
export type Message = z.infer<typeof Message>

export const Generate = z
  .object({
    include_unstaged: z.boolean().default(false),
  })
  .meta({ ref: "GitGenerate" })
export type Generate = z.infer<typeof Generate>

export class Error extends globalThis.Error {
  constructor(
    override readonly message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

type State = Omit<Status, "clean" | "has_upstream" | "can_push" | "summary">
type Row = Summary

function exec(args: string[], cwd = Instance.directory) {
  const out = Bun.spawnSync({
    cmd: ["git", "--no-optional-locks", "-c", "core.quotepath=false", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
    },
  })
  const text = out.stdout.toString().trim()
  const err = out.stderr.toString().trim()
  if (out.exitCode === 0) return text
  throw new Error(err || text || `git ${args.join(" ")} failed`)
}

function inside() {
  try {
    exec(["rev-parse", "--show-toplevel"])
    return true
  } catch {
    return false
  }
}

export function parseStatus(text: string): State {
  const changed = new Set<string>()
  const result: State = {
    root: undefined,
    branch: undefined,
    upstream: undefined,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    changed: 0,
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.oid ")) result.root = result.root
    if (line.startsWith("# branch.head ")) result.branch = line.slice("# branch.head ".length)
    if (line.startsWith("# branch.upstream ")) result.upstream = line.slice("# branch.upstream ".length)
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/)
      result.ahead = Number(match?.[1] ?? 0)
      result.behind = Number(match?.[2] ?? 0)
    }
    if (line.startsWith("? ")) {
      result.untracked++
      changed.add(line.slice(2))
    }
    if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const code = line.slice(2, 4)
      if (code[0] !== ".") result.staged++
      if (code[1] !== ".") result.unstaged++
      const file = line.split(" ").at(-1)
      if (file) changed.add(file)
    }
  }
  result.changed = changed.size
  return result
}

export function parseRows(text: string): Row {
  return text.split("\n").reduce(
    (sum, line) => {
      const [adds, dels, file] = line.split("\t")
      if (!file) return sum
      return {
        files: sum.files + 1,
        added: sum.added + (adds === "-" ? 0 : Number(adds || 0)),
        removed: sum.removed + (dels === "-" ? 0 : Number(dels || 0)),
      }
    },
    { files: 0, added: 0, removed: 0 },
  )
}

export function parseBranches(text: string): Branch[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, marker] = line.split("\t")
      return { name, current: marker === "*" }
    })
    .sort((a, b) => Number(b.current) - Number(a.current))
}

export function compactNames(text: string) {
  return text.trim()
}

export function compactPatch(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@ "))
    .join("\n")
}

export async function status(): Promise<Status> {
  if (!inside()) {
    return {
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      changed: 0,
      clean: true,
      has_upstream: false,
      can_push: false,
      summary: { files: 0, added: 0, removed: 0 },
    }
  }
  const root = realpathSync(exec(["rev-parse", "--show-toplevel"]))
  const state = parseStatus(exec(["status", "--porcelain=v2", "--branch"]))
  const summary = (() => {
    try {
      return parseRows(exec(["diff", "--numstat", "HEAD"]))
    } catch {
      return { files: 0, added: 0, removed: 0 }
    }
  })()
  const remote = (() => {
    try {
      return exec(["remote"]).split("\n").filter(Boolean)
    } catch {
      return []
    }
  })()
  return {
    ...state,
    root,
    clean: state.changed === 0,
    has_upstream: !!state.upstream,
    can_push: !!state.upstream || remote.includes("origin"),
    summary,
  }
}

export async function branches() {
  if (!inside()) return [] as Branch[]
  return parseBranches(exec(["branch", "--list", "--format=%(refname:short)\t%(HEAD)"]))
}

export async function checkout(name: string) {
  const branch = name.trim()
  if (!(await branches()).some((item) => item.name === branch)) throw new Error(`Branch "${branch}" was not found`, 404)
  exec(["checkout", branch])
  return status()
}

export async function commit(input: { message?: string; include_unstaged: boolean }) {
  const message = input.message?.trim()
  if (!message) throw new Error("Commit message is required")
  if (input.include_unstaged) exec(["add", "--all"])
  if (!exec(["diff", "--cached", "--name-only"])) throw new Error("No staged changes to commit")
  exec(["commit", "-m", message])
  return {
    sha: exec(["rev-parse", "HEAD"]),
    status: await status(),
  }
}

export async function push() {
  const current = await status()
  if (!current.branch) throw new Error("No current branch")
  if (current.has_upstream) exec(["push"])
  else if (current.can_push) exec(["push", "-u", "origin", current.branch])
  else throw new Error("No upstream or origin remote is configured for this branch")
  return { status: await status() }
}

export async function generate(_input: Generate) {
  if (!exec(["diff", "--cached", "--name-only"]) && !exec(["diff", "--name-only"])) {
    throw new Error("No diff is available to generate a commit message")
  }
  return { message: "chore: update files" }
}

export * as Git from "."
