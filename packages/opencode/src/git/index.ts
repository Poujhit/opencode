import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Vcs } from "@/project/vcs"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import type { MessageV2 } from "@/session/message-v2"
import { git } from "@/util/git"
import { Log } from "@/util/log"
import path from "path"
import z from "zod"

export namespace Git {
  const log = Log.create({ service: "git" })

  export const Summary = z
    .object({
      files: z.number().int(),
      added: z.number().int(),
      removed: z.number().int(),
    })
    .meta({
      ref: "GitSummary",
    })
  export type Summary = z.infer<typeof Summary>

  export const Status = z
    .object({
      branch: z.string().optional(),
      upstream: z.string().optional(),
      ahead: z.number().int(),
      behind: z.number().int(),
      clean: z.boolean(),
      staged: Summary,
      unstaged: Summary,
      untracked: Summary,
      combined: Summary,
      has_upstream: z.boolean(),
      can_push: z.boolean(),
    })
    .meta({
      ref: "GitStatus",
    })
  export type Status = z.infer<typeof Status>

  export const Branch = z
    .object({
      name: z.string(),
      current: z.boolean(),
    })
    .meta({
      ref: "GitBranch",
    })
  export type Branch = z.infer<typeof Branch>

  export const Commit = z
    .object({
      sha: z.string(),
      status: Status,
    })
    .meta({
      ref: "GitCommit",
    })
  export type Commit = z.infer<typeof Commit>

  export const Push = z
    .object({
      status: Status,
    })
    .meta({
      ref: "GitPush",
    })
  export type Push = z.infer<typeof Push>

  export const Message = z
    .object({
      message: z.string(),
    })
    .meta({
      ref: "GitMessage",
    })
  export type Message = z.infer<typeof Message>

  export const Generate = z
    .object({
      include_unstaged: z.boolean().default(false),
      providerID: z.string().optional(),
      modelID: z.string().optional(),
      sessionID: Identifier.schema("session").optional(),
    })
    .meta({
      ref: "GitGenerate",
    })
  export type Generate = z.infer<typeof Generate>

  export class Error extends globalThis.Error {
    constructor(
      override readonly message: string,
      readonly status = 400,
    ) {
      super(message)
      this.name = "GitError"
    }
  }

  type State = {
    branch?: string
    upstream?: string
    ahead: number
    behind: number
    staged: number
    unstaged: number
    untracked: number
    changed: number
  }

  type Row = {
    files: number
    added: number
    removed: number
  }

  function ensure() {
    if (Instance.project.vcs === "git") return
    throw new Error("Git is not available for this workspace")
  }

  function fail(message: string, status = 400): never {
    throw new Error(message, status)
  }

  function empty(): Summary {
    return {
      files: 0,
      added: 0,
      removed: 0,
    }
  }

  function parseNum(text: string) {
    const n = Number.parseInt(text, 10)
    return Number.isFinite(n) ? n : 0
  }

  export function parseStatus(text: string): State {
    const result: State = {
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      changed: 0,
    }

    for (const line of text.split("\n")) {
      if (!line) continue
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim()
        if (value && value !== "(detached)") result.branch = value
        continue
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim()
        if (value) result.upstream = value
        continue
      }
      if (line.startsWith("# branch.ab ")) {
        const [, , ahead = "+0", behind = "-0"] = line.split(" ")
        result.ahead = parseNum(ahead.slice(1))
        result.behind = parseNum(behind.slice(1))
        continue
      }
      if (line.startsWith("? ")) {
        result.untracked += 1
        result.changed += 1
        continue
      }
      if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) continue
      const x = line[2]
      const y = line[3]
      if (x && x !== ".") result.staged += 1
      if (y && y !== ".") result.unstaged += 1
      result.changed += 1
    }

    return result
  }

  export function parseRows(text: string): Row {
    return text
      .split("\n")
      .filter(Boolean)
      .reduce<Row>(
        (acc, line) => {
          const [added, removed] = line.split("\t")
          return {
            files: acc.files + 1,
            added: acc.added + (added === "-" ? 0 : parseNum(added)),
            removed: acc.removed + (removed === "-" ? 0 : parseNum(removed)),
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
        const [name = "", flag = ""] = line.split("\t")
        return {
          name,
          current: flag.trim() === "*",
        }
      })
      .filter((item) => item.name)
      .sort((a, b) => {
        if (a.current) return -1
        if (b.current) return 1
        return a.name.localeCompare(b.name)
      })
  }

  async function call(args: string[]) {
    ensure()
    const result = await git(args, {
      cwd: Instance.directory,
      env: {
        GIT_OPTIONAL_LOCKS: "0",
      },
    })
    if (result.exitCode === 0) return result
    const err = result.stderr.toString().trim() || result.text().trim() || "Git command failed"
    fail(err)
  }

  async function run(args: string[]) {
    const result = await call(args)
    return result.text().trim()
  }

  async function head() {
    if (Instance.project.vcs !== "git") return false
    const result = await git(["rev-parse", "--verify", "HEAD"], {
      cwd: Instance.directory,
      env: {
        GIT_OPTIONAL_LOCKS: "0",
      },
    })
    return result.exitCode === 0
  }

  async function remotes() {
    if (Instance.project.vcs !== "git") return []
    const result = await git(["remote"], {
      cwd: Instance.directory,
      env: {
        GIT_OPTIONAL_LOCKS: "0",
      },
    })
    if (result.exitCode !== 0) return []
    return result
      .text()
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean)
  }

  async function lines(paths: string[]) {
    const list = await Promise.all(
      paths.map(async (file) => {
        const full = path.join(Instance.directory, file)
        if (!Instance.containsPath(full)) return 0
        if (!(await Bun.file(full).exists())) return 0
        const text = await Bun.file(full).text().catch(() => "")
        if (!text) return 0
        return text.split("\n").length
      }),
    )
    return list.reduce((sum, item) => sum + item, 0)
  }

  async function untracked() {
    if (Instance.project.vcs !== "git") return empty()
    const out = await run(["ls-files", "--others", "--exclude-standard"]).catch(() => "")
    const files = out ? out.split("\n").filter(Boolean) : []
    return {
      files: files.length,
      added: await lines(files),
      removed: 0,
    }
  }

  async function diff(args: string[]) {
    const text = await run(args).catch(() => "")
    return parseRows(text)
  }

  async function unstaged() {
    return diff(["diff", "--numstat"])
  }

  async function combined(hasHead: boolean) {
    if (hasHead) return run(["diff", "--numstat", "HEAD"]).catch(() => "")
    const [base, work] = await Promise.all([
      run(["diff", "--cached", "--numstat"]).catch(() => ""),
      run(["diff", "--numstat"]).catch(() => ""),
    ])
    return [base, work].filter(Boolean).join("\n")
  }

  async function patch(include: boolean) {
    if (include) {
      const base = await run(["diff", "--cached", "--patch"]).catch(() => "")
      const work = await run(["diff", "--patch"]).catch(() => "")
      return [base, work].filter(Boolean).join("\n")
    }
    return run(["diff", "--cached", "--patch"]).catch(() => "")
  }

  export async function status() {
    if (Instance.project.vcs !== "git") {
      return {
        branch: undefined,
        upstream: undefined,
        ahead: 0,
        behind: 0,
        clean: true,
        staged: empty(),
        unstaged: empty(),
        untracked: empty(),
        combined: empty(),
        has_upstream: false,
        can_push: false,
      } satisfies Status
    }

    const hasHead = await head()
    const [porcelain, stagedDiff, unstagedDiff, untrackedDiff, remote, joined] = await Promise.all([
      run(["status", "--porcelain=v2", "--branch", "--ahead-behind"]).catch(() => ""),
      hasHead ? diff(["diff", "--cached", "--numstat", "HEAD"]) : diff(["diff", "--cached", "--numstat"]),
      unstaged(),
      untracked(),
      remotes(),
      combined(hasHead),
    ])
    const info = parseStatus(porcelain)
    const rows = parseRows(joined)
    return {
      branch: info.branch,
      upstream: info.upstream,
      ahead: info.ahead,
      behind: info.behind,
      clean: info.changed === 0,
      staged: {
        files: info.staged,
        added: stagedDiff.added,
        removed: stagedDiff.removed,
      },
      unstaged: {
        files: info.unstaged,
        added: unstagedDiff.added,
        removed: unstagedDiff.removed,
      },
      untracked: untrackedDiff,
      combined: {
        files: info.changed,
        added: rows.added + untrackedDiff.added,
        removed: rows.removed,
      },
      has_upstream: Boolean(info.upstream),
      can_push: Boolean(info.branch && (info.upstream || remote.includes("origin"))),
    } satisfies Status
  }

  export async function branches() {
    if (Instance.project.vcs !== "git") return [] as Branch[]
    const out = await run(["branch", "--list", "--format=%(refname:short)\t%(HEAD)"]).catch(() => "")
    return parseBranches(out)
  }

  export async function checkout(name: string) {
    ensure()
    const branch = name.trim()
    if (!branch) fail("Branch name is required")
    const list = await branches()
    if (!list.some((item) => item.name === branch)) fail(`Branch "${branch}" was not found`)
    await call(["checkout", branch])
    await Bus.publish(Vcs.Event.BranchUpdated, { branch })
    return status()
  }

  export async function commit(input: { message?: string; include_unstaged: boolean }) {
    ensure()
    const message = input.message?.trim()
    if (!message) fail("Commit message is required")
    if (input.include_unstaged) {
      await call(["add", "-A"])
    }

    const current = await status()
    if (current.staged.files === 0) {
      fail(input.include_unstaged ? "No changes available to commit" : "No staged changes to commit")
    }

    await call(["commit", "-m", message])
    const sha = await run(["rev-parse", "HEAD"])
    return {
      sha,
      status: await status(),
    } satisfies Commit
  }

  export async function push() {
    ensure()
    const current = await status()
    if (!current.branch) fail("Current branch could not be determined")
    if (!current.can_push) fail("No upstream or origin remote is configured for this branch")
    if (current.has_upstream) {
      await call(["push"])
    } else {
      await call(["push", "-u", "origin", current.branch])
    }
    return {
      status: await status(),
    } satisfies Push
  }

  async function pickModel(input?: { providerID?: string; modelID?: string }) {
    if (input?.providerID && input.modelID) {
      return Provider.getModel(input.providerID, input.modelID)
        .then((item) => ({
          source: "session" as const,
          model: item,
        }))
        .catch(() => {
        fail("The selected session model is not available")
      })
    }
    const picked = await Provider.defaultModel().catch(() => undefined)
    if (!picked) fail("No default model is configured")
    return Provider.getModel(picked.providerID, picked.modelID)
      .then((item) => ({
        source: "default" as const,
        model: item,
      }))
      .catch(() => {
        fail("The configured default model is not available")
      })
  }

  async function diffs(include: boolean) {
    const diff = await patch(include)
    if (!diff.trim()) fail("No diff is available to generate a commit message")
    return diff
  }

  export async function generate(input: Generate) {
    ensure()
    const [{ model, source }, diff] = await Promise.all([pickModel(input), diffs(input.include_unstaged)])
    const recent = await run(["log", "--format=%s", "-5"]).catch(() => "")
    const agent = await Agent.get("build")
    if (!agent) fail("The build agent is not available")
    const user: MessageV2.User = {
      id: Identifier.ascending("message"),
      sessionID: input.sessionID ?? Identifier.ascending("session"),
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: agent.name,
      model: {
        providerID: model.providerID,
        modelID: model.id,
      },
    }
    log.info("generate commit message", {
      source,
      providerID: model.providerID,
      modelID: model.id,
      sessionID: user.sessionID,
      include_unstaged: input.include_unstaged,
    })
    const result = await LLM.stream({
      agent: {
        ...agent,
        temperature: 0.2,
      },
      user,
      system: [
        "Write a concise git commit message.",
        "Return exactly one subject line.",
        "Do not include surrounding quotes or markdown.",
        recent
          ? `Match the style of these recent commit subjects when reasonable:\n${recent}`
          : "Use a short imperative style.",
      ],
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: user.sessionID,
      retries: 0,
      messages: [
        {
          role: "user",
          content: `Diff to summarize:\n\n${diff}`,
        },
      ],
    }).catch((err) => {
      log.error("generate commit message failed", {
        source,
        providerID: model.providerID,
        modelID: model.id,
        sessionID: user.sessionID,
        error: err,
      })
      throw err
    })
    const body = await result.text.catch((err) => {
      log.error("generate commit message failed", {
        source,
        providerID: model.providerID,
        modelID: model.id,
        sessionID: user.sessionID,
        error: err,
      })
      throw err
    })
    const message =
      body
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean)
        ?.replace(/^"+|"+$/g, "") ?? ""
    if (!message) fail("The model returned an empty commit message")
    return {
      message,
    } satisfies Message
  }
}
