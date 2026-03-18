import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import fs from "fs"
import ignore from "ignore"
import { Log } from "../util/log"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Ripgrep } from "./ripgrep"
import fuzzysort from "fuzzysort"
import { Global } from "../global"
import { git } from "@/util/git"
import { Protected } from "./protected"
import { InstanceContext } from "@/effect/instance-context"
import { Effect, Layer, ServiceMap } from "effect"
import { runPromiseInstance } from "@/effect/runtime"

const log = Log.create({ service: "file" })

const binaryExtensions = new Set([
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
  "cmd",
  "ps1",
  "sh",
  "bash",
  "zsh",
  "fish",
])

const imageExtensions = new Set([
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

const textExtensions = new Set([
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

const textNames = new Set([
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

function isImageByExtension(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  return imageExtensions.has(ext)
}

function isTextByExtension(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  return textExtensions.has(ext)
}

function isTextByName(filepath: string): boolean {
  const name = path.basename(filepath).toLowerCase()
  return textNames.has(name)
}

function getImageMimeType(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  const mimeTypes: Record<string, string> = {
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
  return mimeTypes[ext] || "image/" + ext
}

function isBinaryByExtension(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase().slice(1)
  return binaryExtensions.has(ext)
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/")
}

function shouldEncode(mimeType: string): boolean {
  const type = mimeType.toLowerCase()
  log.info("shouldEncode", { type })
  if (!type) return false

  if (type.startsWith("text/")) return false
  if (type.includes("charset=")) return false

  const parts = type.split("/", 2)
  const top = parts[0]

  const tops = ["image", "audio", "video", "font", "model", "multipart"]
  if (tops.includes(top)) return true

  return false
}

export namespace File {
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

  const binaryExtensions = new Set([
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
    "cmd",
    "ps1",
    "sh",
    "bash",
    "zsh",
    "fish",
  ])

  const imageExtensions = new Set([
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

  const textExtensions = new Set([
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

  const textNames = new Set([
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

  function isImageByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return imageExtensions.has(ext)
  }

  function isTextByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return textExtensions.has(ext)
  }

  function isTextByName(filepath: string): boolean {
    const name = path.basename(filepath).toLowerCase()
    return textNames.has(name)
  }

  function getImageMimeType(filepath: string): string {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    const mimeTypes: Record<string, string> = {
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
    return mimeTypes[ext] || "image/" + ext
  }

  function isBinaryByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return binaryExtensions.has(ext)
  }

  function isImage(mimeType: string): boolean {
    return mimeType.startsWith("image/")
  }

  async function shouldEncode(mimeType: string): Promise<boolean> {
    const type = mimeType.toLowerCase()
    log.info("shouldEncode", { type })
    if (!type) return false

    if (type.startsWith("text/")) return false
    if (type.includes("charset=")) return false

    const parts = type.split("/", 2)
    const top = parts[0]

    const tops = ["image", "audio", "video", "font", "model", "multipart"]
    if (tops.includes(top)) return true

    return false
  }

  function guardQuery(query: string) {
    const value = query.trim()
    if (!value) throw new Error("Search query is required")
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error("Multiline search is not supported")
    }
    return value
  }

  function guardReplace(value: string) {
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error("Multiline replace is not supported")
    }
    return value
  }

  function group(items: Ripgrep.Match["data"][]): SearchResult {
    const map = new Map<string, SearchItem[]>()
    let total = 0

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
      total += item.submatches.length
    }

    const files = [...map.entries()].map(([path, matches]) => ({
      path,
      matches,
    }))

    return {
      files,
      total_files: files.length,
      total_matches: total,
    }
  }

  function line(text: string, ranges: SearchRange[], next: string) {
    if (ranges.length === 0) return text

    let out = ""
    let last = 0
    for (const item of ranges) {
      out += text.slice(last, item.start)
      out += next
      last = item.end
    }
    out += text.slice(last)
    return out
  }

  function replaceAll(text: string, search: string, next: string) {
    const parts = text.split(search)
    if (parts.length === 1) return
    return {
      text: parts.join(next),
      count: parts.length - 1,
    }
  }

  export const Event = {
    Edited: BusEvent.define(
      "file.edited",
      z.object({
        file: z.string(),
      }),
    ),
  }

  export function init() {
    return runPromiseInstance(FileService.use((s) => s.init()))
  }

  export async function status() {
    return runPromiseInstance(FileService.use((s) => s.status()))
  }

  export async function read(file: string): Promise<Content> {
    return runPromiseInstance(FileService.use((s) => s.read(file)))
  }

  export async function write(file: string, content: string): Promise<void> {
    using _ = log.time("write", { file })
    const full = path.join(Instance.directory, file)

    if (!Instance.containsPath(full)) {
      throw new Error(`Access denied: path escapes project directory`)
    }

    await Filesystem.write(full, content)
  }

  export async function list(dir?: string) {
    return runPromiseInstance(FileService.use((s) => s.list(dir)))
  }

  export async function find(input: { pattern: string; limit?: number }) {
    const pattern = guardQuery(input.pattern)
    const hits = await Ripgrep.search({
      cwd: Instance.directory,
      pattern,
      limit: input.limit,
      literal: true,
    })
    return group(hits)
  }

  export async function preview(input: { search: string; replace: string; paths?: string[] }) {
    const search = guardQuery(input.search)
    const next = guardReplace(input.replace)
    const allow = input.paths?.length ? new Set(input.paths.map((item) => item.replaceAll("\\", "/"))) : undefined
    const hits = await Ripgrep.search({
      cwd: Instance.directory,
      pattern: search,
      literal: true,
    })

    const map = new Map<string, ReplaceItem[]>()
    let total = 0

    for (const item of hits) {
      const path = item.path.text.replaceAll("\\", "/")
      if (allow && !allow.has(path)) continue

      const list = map.get(path) ?? []
      const text = item.lines.text.replace(/\r?\n$/, "")
      const ranges = item.submatches.map((match) => ({
        start: match.start,
        end: match.end,
      }))
      list.push({
        line: item.line_number,
        text,
        next: line(text, ranges, next),
        ranges,
      })
      map.set(path, list)
      total += item.submatches.length
    }

    const files = [...map.entries()].map(([path, matches]) => ({
      path,
      replacements: matches.reduce((sum, item) => sum + item.ranges.length, 0),
      matches,
    }))

    return {
      files,
      total_files: files.length,
      total_matches: total,
    }
  }

  export async function replace(input: { search: string; replace: string; paths?: string[] }) {
    const search = guardQuery(input.search)
    const next = guardReplace(input.replace)
    const paths = input.paths?.length
      ? input.paths.map((item) => item.replaceAll("\\", "/"))
      : (await preview({ search, replace: next })).files.map((item) => item.path)

    const files: string[] = []
    let replacements = 0

    for (const file of paths) {
      const full = path.join(Instance.directory, file)
      if (!Instance.containsPath(full)) continue
      if (!(await Filesystem.exists(full))) continue
      if (isBinaryByExtension(file) && !isTextByExtension(file) && !isTextByName(file)) continue

      const text = await Filesystem.readText(full).catch(() => undefined)
      if (text === undefined) continue

      const out = replaceAll(text, search, next)
      if (!out || out.count === 0) continue

      await Filesystem.write(full, out.text)
      files.push(file)
      replacements += out.count
    }

    return {
      files,
      replacements,
    }
  }

  export async function search(input: { query: string; limit?: number; dirs?: boolean; type?: "file" | "directory" }) {
    return runPromiseInstance(FileService.use((s) => s.search(input)))
  }
}

export namespace FileService {
  export interface Service {
    readonly init: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<File.Info[]>
    readonly read: (file: string) => Effect.Effect<File.Content>
    readonly list: (dir?: string) => Effect.Effect<File.Node[]>
    readonly search: (input: {
      query: string
      limit?: number
      dirs?: boolean
      type?: "file" | "directory"
    }) => Effect.Effect<string[]>
  }
}

export class FileService extends ServiceMap.Service<FileService, FileService.Service>()("@opencode/File") {
  static readonly layer = Layer.effect(
    FileService,
    Effect.gen(function* () {
      const instance = yield* InstanceContext

      // File cache state
      type Entry = { files: string[]; dirs: string[] }
      let cache: Entry = { files: [], dirs: [] }
      let task: Promise<void> | undefined

      const isGlobalHome = instance.directory === Global.Path.home && instance.project.id === "global"

      function kick() {
        if (task) return task
        task = (async () => {
          // Disable scanning if in root of file system
          if (instance.directory === path.parse(instance.directory).root) return
          const next: Entry = { files: [], dirs: [] }
          try {
            if (isGlobalHome) {
              const dirs = new Set<string>()
              const protectedNames = Protected.names()

              const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
              const shouldIgnoreName = (name: string) => name.startsWith(".") || protectedNames.has(name)
              const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)

              const top = await fs.promises
                .readdir(instance.directory, { withFileTypes: true })
                .catch(() => [] as fs.Dirent[])

              for (const entry of top) {
                if (!entry.isDirectory()) continue
                if (shouldIgnoreName(entry.name)) continue
                dirs.add(entry.name + "/")

                const base = path.join(instance.directory, entry.name)
                const children = await fs.promises.readdir(base, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
                for (const child of children) {
                  if (!child.isDirectory()) continue
                  if (shouldIgnoreNested(child.name)) continue
                  dirs.add(entry.name + "/" + child.name + "/")
                }
              }

              next.dirs = Array.from(dirs).toSorted()
            } else {
              const set = new Set<string>()
              for await (const file of Ripgrep.files({ cwd: instance.directory })) {
                next.files.push(file)
                let current = file
                while (true) {
                  const dir = path.dirname(current)
                  if (dir === ".") break
                  if (dir === current) break
                  current = dir
                  if (set.has(dir)) continue
                  set.add(dir)
                  next.dirs.push(dir + "/")
                }
              }
            }
            cache = next
          } finally {
            task = undefined
          }
        })()
        return task
      }

      const getFiles = async () => {
        void kick()
        return cache
      }

      const init = Effect.fn("FileService.init")(function* () {
        yield* Effect.promise(() => kick())
      })

      const status = Effect.fn("FileService.status")(function* () {
        if (instance.project.vcs !== "git") return []

        return yield* Effect.promise(async () => {
          const diffOutput = (
            await git(["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "diff", "--numstat", "HEAD"], {
              cwd: instance.directory,
            })
          ).text()

          const changedFiles: File.Info[] = []

          if (diffOutput.trim()) {
            const lines = diffOutput.trim().split("\n")
            for (const line of lines) {
              const [added, removed, filepath] = line.split("\t")
              changedFiles.push({
                path: filepath,
                added: added === "-" ? 0 : parseInt(added, 10),
                removed: removed === "-" ? 0 : parseInt(removed, 10),
                status: "modified",
              })
            }
          }

          const untrackedOutput = (
            await git(
              [
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.quotepath=false",
                "ls-files",
                "--others",
                "--exclude-standard",
              ],
              {
                cwd: instance.directory,
              },
            )
          ).text()

          if (untrackedOutput.trim()) {
            const untrackedFiles = untrackedOutput.trim().split("\n")
            for (const filepath of untrackedFiles) {
              try {
                const content = await Filesystem.readText(path.join(instance.directory, filepath))
                const lines = content.split("\n").length
                changedFiles.push({
                  path: filepath,
                  added: lines,
                  removed: 0,
                  status: "added",
                })
              } catch {
                continue
              }
            }
          }

          // Get deleted files
          const deletedOutput = (
            await git(
              [
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.quotepath=false",
                "diff",
                "--name-only",
                "--diff-filter=D",
                "HEAD",
              ],
              {
                cwd: instance.directory,
              },
            )
          ).text()

          if (deletedOutput.trim()) {
            const deletedFiles = deletedOutput.trim().split("\n")
            for (const filepath of deletedFiles) {
              changedFiles.push({
                path: filepath,
                added: 0,
                removed: 0, // Could get original line count but would require another git command
                status: "deleted",
              })
            }
          }

          return changedFiles.map((x) => {
            const full = path.isAbsolute(x.path) ? x.path : path.join(instance.directory, x.path)
            return {
              ...x,
              path: path.relative(instance.directory, full),
            }
          })
        })
      })

      const read = Effect.fn("FileService.read")(function* (file: string) {
        return yield* Effect.promise(async (): Promise<File.Content> => {
          using _ = log.time("read", { file })
          const full = path.join(instance.directory, file)

          if (!Instance.containsPath(full)) {
            throw new Error(`Access denied: path escapes project directory`)
          }

          // Fast path: check extension before any filesystem operations
          if (isImageByExtension(file)) {
            if (await Filesystem.exists(full)) {
              const buffer = await Filesystem.readBytes(full).catch(() => Buffer.from([]))
              const content = buffer.toString("base64")
              const mimeType = getImageMimeType(file)
              return { type: "text", content, mimeType, encoding: "base64" }
            }
            return { type: "text", content: "" }
          }

          const text = isTextByExtension(file) || isTextByName(file)

          if (isBinaryByExtension(file) && !text) {
            return { type: "binary", content: "" }
          }

          if (!(await Filesystem.exists(full))) {
            return { type: "text", content: "" }
          }

          const mimeType = Filesystem.mimeType(full)
          const encode = text ? false : shouldEncode(mimeType)

          if (encode && !isImage(mimeType)) {
            return { type: "binary", content: "", mimeType }
          }

          if (encode) {
            const buffer = await Filesystem.readBytes(full).catch(() => Buffer.from([]))
            const content = buffer.toString("base64")
            return { type: "text", content, mimeType, encoding: "base64" }
          }

          const content = (await Filesystem.readText(full).catch(() => "")).trim()

          if (instance.project.vcs === "git") {
            let diff = (
              await git(["-c", "core.fsmonitor=false", "diff", "--", file], { cwd: instance.directory })
            ).text()
            if (!diff.trim()) {
              diff = (
                await git(["-c", "core.fsmonitor=false", "diff", "--staged", "--", file], { cwd: instance.directory })
              ).text()
            }
            if (diff.trim()) {
              const original = (await git(["show", `HEAD:${file}`], { cwd: instance.directory })).text()
              const patch = structuredPatch(file, file, original, content, "old", "new", {
                context: Infinity,
                ignoreWhitespace: true,
              })
              const diff = formatPatch(patch)
              return { type: "text", content, patch, diff }
            }
          }
          return { type: "text", content }
        })
      })

      const list = Effect.fn("FileService.list")(function* (dir?: string) {
        return yield* Effect.promise(async () => {
          const exclude = [".git", ".DS_Store"]
          let ignored = (_: string) => false
          if (instance.project.vcs === "git") {
            const ig = ignore()
            const gitignorePath = path.join(instance.project.worktree, ".gitignore")
            if (await Filesystem.exists(gitignorePath)) {
              ig.add(await Filesystem.readText(gitignorePath))
            }
            const ignorePath = path.join(instance.project.worktree, ".ignore")
            if (await Filesystem.exists(ignorePath)) {
              ig.add(await Filesystem.readText(ignorePath))
            }
            ignored = ig.ignores.bind(ig)
          }
          const resolved = dir ? path.join(instance.directory, dir) : instance.directory

          if (!Instance.containsPath(resolved)) {
            throw new Error(`Access denied: path escapes project directory`)
          }

          const nodes: File.Node[] = []
          for (const entry of await fs.promises
            .readdir(resolved, {
              withFileTypes: true,
            })
            .catch(() => [])) {
            if (exclude.includes(entry.name)) continue
            const fullPath = path.join(resolved, entry.name)
            const relativePath = path.relative(instance.directory, fullPath)
            const type = entry.isDirectory() ? "directory" : "file"
            nodes.push({
              name: entry.name,
              path: relativePath,
              absolute: fullPath,
              type,
              ignored: ignored(type === "directory" ? relativePath + "/" : relativePath),
            })
          }
          return nodes.sort((a, b) => {
            if (a.type !== b.type) {
              return a.type === "directory" ? -1 : 1
            }
            return a.name.localeCompare(b.name)
          })
        })
      })

      const search = Effect.fn("FileService.search")(function* (input: {
        query: string
        limit?: number
        dirs?: boolean
        type?: "file" | "directory"
      }) {
        return yield* Effect.promise(async () => {
          const query = input.query.trim()
          const limit = input.limit ?? 100
          const kind = input.type ?? (input.dirs === false ? "file" : "all")
          log.info("search", { query, kind })

          const result = await getFiles()

          const hidden = (item: string) => {
            const normalized = item.replaceAll("\\", "/").replace(/\/+$/, "")
            return normalized.split("/").some((p) => p.startsWith(".") && p.length > 1)
          }
          const preferHidden = query.startsWith(".") || query.includes("/.")
          const sortHiddenLast = (items: string[]) => {
            if (preferHidden) return items
            const visible: string[] = []
            const hiddenItems: string[] = []
            for (const item of items) {
              const isHidden = hidden(item)
              if (isHidden) hiddenItems.push(item)
              if (!isHidden) visible.push(item)
            }
            return [...visible, ...hiddenItems]
          }
          if (!query) {
            if (kind === "file") return result.files.slice(0, limit)
            return sortHiddenLast(result.dirs.toSorted()).slice(0, limit)
          }

          const items =
            kind === "file" ? result.files : kind === "directory" ? result.dirs : [...result.files, ...result.dirs]

          const searchLimit = kind === "directory" && !preferHidden ? limit * 20 : limit
          const sorted = fuzzysort.go(query, items, { limit: searchLimit }).map((r) => r.target)
          const output = kind === "directory" ? sortHiddenLast(sorted).slice(0, limit) : sorted

          log.info("search", { query, kind, results: output.length })
          return output
        })
      })

      log.info("init")

      return FileService.of({ init, status, read, list, search })
    }),
  )
}
