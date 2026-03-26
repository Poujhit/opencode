import { describe, expect, test } from "bun:test"
import { EditorState } from "@codemirror/state"
import type { LspDiagnostic } from "@/context/file"
import { lintDiagnostic } from "./editable-file-lint"

const item = (severity?: number) =>
  ({
    range: {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 4 },
    },
    severity,
    message: "bad",
  }) satisfies LspDiagnostic

describe("lintDiagnostic", () => {
  test("adds copy and chat actions for errors and warnings", () => {
    const doc = EditorState.create({ doc: "zero\nwarn\nlast" }).doc
    const seen: Array<{ kind: string; start: number; end: number }> = []
    const note = lintDiagnostic(doc, item(1), {
      label: { copy: "Copy", chat: "Add to chat" },
      copy: (input) => seen.push({ kind: "copy", start: input.lines.start, end: input.lines.end }),
      chat: (input) => seen.push({ kind: "chat", start: input.lines.start, end: input.lines.end }),
    })

    expect(note.actions?.map((item) => item.name)).toEqual(["Copy", "Add to chat"])
    const view = { state: { doc } }
    note.actions?.[0]?.apply(view as never, note.from, note.to)
    note.actions?.[1]?.apply(view as never, note.from, note.to)
    expect(seen).toEqual([
      { kind: "copy", start: 2, end: 2 },
      { kind: "chat", start: 2, end: 2 },
    ])
  })

  test("skips actions for info and hint diagnostics", () => {
    const doc = EditorState.create({ doc: "zero\ninfo\nlast" }).doc

    expect(
      lintDiagnostic(doc, item(3), {
        label: { copy: "Copy", chat: "Add to chat" },
        copy: () => undefined,
        chat: () => undefined,
      }).actions,
    ).toBeUndefined()

    expect(
      lintDiagnostic(doc, item(), {
        label: { copy: "Copy", chat: "Add to chat" },
        copy: () => undefined,
        chat: () => undefined,
      }).actions,
    ).toBeUndefined()
  })
})
