import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import type { FileSelection, LspDiagnostic } from "@/context/file"
import { format, where, write } from "./lint"

const item = (value?: Partial<LspDiagnostic>) =>
  ({
    range: {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 4 },
    },
    severity: 1,
    message: "bad",
    ...value,
  }) satisfies LspDiagnostic

describe("session lint", () => {
  test("formats a single-line diagnostic", () => {
    expect(format({ file: "src/app.ts", item: item(), lines: { start: 2, end: 2 } })).toBe(
      "Error: src/app.ts:2\nbad",
    )
  })

  test("formats a multi-line diagnostic with source and code", () => {
    expect(
      format({
        file: "src/app.ts",
        item: item({ severity: 2, source: "eslint", code: "no-unused-vars" }),
        lines: { start: 2, end: 4 },
      }),
    ).toBe("Warning: src/app.ts:2-4 [eslint:no-unused-vars]\nbad")
  })

  test("formats a diagnostic with a numeric code", () => {
    expect(
      format({
        file: "src/app.ts",
        item: item({ code: 7027 }),
        lines: { start: 2, end: 2 },
      }),
    ).toBe("Error: src/app.ts:2 [7027]\nbad")
  })

  test("replaces the draft and adds file context", () => {
    let prompt: Prompt = [
      { type: "text", content: "old", start: 0, end: 3 },
      { type: "image", id: "1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
    ]
    let cursor = 0
    const context: Array<{ type: "file"; path: string; selection?: FileSelection; preview?: string }> = [
      { type: "file", path: "src/old.ts" },
    ]
    const text = "Error: src/app.ts:2\nbad"

    const result = write({
      prompt: {
        set: (next, position) => {
          prompt = next
          cursor = position ?? 0
        },
        context: {
          add: (item) => {
            context.push(item)
          },
        },
      },
      file: "src/app.ts",
      text,
      lines: { start: 2, end: 2 },
      preview: "bad line",
    })

    expect(result).toBe(text.length)
    expect(cursor).toBe(text.length)
    expect(prompt).toEqual([{ type: "text", content: text, start: 0, end: text.length }])
    expect(context).toEqual([
      { type: "file", path: "src/old.ts" },
      {
        type: "file",
        path: "src/app.ts",
        selection: {
          startLine: 2,
          startChar: 0,
          endLine: 2,
          endChar: 0,
        },
        preview: "bad line",
      },
    ])
  })

  test("builds a location label", () => {
    expect(where({ file: "src/app.ts", lines: { start: 2, end: 4 } })).toBe("src/app.ts:2-4")
  })
})
