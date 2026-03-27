import type { EditorState } from "@codemirror/state"
import type { Diagnostic as LintDiagnostic } from "@codemirror/lint"
import type { EditorView } from "@codemirror/view"
import type { LspDiagnostic, SelectedLineRange } from "@/context/file"

export type LintAction = {
  item: LspDiagnostic
  lines: SelectedLineRange
}

export type LintActions = {
  copy?: (input: LintAction) => void
  chat?: (input: LintAction) => void
  label: {
    copy: string
    chat: string
  }
}

function at(doc: EditorState["doc"], line: number, character: number) {
  if (doc.lines === 0) return 0
  const row = doc.line(Math.min(Math.max(1, line + 1), doc.lines))
  return Math.min(row.to, row.from + Math.max(0, character))
}

function lines(doc: EditorState["doc"], from: number, to: number): SelectedLineRange {
  const start = doc.lineAt(from).number
  const end = doc.lineAt(Math.max(from, to > from ? to - 1 : to)).number
  return { start, end }
}

export function lintSeverity(input?: number): LintDiagnostic["severity"] {
  if (input === 1) return "error"
  if (input === 2) return "warning"
  if (input === 3) return "info"
  return "hint"
}

export function lintDiagnostic(doc: EditorState["doc"], item: LspDiagnostic, input?: LintActions): LintDiagnostic {
  const from = at(doc, item.range.start.line, item.range.start.character)
  const raw = at(doc, item.range.end.line, item.range.end.character)
  const to = raw > from ? raw : Math.min(doc.length, from + 1)
  const severity = lintSeverity(item.severity)
  const note: LintDiagnostic = {
    from,
    to,
    severity,
    source: item.source,
    message: item.message,
  }

  if (!input) return note

  // if ((severity !== "error" && severity !== "warning") || !input) return note

  const actions = [
    input.copy
      ? [
          {
            name: input.label.copy,
            apply: (view: EditorView, from: number, to: number) => {
              input.copy?.({
                item,
                lines: lines(view.state.doc, from, to),
              })
            },
          },
        ]
      : [],
    input.chat
      ? [
          {
            name: input.label.chat,
            apply: (view: EditorView, from: number, to: number) => {
              input.chat?.({
                item,
                lines: lines(view.state.doc, from, to),
              })
            },
          },
        ]
      : [],
  ].flat()

  if (actions.length === 0) return note
  return { ...note, actions }
}
