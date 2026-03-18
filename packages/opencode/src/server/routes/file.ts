import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { File } from "../../file"
import { FileWatcher } from "../../file/watcher"
import { LSP } from "../../lsp"
import { lazy } from "../../util/lazy"
import { Bus } from "../../bus"
import { Log } from "../../util/log"

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
                schema: resolver(File.SearchResult),
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
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const result = await File.find({
          pattern: query.pattern,
          limit: query.limit,
        })
        return c.json(result)
      },
    )
    .post(
      "/find/replace/preview",
      describeRoute({
        summary: "Preview replace",
        description: "Preview plain-text replacements across files in the project.",
        operationId: "find.replacePreview",
        responses: {
          200: {
            description: "Preview",
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
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await File.preview(body)
        return c.json(result)
      },
    )
    .post(
      "/find/replace/apply",
      describeRoute({
        summary: "Apply replace",
        description: "Apply plain-text replacements across files in the project.",
        operationId: "find.replaceApply",
        responses: {
          200: {
            description: "Apply result",
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
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await File.replace(body)
        for (const file of result.files) {
          await Bus.publish(File.Event.Edited, { file })
          await Bus.publish(FileWatcher.Event.Updated, { file, event: "change" })
        }
        return c.json(result)
      },
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
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit
        const results = await File.search({
          query,
          limit: limit ?? 10,
          dirs: dirs !== "false",
          type,
        })
        return c.json(results)
      },
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
                schema: resolver(LSP.Symbol.array()),
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
        /*
      const query = c.req.valid("query").query
      const result = await LSP.workspaceSymbol(query)
      return c.json(result)
      */
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
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.list(path)
        return c.json(content)
      },
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
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.read(path)
        return c.json(content)
      },
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
      async (c) => {
        const content = await File.status()
        return c.json(content)
      },
    )
    .post(
      "/file/content",
      describeRoute({
        summary: "Write file",
        description: "Write content to a specified file.",
        operationId: "file.write",
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          content: z.string(),
        }),
      ),
      async (c) => {
        const log = Log.create({ service: "file.write" })
        try {
          const body = c.req.valid("json")
          log.info("write request", { path: body.path, contentLength: body.content.length })
          await File.write(body.path, body.content)
          await Bus.publish(File.Event.Edited, { file: body.path })
          await Bus.publish(FileWatcher.Event.Updated, { file: body.path, event: "change" })
          log.info("write success", { path: body.path })
          return c.json({ ok: true })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          log.error("write failed", { error: message, stack: e instanceof Error ? e.stack : undefined })
          return c.json({ error: message }, 500)
        }
      },
    ),
)
