import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { File } from "@/file"
import { Ripgrep } from "@/file/ripgrep"
import { LSP } from "@/lsp"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          sensitive: z.enum(["true", "false"]).optional(),
          word: z.enum(["true", "false"]).optional(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.findText", c, function* () {
          const query = c.req.valid("query")
          const svc = yield* File.Service
          return yield* svc.find({
            pattern: query.pattern,
            limit: query.limit,
            sensitive: query.sensitive === "true",
            word: query.word === "true",
          })
        }),
    )
    .post(
      "/find/replace/preview",
      describeRoute({
        summary: "Preview replacement",
        description: "Preview text replacements across files in the project.",
        operationId: "find.replacePreview",
        responses: {
          200: {
            description: "Replacement preview",
            content: {
              "application/json": {
                schema: resolver(File.ReplacePreview),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          search: z.string(),
          replace: z.string(),
          paths: z.string().array().optional(),
          sensitive: z.coerce.boolean().optional(),
          word: z.coerce.boolean().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.replacePreview", c, function* () {
          const svc = yield* File.Service
          return yield* svc.preview(c.req.valid("json"))
        }),
    )
    .post(
      "/find/replace/apply",
      describeRoute({
        summary: "Apply replacement",
        description: "Apply text replacements across files in the project.",
        operationId: "find.replaceApply",
        responses: {
          200: {
            description: "Replacement summary",
            content: {
              "application/json": {
                schema: resolver(File.ReplaceApply),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          search: z.string(),
          replace: z.string(),
          paths: z.string().array().optional(),
          sensitive: z.boolean().optional(),
          word: z.boolean().optional(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.replaceApply", c, function* () {
          const svc = yield* File.Service
          return yield* svc.replace(c.req.valid("json"))
        }),
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.findFile", c, function* () {
          const query = c.req.valid("query")
          const svc = yield* File.Service
          return yield* svc.search({
            query: query.query,
            limit: query.limit ?? 10,
            dirs: query.dirs !== "false",
            type: query.type,
          })
        }),
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.zod.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.list", c, function* () {
          const svc = yield* File.Service
          return yield* svc.list(c.req.valid("query").path)
        }),
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.read", c, function* () {
          const svc = yield* File.Service
          return yield* svc.read(c.req.valid("query").path)
        }),
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("FileRoutes.status", c, function* () {
          const svc = yield* File.Service
          return yield* svc.status()
        }),
    ),
)
