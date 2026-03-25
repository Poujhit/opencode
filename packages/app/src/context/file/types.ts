import type { FileContent } from "@opencode-ai/sdk/v2"

export type FileSelection = {
  startLine: number
  startChar: number
  endLine: number
  endChar: number
}

export type SelectedLineRange = {
  start: number
  end: number
  side?: "additions" | "deletions"
  endSide?: "additions" | "deletions"
}

export type FileViewState = {
  scrollTop?: number
  scrollLeft?: number
  selectedLines?: SelectedLineRange | null
}

export type LspDiagnostic = {
  range: {
    start: {
      line: number
      character: number
    }
    end: {
      line: number
      character: number
    }
  }
  severity?: number
  code?: string | number
  source?: string
  message: string
}

export type LspLocation = {
  path: string
  range: LspDiagnostic["range"]
}

export type FileState = {
  path: string
  name: string
  loaded?: boolean
  loading?: boolean
  error?: string
  content?: FileContent
  diagnostics?: LspDiagnostic[]
}

export function selectionFromLines(range: SelectedLineRange): FileSelection {
  const startLine = Math.min(range.start, range.end)
  const endLine = Math.max(range.start, range.end)
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}
