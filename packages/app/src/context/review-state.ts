import { structuredPatch } from "diff"
import type { FileDiff, Message } from "@opencode-ai/sdk/v2/client"

export type HunkState = "pending" | "accepted" | "rejected"

export type ReviewHunk = {
  id: string
  old_start: number
  old_lines: number
  new_start: number
  new_lines: number
  lines: string[]
  state: HunkState
}

export type ReviewFile = {
  file: string
  msg: string
  time: number
  base: string
  next: string
  hunks: ReviewHunk[]
}

export type ReviewMark = {
  id: string
  idx: number
  anchor: number
  add_start?: number
  add_end?: number
  add: string[]
  del: string[]
}

export type ReviewView = {
  text: string
  hunks: ReviewMark[]
}

export function reviewSig(item: Pick<ReviewFile, "msg" | "base" | "next">) {
  return `${item.msg}\n${item.base}\n${item.next}`
}

function key(lines: string[], idx: number, old_start: number, new_start: number) {
  return `${idx}:${old_start}:${new_start}:${lines.join("\n")}`
}

function build(file: string, msg: string, time: number, base: string, next: string) {
  const patch = structuredPatch(file, file, base, next, "base", "next", {
    context: 3,
  })
  if (!patch.hunks.length) return
  return {
    file,
    msg,
    time,
    base,
    next,
    hunks: patch.hunks.map((hunk, idx) => ({
      id: key(hunk.lines, idx, hunk.oldStart, hunk.newStart),
      old_start: hunk.oldStart,
      old_lines: hunk.oldLines,
      new_start: hunk.newStart,
      new_lines: hunk.newLines,
      lines: hunk.lines.slice(),
      state: "pending" as const,
    })),
  } satisfies ReviewFile
}

function push(
  out: ReviewFile[],
  seen: Set<string>,
  file: string,
  msg: string,
  time: number,
  base: string,
  next: string,
) {
  if (seen.has(file)) return
  const item = build(file, msg, time, base, next)
  if (!item) return
  seen.add(file)
  out.push(item)
}

function last(msgs: Message[] | undefined) {
  for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
    const msg = msgs?.[i]
    if (!msg || msg.role !== "user") continue
    return msg
  }
}

export function deriveReview(msgs: Message[] | undefined, diffs?: FileDiff[], id?: string) {
  const out: ReviewFile[] = []
  const seen = new Set<string>()
  for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
    const msg = msgs?.[i]
    if (!msg || msg.role !== "user") continue
    const diffs = msg.summary?.diffs
    if (!diffs?.length) continue
    for (let j = diffs.length - 1; j >= 0; j--) {
      const diff = diffs[j]
      if (!diff) continue
      push(out, seen, diff.file, msg.id, msg.time.created, diff.before, diff.after)
    }
  }
  const tail = last(msgs)
  for (let i = (diffs?.length ?? 0) - 1; i >= 0; i--) {
    const diff = diffs?.[i]
    if (!diff) continue
    push(out, seen, diff.file, tail?.id ?? id ?? "session", tail?.time.created ?? 0, diff.before, diff.after)
  }
  return out.reverse()
}

export function cloneReview(item: ReviewFile): ReviewFile {
  return {
    ...item,
    hunks: item.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.slice(),
    })),
  }
}

export function syncReview(prev: Record<string, ReviewFile>, next: ReviewFile[], dismiss?: Record<string, string>) {
  return next.reduce<Record<string, ReviewFile>>((acc, item) => {
    if (dismiss?.[item.file] === reviewSig(item)) return acc
    const old = prev[item.file]
    if (!old || old.msg !== item.msg || old.base !== item.base || old.next !== item.next) {
      acc[item.file] = item
      return acc
    }
    const map = new Map(old.hunks.map((hunk) => [hunk.id, hunk.state]))
    acc[item.file] = {
      ...item,
      hunks: item.hunks.map((hunk) => ({
        ...hunk,
        state: map.get(hunk.id) ?? "pending",
      })),
    }
    return acc
  }, {})
}

export function pending(item: ReviewFile) {
  return item.hunks.filter((hunk) => hunk.state === "pending").length
}

export function unresolved(item: ReviewFile) {
  return pending(item) > 0
}

export function renderReview(item: ReviewFile): ReviewView {
  const src = item.base.split("\n")
  const out: string[] = []
  const hunks: ReviewMark[] = []
  let line = 1

  for (const [idx, hunk] of item.hunks.entries()) {
    if (line < hunk.old_start) {
      out.push(...src.slice(line - 1, hunk.old_start - 1))
      line = hunk.old_start
    }

    let first: number | undefined
    let add_start: number | undefined
    let add_end: number | undefined
    const add: string[] = []
    const del: string[] = []

    for (const raw of hunk.lines) {
      const kind = raw[0]
      if (kind === "\\") continue
      const text = raw.slice(1)

      if (kind === " ") {
        out.push(text)
        line++
        continue
      }

      if (kind === "-") {
        first ??= out.length + 1
        if (hunk.state === "rejected") out.push(text)
        else del.push(text)
        line++
        continue
      }

      if (kind === "+") {
        first ??= out.length + 1
        if (hunk.state === "rejected") continue
        add_start ??= out.length + 1
        add.push(text)
        out.push(text)
        add_end = out.length
      }
    }

    if (hunk.state !== "pending") continue

    hunks.push({
      id: hunk.id,
      idx,
      anchor: first ?? Math.max(1, out.length),
      ...(add_start ? { add_start, add_end } : {}),
      add,
      del,
    })
  }

  if (line <= src.length) out.push(...src.slice(line - 1))

  return {
    text: out.join("\n"),
    hunks,
  }
}
