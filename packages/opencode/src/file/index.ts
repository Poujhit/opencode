import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"

import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Git } from "@/git"
import { Effect, Layer, Context, Schema, Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Stream from "effect/Stream"
import { formatPatch, structuredPatch } from "diff"
import fuzzysort from "fuzzysort"
import ignore from "ignore"
import path from "path"
import z from "zod"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Log } from "../util"
import { Protected } from "./protected"
import { Ripgrep } from "./ripgrep"

export const Info = z
  .object({
    path: z.string(),
    added: z.number().int(),
    removed: z.number().int(),
    status: z.enum(["added", "deleted", "modified"]),
  })
  .meta({
    ref: "File",
  })

export type Info = z.infer<typeof Info>

export const Node = z
  .object({
    name: z.string(),
    path: z.string(),
    absolute: z.string(),
    type: z.enum(["file", "directory"]),
    ignored: z.boolean(),
  })
  .meta({
    ref: "FileNode",
  })
export type Node = z.infer<typeof Node>

export const Content = z
  .object({
    type: z.enum(["text", "binary"]),
    content: z.string(),
    diff: z.string().optional(),
    patch: z
      .object({
        oldFileName: z.string(),
        newFileName: z.string(),
        oldHeader: z.string().optional(),
        newHeader: z.string().optional(),
        hunks: z.array(
          z.object({
            oldStart: z.number(),
            oldLines: z.number(),
            newStart: z.number(),
            newLines: z.number(),
            lines: z.array(z.string()),
          }),
        ),
        index: z.string().optional(),
      })
      .optional(),
    encoding: z.literal("base64").optional(),
    mimeType: z.string().optional(),
  })
  .meta({
    ref: "FileContent",
  })
export type Content = z.infer<typeof Content>

export const SearchRange = z
  .object({
    start: z.number().int(),
    end: z.number().int(),
  })
  .meta({
    ref: "FileSearchRange",
  })
export type SearchRange = z.infer<typeof SearchRange>

export const SearchItem = z
  .object({
    line: z.number().int(),
    text: z.string(),
    ranges: SearchRange.array(),
  })
  .meta({
    ref: "FileSearchItem",
  })
export type SearchItem = z.infer<typeof SearchItem>

export const SearchFile = z
  .object({
    path: z.string(),
    matches: SearchItem.array(),
  })
  .meta({
    ref: "FileSearchFile",
  })
export type SearchFile = z.infer<typeof SearchFile>

export const SearchResult = z
  .object({
    files: SearchFile.array(),
    total_files: z.number().int(),
    total_matches: z.number().int(),
  })
  .meta({
    ref: "FileSearchResult",
  })
export type SearchResult = z.infer<typeof SearchResult>

export const ReplaceItem = z
  .object({
    line: z.number().int(),
    text: z.string(),
    next: z.string(),
    ranges: SearchRange.array(),
  })
  .meta({
    ref: "FileReplaceItem",
  })
export type ReplaceItem = z.infer<typeof ReplaceItem>

export const ReplaceFile = z
  .object({
    path: z.string(),
    replacements: z.number().int(),
    matches: ReplaceItem.array(),
  })
  .meta({
    ref: "FileReplaceFile",
  })
export type ReplaceFile = z.infer<typeof ReplaceFile>

export const ReplacePreview = z
  .object({
    files: ReplaceFile.array(),
    total_files: z.number().int(),
    total_matches: z.number().int(),
  })
  .meta({
    ref: "FileReplacePreview",
  })
export type ReplacePreview = z.infer<typeof ReplacePreview>

export const ReplaceApply = z
  .object({
    files: z.string().array(),
    replacements: z.number().int(),
  })
  .meta({
    ref: "FileReplaceApply",
  })
export type ReplaceApply = z.infer<typeof ReplaceApply>

export const Event = {
  Edited: BusEvent.define(
    "file.edited",
    Schema.Struct({
      file: Schema.String,
    }),
  ),
}

const log = Log.create({ service: "file" })

const binary = new Set([
  "exe",
  "dll",
  "pdb",
  "bin",
  "so",
  "dylib",
  "o",
  "a",
  "lib",
  "wav",
  "mp3",
  "ogg",
  "oga",
  "ogv",
  "ogx",
  "flac",
  "aac",
  "wma",
  "m4a",
  "weba",
  "mp4",
  "avi",
  "mov",
  "wmv",
  "flv",
  "webm",
  "mkv",
  "zip",
  "tar",
  "gz",
  "gzip",
  "bz",
  "bz2",
  "bzip",
  "bzip2",
  "7z",
  "rar",
  "xz",
  "lz",
  "z",
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "dmg",
  "iso",
  "img",
  "vmdk",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "sqlite",
  "db",
  "mdb",
  "apk",
  "ipa",
  "aab",
  "xapk",
  "app",
  "pkg",
  "deb",
  "rpm",
  "snap",
  "flatpak",
  "appimage",
  "msi",
  "msp",
  "jar",
  "war",
  "ear",
  "class",
  "kotlin_module",
  "dex",
  "vdex",
  "odex",
  "oat",
  "art",
  "wasm",
  "wat",
  "bc",
  "ll",
  "s",
  "ko",
  "sys",
  "drv",
  "efi",
  "rom",
  "com",
])

const image = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "ico",
  "tif",
  "tiff",
  "svg",
  "svgz",
  "avif",
  "apng",
  "jxl",
  "heic",
  "heif",
  "raw",
  "cr2",
  "nef",
  "arw",
  "dng",
  "orf",
  "raf",
  "pef",
  "x3f",
])

const text = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "mtsx",
  "ctsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "cmd",
  "bat",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "md",
  "mdx",
  "txt",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "graphql",
  "gql",
  "sql",
  "ini",
  "cfg",
  "conf",
  "env",
])

const textName = new Set([
  "dockerfile",
  "makefile",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".eslintrc",
])

const mime: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  svgz: "image/svg+xml",
  avif: "image/avif",
  apng: "image/apng",
  jxl: "image/jxl",
  heic: "image/heic",
  heif: "image/heif",
}

type Entry = { files: string[]; dirs: string[] }

const ext = (file: string) => path.extname(file).toLowerCase().slice(1)
const name = (file: string) => path.basename(file).toLowerCase()
const isImageByExtension = (file: string) => image.has(ext(file))
const isTextByExtension = (file: string) => text.has(ext(file))
const isTextByName = (file: string) => textName.has(name(file))
const isBinaryByExtension = (file: string) => binary.has(ext(file))
const isImage = (mimeType: string) => mimeType.startsWith("image/")
const getImageMimeType = (file: string) => mime[ext(file)] || "image/" + ext(file)

function guardQuery(query: string) {
  const value = query.trim()
  if (!value) throw new Error("Search query is required")
  if (value.includes("\n") || value.includes("\r")) throw new Error("Multiline search is not supported")
  return value
}

function guardReplace(value: string) {
  if (value.includes("\n") || value.includes("\r")) throw new Error("Multiline replace is not supported")
  return value
}

function groupSearch(items: Ripgrep.Match["data"][]): SearchResult {
  const map = new Map<string, SearchItem[]>()
  const total = items.reduce((sum, item) => sum + item.submatches.length, 0)

  for (const item of items) {
    const list = map.get(item.path.text) ?? []
    list.push({
      line: item.line_number,
      text: item.lines.text.replace(/\r?\n$/, ""),
      ranges: item.submatches.map((match) => ({
        start: match.start,
        end: match.end,
      })),
    })
    map.set(item.path.text, list)
  }

  const files = [...map.entries()].map(([path, matches]) => ({ path, matches }))
  return {
    files,
    total_files: files.length,
    total_matches: total,
  }
}

function replaceLine(text: string, ranges: SearchRange[], next: string) {
  if (ranges.length === 0) return text
  const out = ranges.reduce(
    (acc, item) => ({
      text: acc.text + text.slice(acc.last, item.start) + next,
      last: item.end,
    }),
    { text: "", last: 0 },
  )
  return out.text + text.slice(out.last)
}

function escapePattern(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function replaceAll(text: string, search: string, next: string, sensitive?: boolean, word?: boolean) {
  const body = escapePattern(search)
  const re = new RegExp(word ? `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])` : body, sensitive ? "g" : "gi")
  let count = 0
  const out = text.replace(re, () => {
    count++
    return next
  })
  if (count === 0) return
  return { text: out, count }
}

function shouldEncode(mimeType: string) {
  const type = mimeType.toLowerCase()
  log.debug("shouldEncode", { type })
  if (!type) return false
  if (type.startsWith("text/")) return false
  if (type.includes("charset=")) return false
  const top = type.split("/", 2)[0]
  return ["image", "audio", "video", "font", "model", "multipart"].includes(top)
}

const hidden = (item: string) => {
  const normalized = item.replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized.split("/").some((part) => part.startsWith(".") && part.length > 1)
}

const sortHiddenLast = (items: string[], prefer: boolean) => {
  if (prefer) return items
  const visible: string[] = []
  const hiddenItems: string[] = []
  for (const item of items) {
    if (hidden(item)) hiddenItems.push(item)
    else visible.push(item)
  }
  return [...visible, ...hiddenItems]
}

interface State {
  cache: Entry
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Info[], PlatformError | Error>
  readonly read: (file: string) => Effect.Effect<Content, PlatformError | Error>
  readonly list: (dir?: string) => Effect.Effect<Node[], PlatformError | Error>
  readonly find: (input: {
    pattern: string
    limit?: number
    sensitive?: boolean
    word?: boolean
  }) => Effect.Effect<SearchResult, PlatformError | Error>
  readonly preview: (input: {
    search: string
    replace: string
    paths?: string[]
    sensitive?: boolean
    word?: boolean
  }) => Effect.Effect<ReplacePreview, PlatformError | Error>
  readonly replace: (input: {
    search: string
    replace: string
    paths?: string[]
    sensitive?: boolean
    word?: boolean
  }) => Effect.Effect<ReplaceApply, PlatformError | Error>
  readonly search: (input: {
    query: string
    limit?: number
    dirs?: boolean
    type?: "file" | "directory"
  }) => Effect.Effect<string[], PlatformError | Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/File") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appFs = yield* AppFileSystem.Service
    const rg = yield* Ripgrep.Service
    const git = yield* Git.Service
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<State>(
      Effect.fn("File.state")(() =>
        Effect.succeed({
          cache: { files: [], dirs: [] } as Entry,
        }),
      ),
    )

    const scan = Effect.fn("File.scan")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.directory === path.parse(ctx.directory).root) return
      const isGlobalHome = ctx.directory === Global.Path.home && ctx.project.id === "global"
      const next: Entry = { files: [], dirs: [] }

      if (isGlobalHome) {
        const dirs = new Set<string>()
        const protectedNames = Protected.names()
        const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
        const shouldIgnoreName = (name: string) => name.startsWith(".") || protectedNames.has(name)
        const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)
        const top = yield* appFs.readDirectoryEntries(ctx.directory).pipe(Effect.orElseSucceed(() => []))

        for (const entry of top) {
          if (entry.type !== "directory") continue
          if (shouldIgnoreName(entry.name)) continue
          dirs.add(entry.name + "/")

          const base = path.join(ctx.directory, entry.name)
          const children = yield* appFs.readDirectoryEntries(base).pipe(Effect.orElseSucceed(() => []))
          for (const child of children) {
            if (child.type !== "directory") continue
            if (shouldIgnoreNested(child.name)) continue
            dirs.add(entry.name + "/" + child.name + "/")
          }
        }

        next.dirs = Array.from(dirs).toSorted()
      } else {
        const files = yield* rg.files({ cwd: ctx.directory }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => [...chunk]),
        )
        const seen = new Set<string>()
        for (const file of files) {
          next.files.push(file)
          let current = file
          while (true) {
            const dir = path.dirname(current)
            if (dir === ".") break
            if (dir === current) break
            current = dir
            if (seen.has(dir)) continue
            seen.add(dir)
            next.dirs.push(dir + "/")
          }
        }
      }

      const s = yield* InstanceState.get(state)
      s.cache = next
    })

    let cachedScan = yield* Effect.cached(scan().pipe(Effect.catchCause(() => Effect.void)))

    const ensure = Effect.fn("File.ensure")(function* () {
      yield* cachedScan
      cachedScan = yield* Effect.cached(scan().pipe(Effect.catchCause(() => Effect.void)))
    })

    const gitText = Effect.fnUntraced(function* (args: string[]) {
      return (yield* git.run(args, { cwd: (yield* InstanceState.context).directory })).text()
    })

    const init = Effect.fn("File.init")(function* () {
      yield* ensure().pipe(Effect.forkIn(scope))
    })

    const status = Effect.fn("File.status")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") return []

      const diffOutput = yield* gitText([
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotepath=false",
        "diff",
        "--numstat",
        "HEAD",
      ])

      const changed: Info[] = []

      if (diffOutput.trim()) {
        for (const line of diffOutput.trim().split("\n")) {
          const [added, removed, file] = line.split("\t")
          changed.push({
            path: file,
            added: added === "-" ? 0 : parseInt(added, 10),
            removed: removed === "-" ? 0 : parseInt(removed, 10),
            status: "modified",
          })
        }
      }

      const untrackedOutput = yield* gitText([
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotepath=false",
        "ls-files",
        "--others",
        "--exclude-standard",
      ])

      if (untrackedOutput.trim()) {
        for (const file of untrackedOutput.trim().split("\n")) {
          const content = yield* appFs
            .readFileString(path.join(ctx.directory, file))
            .pipe(Effect.catch(() => Effect.succeed<string | undefined>(undefined)))
          if (content === undefined) continue
          changed.push({
            path: file,
            added: content.split("\n").length,
            removed: 0,
            status: "added",
          })
        }
      }

      const deletedOutput = yield* gitText([
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.quotepath=false",
        "diff",
        "--name-only",
        "--diff-filter=D",
        "HEAD",
      ])

      if (deletedOutput.trim()) {
        for (const file of deletedOutput.trim().split("\n")) {
          changed.push({
            path: file,
            added: 0,
            removed: 0,
            status: "deleted",
          })
        }
      }

      return changed.map((item) => {
        const full = path.isAbsolute(item.path) ? item.path : path.join(ctx.directory, item.path)
        return {
          ...item,
          path: path.relative(ctx.directory, full),
        }
      })
    })

    const read: Interface["read"] = Effect.fn("File.read")(function* (file: string) {
      using _ = log.time("read", { file })
      const ctx = yield* InstanceState.context
      const full = path.join(ctx.directory, file)

      if (!Instance.containsPath(full, ctx)) {
        throw new Error("Access denied: path escapes project directory")
      }

      if (isImageByExtension(file)) {
        const exists = yield* appFs.existsSafe(full)
        if (exists) {
          const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
          return {
            type: "text" as const,
            content: Buffer.from(bytes).toString("base64"),
            mimeType: getImageMimeType(file),
            encoding: "base64" as const,
          }
        }
        return { type: "text" as const, content: "" }
      }

      const knownText = isTextByExtension(file) || isTextByName(file)

      if (isBinaryByExtension(file) && !knownText) return { type: "binary" as const, content: "" }

      const exists = yield* appFs.existsSafe(full)
      if (!exists) return { type: "text" as const, content: "" }

      const mimeType = AppFileSystem.mimeType(full)
      const encode = knownText ? false : shouldEncode(mimeType)

      if (encode && !isImage(mimeType)) return { type: "binary" as const, content: "", mimeType }

      if (encode) {
        const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
        return {
          type: "text" as const,
          content: Buffer.from(bytes).toString("base64"),
          mimeType,
          encoding: "base64" as const,
        }
      }

      const content = yield* appFs.readFileString(full).pipe(
        Effect.map((s) => s.trim()),
        Effect.catch(() => Effect.succeed("")),
      )

      if (ctx.project.vcs === "git") {
        let diff = yield* gitText(["-c", "core.fsmonitor=false", "diff", "--", file])
        if (!diff.trim()) {
          diff = yield* gitText(["-c", "core.fsmonitor=false", "diff", "--staged", "--", file])
        }
        if (diff.trim()) {
          const original = yield* git.show(ctx.directory, "HEAD", file)
          const patch = structuredPatch(file, file, original, content, "old", "new", {
            context: Infinity,
            ignoreWhitespace: true,
          })
          return { type: "text" as const, content, patch, diff: formatPatch(patch) }
        }
        return { type: "text" as const, content }
      }

      return { type: "text" as const, content }
    })

    const list = Effect.fn("File.list")(function* (dir?: string) {
      const ctx = yield* InstanceState.context
      const exclude = [".git", ".DS_Store"]
      let ignored = (_: string) => false
      if (ctx.project.vcs === "git") {
        const ig = ignore()
        const gitignore = path.join(ctx.worktree, ".gitignore")
        const gitignoreText = yield* appFs.readFileString(gitignore).pipe(Effect.catch(() => Effect.succeed("")))
        if (gitignoreText) ig.add(gitignoreText)
        const ignoreFile = path.join(ctx.worktree, ".ignore")
        const ignoreText = yield* appFs.readFileString(ignoreFile).pipe(Effect.catch(() => Effect.succeed("")))
        if (ignoreText) ig.add(ignoreText)
        ignored = ig.ignores.bind(ig)
      }

      const resolved = dir ? path.join(ctx.directory, dir) : ctx.directory
      if (!Instance.containsPath(resolved, ctx)) {
        throw new Error("Access denied: path escapes project directory")
      }

      const entries = yield* appFs.readDirectoryEntries(resolved).pipe(Effect.orElseSucceed(() => []))

      const nodes: Node[] = []
      for (const entry of entries) {
        if (exclude.includes(entry.name)) continue
        const absolute = path.join(resolved, entry.name)
        const file = path.relative(ctx.directory, absolute)
        const type = entry.type === "directory" ? "directory" : "file"
        nodes.push({
          name: entry.name,
          path: file,
          absolute,
          type,
          ignored: ignored(type === "directory" ? file + "/" : file),
        })
      }
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    })

    const find: Interface["find"] = Effect.fn("File.find")(function* (input) {
      const ctx = yield* InstanceState.context
      const result = yield* rg.search({
        cwd: ctx.directory,
        pattern: guardQuery(input.pattern),
        limit: input.limit,
        literal: true,
        sensitive: input.sensitive,
        word: input.word,
      })
      return groupSearch(result.items)
    })

    const preview: Interface["preview"] = Effect.fn("File.preview")(function* (input) {
      const ctx = yield* InstanceState.context
      const search = guardQuery(input.search)
      const next = guardReplace(input.replace)
      const allow = input.paths?.length ? new Set(input.paths.map((item) => item.replaceAll("\\", "/"))) : undefined
      const result = yield* rg.search({
        cwd: ctx.directory,
        pattern: search,
        literal: true,
        sensitive: input.sensitive,
        word: input.word,
      })
      const map = new Map<string, ReplaceItem[]>()
      const items = result.items.filter((item) => !allow || allow.has(item.path.text.replaceAll("\\", "/")))

      for (const item of items) {
        const file = item.path.text.replaceAll("\\", "/")
        const matches = map.get(file) ?? []
        const text = item.lines.text.replace(/\r?\n$/, "")
        const ranges = item.submatches.map((match) => ({
          start: match.start,
          end: match.end,
        }))
        matches.push({
          line: item.line_number,
          text,
          next: replaceLine(text, ranges, next),
          ranges,
        })
        map.set(file, matches)
      }

      const files = [...map.entries()].map(([path, matches]) => ({
        path,
        replacements: matches.reduce((sum, item) => sum + item.ranges.length, 0),
        matches,
      }))

      return {
        files,
        total_files: files.length,
        total_matches: items.reduce((sum, item) => sum + item.submatches.length, 0),
      }
    })

    const replace: Interface["replace"] = Effect.fn("File.replace")(function* (input) {
      const ctx = yield* InstanceState.context
      const search = guardQuery(input.search)
      const next = guardReplace(input.replace)
      const paths = input.paths?.length
        ? input.paths.map((item) => item.replaceAll("\\", "/"))
        : (yield* preview({ search, replace: next, sensitive: input.sensitive, word: input.word })).files.map(
            (item) => item.path,
          )

      const done = yield* Effect.all(
        paths.map((file) =>
          Effect.gen(function* () {
            const full = path.join(ctx.directory, file)
            if (!Instance.containsPath(full, ctx)) return
            if (isBinaryByExtension(file) && !isTextByExtension(file) && !isTextByName(file)) return
            const text = yield* appFs.readFileString(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (text === undefined) return
            const out = replaceAll(text, search, next, input.sensitive, input.word)
            if (!out) return
            yield* appFs.writeFileString(full, out.text)
            return { file, count: out.count }
          }),
        ),
        { concurrency: "unbounded" },
      )

      const changed = done.filter((item): item is { file: string; count: number } => item !== undefined)
      return {
        files: changed.map((item) => item.file),
        replacements: changed.reduce((sum, item) => sum + item.count, 0),
      }
    })

    const search = Effect.fn("File.search")(function* (input: {
      query: string
      limit?: number
      dirs?: boolean
      type?: "file" | "directory"
    }) {
      yield* ensure()
      const { cache } = yield* InstanceState.get(state)

      const query = input.query.trim()
      const limit = input.limit ?? 100
      const kind = input.type ?? (input.dirs === false ? "file" : "all")
      log.info("search", { query, kind })

      const preferHidden = query.startsWith(".") || query.includes("/.")

      if (!query) {
        if (kind === "file") return cache.files.slice(0, limit)
        return sortHiddenLast(cache.dirs.toSorted(), preferHidden).slice(0, limit)
      }

      const items = kind === "file" ? cache.files : kind === "directory" ? cache.dirs : [...cache.files, ...cache.dirs]

      const searchLimit = kind === "directory" && !preferHidden ? limit * 20 : limit
      const sorted = fuzzysort.go(query, items, { limit: searchLimit }).map((item) => item.target)
      const output = kind === "directory" ? sortHiddenLast(sorted, preferHidden).slice(0, limit) : sorted

      log.info("search", { query, kind, results: output.length })
      return output
    })

    log.info("init")
    return Service.of({ init, status, read, list, find, preview, replace, search })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Ripgrep.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Git.defaultLayer),
)

export async function find(input: { pattern: string; limit?: number; sensitive?: boolean; word?: boolean }) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime.runPromise(Service.use((svc) => svc.find(input)))
}

export async function preview(input: {
  search: string
  replace: string
  paths?: string[]
  sensitive?: boolean
  word?: boolean
}) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime.runPromise(Service.use((svc) => svc.preview(input)))
}

export async function replace(input: {
  search: string
  replace: string
  paths?: string[]
  sensitive?: boolean
  word?: boolean
}) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime.runPromise(Service.use((svc) => svc.replace(input)))
}

export * as File from "."
