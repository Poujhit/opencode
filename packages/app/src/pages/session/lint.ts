import { selectionFromLines, type FileSelection, type LspDiagnostic, type SelectedLineRange } from "@/context/file/types"
import type { Prompt } from "@/context/prompt"

type PromptState = {
  set: (prompt: Prompt, cursorPosition?: number) => void
  context: {
    add: (item: {
      type: "file"
      path: string
      selection?: FileSelection
      preview?: string
    }) => void
  }
}

function label(input?: number) {
  if (input === 1) return "Error"
  if (input === 2) return "Warning"
  if (input === 3) return "Info"
  return "Hint"
}

function line(input: SelectedLineRange) {
  const start = Math.min(input.start, input.end)
  const end = Math.max(input.start, input.end)
  if (start === end) return `${start}`
  return `${start}-${end}`
}

export function where(input: { file: string; lines: SelectedLineRange }) {
  return `${input.file}:${line(input.lines)}`
}

export function format(input: { file: string; item: LspDiagnostic; lines: SelectedLineRange }) {
  const meta = [input.item.source, input.item.code]
    .flatMap((item) => {
      if (item === undefined || item === "") return []
      return [String(item)]
    })
    .join(":")
  const head = `${label(input.item.severity)}: ${where(input)}`
  if (!meta) return `${head}\n${input.item.message}`
  return `${head} [${meta}]\n${input.item.message}`
}

export function write(input: {
  prompt: PromptState
  file: string
  text: string
  lines: SelectedLineRange
  preview?: string
}) {
  const content = input.text
  input.prompt.set([{ type: "text", content, start: 0, end: content.length }], content.length)
  input.prompt.context.add({
    type: "file",
    path: input.file,
    selection: selectionFromLines(input.lines),
    ...(input.preview ? { preview: input.preview } : {}),
  })
  return content.length
}
