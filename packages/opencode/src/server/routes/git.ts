import { type Context, Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Git } from "../../git"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"

const log = Log.create({ service: "server.git" })
const fail = (c: Context, err: unknown) => {
  const status = err instanceof Git.Error ? err.status : 500
  const message = err instanceof globalThis.Error ? err.message : String(err)
  log.error("request failed", {
    path: c.req.path,
    status,
    message,
    error: err,
  })
  return c.json({ error: message }, { status: status as ContentfulStatusCode })
}

export const GitRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Get git status",
        description: "Get branch, diff, and push information for the current workspace.",
        operationId: "git.status",
        responses: {
          200: {
            description: "Git status",
            content: {
              "application/json": {
                schema: resolver(Git.Status),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Git.status())
      },
    )
    .get(
      "/branches",
      describeRoute({
        summary: "List git branches",
        description: "List local branches for the current workspace.",
        operationId: "git.branches",
        responses: {
          200: {
            description: "Git branches",
            content: {
              "application/json": {
                schema: resolver(Git.Branch.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Git.branches())
      },
    )
    .post(
      "/checkout",
      describeRoute({
        summary: "Checkout branch",
        description: "Switch to an existing local branch in the current workspace.",
        operationId: "git.checkout",
        responses: {
          200: {
            description: "Updated git status",
            content: {
              "application/json": {
                schema: resolver(Git.Status),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          branch: z.string(),
        }),
      ),
      async (c) => {
        try {
          return c.json(await Git.checkout(c.req.valid("json").branch))
        } catch (err) {
          return fail(c, err)
        }
      },
    )
    .post(
      "/commit",
      describeRoute({
        summary: "Commit changes",
        description: "Commit staged changes or all workspace changes.",
        operationId: "git.commit",
        responses: {
          200: {
            description: "Commit result",
            content: {
              "application/json": {
                schema: resolver(Git.Commit),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          message: z.string().optional(),
          include_unstaged: z.boolean().default(false),
        }),
      ),
      async (c) => {
        try {
          return c.json(await Git.commit(c.req.valid("json")))
        } catch (err) {
          return fail(c, err)
        }
      },
    )
    .post(
      "/push",
      describeRoute({
        summary: "Push branch",
        description: "Push the current branch to its upstream or origin.",
        operationId: "git.push",
        responses: {
          200: {
            description: "Push result",
            content: {
              "application/json": {
                schema: resolver(Git.Push),
              },
            },
          },
        },
      }),
      async (c) => {
        try {
          return c.json(await Git.push())
        } catch (err) {
          return fail(c, err)
        }
      },
    )
    .post(
      "/commit/generate",
      describeRoute({
        summary: "Generate commit message",
        description: "Generate a commit message from current git diffs.",
        operationId: "git.generate",
        responses: {
          200: {
            description: "Generated commit message",
            content: {
              "application/json": {
                schema: resolver(Git.Message),
              },
            },
          },
        },
      }),
      validator(
        "json",
        Git.Generate,
      ),
      async (c) => {
        try {
          return c.json(await Git.generate(c.req.valid("json")))
        } catch (err) {
          return fail(c, err)
        }
      },
    ),
)
