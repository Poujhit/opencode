import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import type { FileSearchHandle } from "@opencode-ai/ui/file"
import { showToast } from "@opencode-ai/ui/toast"
import { useFile, type LspDiagnostic, type LspLocation, type SelectedLineRange } from "@/context/file"
import type { ReviewMark } from "@/context/review-state"
import { lintDiagnostic, type LintActions } from "@/components/editable-file-lint"
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { Compartment, EditorState, StateField } from "@codemirror/state"
import { lintGutter, linter, setDiagnostics } from "@codemirror/lint"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { oneDark } from "@codemirror/theme-one-dark"
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  WidgetType,
} from "@codemirror/view"
import { cpp } from "@codemirror/lang-cpp"
import { css } from "@codemirror/lang-css"
import { go } from "@codemirror/lang-go"
import { html } from "@codemirror/lang-html"
import { java } from "@codemirror/lang-java"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { php } from "@codemirror/lang-php"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { sql } from "@codemirror/lang-sql"
import { xml } from "@codemirror/lang-xml"
import { yaml } from "@codemirror/lang-yaml"

function getLanguageExtension(file: string) {
  const ext = file.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript()
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true })
    case "jsx":
      return javascript({ jsx: true })
    case "tsx":
      return javascript({ jsx: true, typescript: true })
    case "html":
    case "htm":
    case "svelte":
    case "vue":
      return html()
    case "css":
    case "scss":
    case "less":
      return css()
    case "json":
    case "jsonc":
      return json()
    case "md":
    case "mdx":
      return markdown()
    case "py":
    case "pyw":
      return python()
    case "rs":
      return rust()
    case "c":
    case "h":
    case "cpp":
    case "cxx":
    case "cc":
    case "hpp":
      return cpp()
    case "java":
    case "kt":
    case "kts":
      return java()
    case "xml":
    case "svg":
    case "xsl":
      return xml()
    case "sql":
      return sql()
    case "yaml":
    case "yml":
      return yaml()
    case "php":
      return php()
    case "go":
      return go()
    default:
      return null
  }
}

export interface EditableFileProps {
  file: string
  content: string
  editedContent?: string
  diagnostics?: LspDiagnostic[]
  selectedLines?: SelectedLineRange | null
  jumpLines?: SelectedLineRange | null
  scrollTop?: number
  scrollLeft?: number
  lint?: LintActions
  review?: {
    busy?: boolean
    count: number
    text: string
    hunks: ReviewMark[]
    onApprove: (idx: number) => void
    onReject: (idx: number) => void
    onApproveAll: VoidFunction
    onRejectAll: VoidFunction
  }
  onContentChange?: (content: string) => void
  onSelectionChange?: (range: { startLine: number; endLine: number } | null) => void
  onSave?: (content: string) => Promise<void>
  onViewMode?: () => void
  onDefinition?: (input: { file: string; line: number; character: number }) => Promise<LspLocation[]>
  onDefinitionPick?: (items: LspLocation[]) => Promise<LspLocation | undefined>
  onDefinitionNavigate?: (item: LspLocation) => Promise<void> | void
  onJumpApplied?: VoidFunction
  onScroll?: (input: { top: number; left: number }) => void
  search?: {
    register: (handle: FileSearchHandle | null) => void
  }
}

function pos(doc: EditorState["doc"], line: number) {
  if (doc.lines === 0) return { at: 0, side: 1 as const }
  if (line > doc.lines) return { at: doc.length, side: 1 as const }
  const at = doc.line(Math.max(1, line)).from
  return { at, side: -1 as const }
}

function range(doc: EditorState["doc"], start: number, end: number) {
  const from = doc.line(Math.max(1, start)).from
  if (end >= doc.lines) return { from, to: doc.length }
  return { from, to: doc.line(end + 1).from }
}

function lineRange(doc: EditorState["doc"], input: SelectedLineRange) {
  const start = Math.min(input.start, input.end)
  const end = Math.max(input.start, input.end)
  return range(doc, start, end)
}

function word(view: EditorView, pos: number) {
  const item = view.state.wordAt(pos)
  if (item) return item
  return undefined
}

function jump(input: MouseEvent | KeyboardEvent) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  if (input.altKey || input.shiftKey) return false
  return mac ? input.metaKey : input.ctrlKey
}

function linkExt(input?: { from: number; to: number }) {
  if (!input || input.from === input.to) return EditorView.decorations.of(Decoration.none)
  return EditorView.decorations.of(
    Decoration.set([Decoration.mark({ class: "cm-definition-link" }).range(input.from, input.to)], true),
  )
}

const setup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
  ]),
]

class HunkWidget extends WidgetType {
  constructor(
    private hunk: ReviewMark,
    private busy: boolean,
    private approve: (idx: number) => void,
    private reject: (idx: number) => void,
  ) {
    super()
  }

  eq(other: HunkWidget) {
    return other.hunk.id === this.hunk.id && other.busy === this.busy
  }

  toDOM() {
    const root = document.createElement("div")
    root.className = "cm-ai-widget"

    const bar = document.createElement("div")
    bar.className = "cm-ai-actions"

    const approve = document.createElement("button")
    approve.className = "cm-ai-btn cm-ai-btn-approve"
    approve.textContent = "Approve"
    approve.disabled = this.busy
    approve.onclick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.approve(this.hunk.idx)
    }

    const reject = document.createElement("button")
    reject.className = "cm-ai-btn cm-ai-btn-reject"
    reject.textContent = "Reject"
    reject.disabled = this.busy
    reject.onclick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.reject(this.hunk.idx)
    }

    bar.append(approve, reject)
    root.append(bar)

    if (this.hunk.del.length > 0) {
      const box = document.createElement("div")
      box.className = "cm-ai-diff cm-ai-del"
      for (const line of this.hunk.del) {
        const row = document.createElement("div")
        row.className = "cm-ai-del-line"
        row.textContent = line.length > 0 ? line : " "
        box.append(row)
      }
      root.append(box)
    }

    if (this.hunk.add.length > 0) {
      const box = document.createElement("div")
      box.className = "cm-ai-diff cm-ai-add"
      for (const line of this.hunk.add) {
        const row = document.createElement("div")
        row.className = "cm-ai-add-line-preview"
        row.textContent = line.length > 0 ? line : " "
        box.append(row)
      }
      root.append(box)
    }

    return root
  }

  ignoreEvent() {
    return false
  }
}

function marks(review: NonNullable<EditableFileProps["review"]>) {
  const build = (state: EditorState) => {
    const out = []
    for (const hunk of review.hunks) {
      const item = new HunkWidget(hunk, !!review.busy, review.onApprove, review.onReject)
      const place =
        hunk.add_start && hunk.add_end
          ? range(state.doc, hunk.add_start, hunk.add_end)
          : { from: pos(state.doc, hunk.anchor).at, to: pos(state.doc, hunk.anchor).at }
      if (hunk.add_start && hunk.add_end) {
        out.push(Decoration.replace({}).range(place.from, place.to))
      }
      out.push(Decoration.widget({ widget: item, block: true, side: -1 }).range(place.from))
    }
    return Decoration.set(out, true)
  }

  return StateField.define({
    create(state) {
      return build(state)
    },
    update(_, tr) {
      return build(tr.state)
    },
    provide: (field) => EditorView.decorations.from(field),
  })
}

function reviewExt(review: EditableFileProps["review"]) {
  if (!review) return []

  return [
    marks(review),
    EditorView.theme({
      ".cm-ai-widget": {
        margin: "6px 0",
        border: "1px solid var(--border-base, #333)",
        borderRadius: "8px",
        background: "var(--surface-base, #18181b)",
        overflow: "hidden",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
      },
      ".cm-ai-actions": {
        display: "flex",
        gap: "6px",
        padding: "6px 8px",
        borderBottom: "1px solid var(--border-base, #333)",
        background: "var(--surface-raised-base, #202024)",
      },
      ".cm-ai-btn": {
        border: "1px solid var(--border-base, #333)",
        borderRadius: "999px",
        padding: "2px 10px",
        fontSize: "11px",
        fontWeight: "600",
        cursor: "pointer",
      },
      ".cm-ai-btn:disabled": {
        opacity: "0.5",
        cursor: "not-allowed",
      },
      ".cm-ai-btn-approve": {
        color: "var(--color-success-500, #22c55e)",
        background: "transparent",
      },
      ".cm-ai-btn-reject": {
        color: "var(--color-danger-500, #ef4444)",
        background: "transparent",
      },
      ".cm-ai-diff": {
        borderTop: "1px solid var(--border-base, #333)",
      },
      ".cm-ai-del": {
        backgroundColor: "color-mix(in oklab, var(--color-danger-500, #ef4444) 12%, transparent)",
      },
      ".cm-ai-del-line": {
        padding: "0 10px",
        minHeight: "24px",
        lineHeight: "24px",
        color: "var(--text-dimmed, #999)",
        textDecoration: "line-through",
        fontFamily: "var(--font-family-mono)",
        whiteSpace: "pre-wrap",
      },
      ".cm-ai-add": {
        backgroundColor: "color-mix(in oklab, var(--color-success-500, #22c55e) 12%, transparent)",
      },
      ".cm-ai-add-line-preview": {
        padding: "0 10px",
        minHeight: "24px",
        lineHeight: "24px",
        color: "var(--text-base, #ddd)",
        fontFamily: "var(--font-family-mono)",
        whiteSpace: "pre-wrap",
      },
    }),
  ]
}

function hits(text: string, query: string) {
  const value = query.toLowerCase()
  if (!value) return []

  const out: { from: number; to: number }[] = []
  const hay = text.toLowerCase()
  let at = hay.indexOf(value)
  while (at !== -1) {
    out.push({ from: at, to: at + query.length })
    at = hay.indexOf(value, at + query.length)
  }
  return out
}

function findExt(items: { from: number; to: number }[], idx: number) {
  if (items.length === 0) return EditorView.decorations.of(Decoration.none)

  return EditorView.decorations.of(
    Decoration.set(
      items.map((item, at) =>
        Decoration.mark({
          class: at === idx ? "cm-find-hit cm-find-hit-current" : "cm-find-hit",
        }).range(item.from, item.to),
      ),
      true,
    ),
  )
}

export function EditableFile(props: EditableFileProps) {
  const file = useFile()
  const [saving, setSaving] = createSignal(false)
  const [find, setFind] = createStore({
    open: false,
    query: "",
    replace: "",
    idx: 0,
    count: 0,
  })
  let root: HTMLDivElement | undefined
  let view: EditorView | undefined
  let findInput: HTMLInputElement | undefined
  let hover: number | undefined
  let smooth: ReturnType<typeof setTimeout> | undefined
  let point: { x: number; y: number } | undefined
  let seq = 0
  const markSlot = new Compartment()
  const readSlot = new Compartment()
  const editSlot = new Compartment()
  const findSlot = new Compartment()
  const lintSlot = new Compartment()
  const linkSlot = new Compartment()

  const reviewing = () => !!props.review
  const currentContent = () => (props.review ? props.review.text : (props.editedContent ?? props.content))
  const hasChanges = () => !reviewing() && currentContent() !== props.content

  const setLink = (input?: { from: number; to: number }) => {
    if (!view) return
    view.dom.style.cursor = input ? "pointer" : ""
    view.dispatch({
      effects: linkSlot.reconfigure(linkExt(input)),
    })
  }

  const clearLink = () => {
    if (hover !== undefined) {
      clearTimeout(hover)
      hover = undefined
    }
    point = undefined
    setLink()
  }

  const resolve = (pos: number) => {
    if (!view || !props.onDefinition) return Promise.resolve([] as LspLocation[])
    const line = view.state.doc.lineAt(pos)
    return props.onDefinition({
      file: props.file,
      line: line.number - 1,
      character: pos - line.from,
    })
  }

  const inspect = (x: number, y: number) => {
    if (!view || reviewing() || !props.onDefinition) return
    const pos = view.posAtCoords({ x, y })
    if (pos === null) {
      setLink()
      return
    }
    const item = word(view, pos)
    if (!item) {
      setLink()
      return
    }
    const id = ++seq
    void resolve(pos).then((items) => {
      if (id !== seq) return
      if (items.length === 0) {
        setLink()
        return
      }
      setLink(item)
    })
  }

  const schedule = (x: number, y: number) => {
    if (hover !== undefined) clearTimeout(hover)
    hover = window.setTimeout(() => {
      hover = undefined
      inspect(x, y)
    }, 120)
  }

  const syncFind = (input?: { reset?: boolean; scroll?: boolean }) => {
    if (!view) return

    const query = find.query.trim()
    const items = query ? hits(view.state.doc.toString(), query) : []
    const idx = items.length === 0 ? 0 : Math.min(input?.reset ? 0 : find.idx, items.length - 1)

    if (find.count !== items.length) setFind("count", items.length)
    if (find.idx !== idx) setFind("idx", idx)

    view.dispatch({
      effects: findSlot.reconfigure(findExt(items, idx)),
    })

    const item = input?.scroll ? items[idx] : undefined
    if (!item) return
    view.dispatch({
      selection: { anchor: item.from, head: item.to },
      scrollIntoView: true,
    })
  }

  const syncLint = () => {
    if (!view) return
    const editor = view
    const items = reviewing()
      ? []
      : (props.diagnostics ?? []).map((item) =>
          lintDiagnostic(editor.state.doc, item, props.lint),
        )
    editor.dispatch(setDiagnostics(editor.state, items))
  }

  const restoreScroll = () => {
    if (!view) return
    const top = props.scrollTop ?? 0
    const left = props.scrollLeft ?? 0
    if (Math.abs(view.scrollDOM.scrollTop - top) > 1) view.scrollDOM.scrollTop = top
    if (Math.abs(view.scrollDOM.scrollLeft - left) > 1) view.scrollDOM.scrollLeft = left
  }

  const openFind = (query?: string) => {
    if (query !== undefined && query !== find.query) setFind("query", query)
    if (!find.open) setFind("open", true)
    requestAnimationFrame(() => {
      syncFind({ reset: query !== undefined, scroll: true })
      findInput?.focus()
      findInput?.select()
    })
  }

  const closeFind = () => {
    setFind({
      open: false,
      query: "",
      replace: "",
      idx: 0,
      count: 0,
    })
    if (!view) return
    view.dispatch({
      effects: findSlot.reconfigure(findExt([], 0)),
    })
  }

  const step = (dir: 1 | -1) => {
    if (!find.open || !view || find.count === 0) return
    setFind("idx", (find.idx + dir + find.count) % find.count)
    requestAnimationFrame(() => syncFind({ scroll: true }))
  }

  const swap = (all: boolean) => {
    if (reviewing() || !view) return

    const query = find.query.trim()
    if (!query) return

    const next = find.replace
    const text = view.state.doc.toString()
    const items = hits(text, query)
    if (items.length === 0) return

    if (all) {
      const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
      view.dispatch({
        changes: { from: 0, to: text.length, insert: text.replace(re, next) },
      })
      setFind("idx", 0)
      requestAnimationFrame(() => syncFind({ reset: true, scroll: true }))
      return
    }

    const item = items[Math.min(find.idx, items.length - 1)]
    if (!item) return
    view.dispatch({
      changes: { from: item.from, to: item.to, insert: next },
    })
    requestAnimationFrame(() => syncFind({ scroll: true }))
  }

  const handleSave = async () => {
    if (reviewing() || !hasChanges() || saving()) return
    setSaving(true)
    try {
      if (props.onSave) await props.onSave(currentContent())
      else await file.save(props.file, currentContent())
      showToast({ variant: "success", title: "File saved", description: props.file })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Failed to save",
        description: error instanceof Error ? error.message : "Unknown error",
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    if (reviewing()) return
    props.onContentChange?.(props.content)
    if (!view) return
    const doc = view.state.doc.toString()
    if (doc === props.content) return
    view.dispatch({
      changes: { from: 0, to: doc.length, insert: props.content },
    })
  }

  createEffect(() => {
    if (typeof window === "undefined") return
    const down = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return
      event.preventDefault()
      event.stopPropagation()
      void handleSave()
    }
    const move = (event: KeyboardEvent) => {
      if (!jump(event) || !point) return
      schedule(point.x, point.y)
    }
    const up = (event: KeyboardEvent) => {
      if (jump(event)) return
      clearLink()
    }
    window.addEventListener("keydown", down, { capture: true })
    window.addEventListener("keydown", move, { capture: true })
    window.addEventListener("keyup", up, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", down, { capture: true }))
    onCleanup(() => window.removeEventListener("keydown", move, { capture: true }))
    onCleanup(() => window.removeEventListener("keyup", up, { capture: true }))
  })

  onMount(() => {
    if (!root) return

    const ext = [
      setup,
      oneDark,
      markSlot.of(reviewExt(props.review)),
      readSlot.of(EditorState.readOnly.of(reviewing())),
      editSlot.of(EditorView.editable.of(!reviewing())),
      findSlot.of(findExt([], 0)),
      lintSlot.of([linter(null), lintGutter()]),
      linkSlot.of(linkExt()),
      EditorView.domEventHandlers({
        mousemove: (event, input) => {
          point = { x: event.clientX, y: event.clientY }
          if (!jump(event) || reviewing() || !props.onDefinition) {
            setLink()
            return false
          }
          schedule(event.clientX, event.clientY)
          return false
        },
        mouseleave: () => {
          clearLink()
          return false
        },
        mousedown: (event, input) => {
          if (!jump(event) || reviewing() || !props.onDefinition) return false
          const pos = input.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false
          event.preventDefault()
          event.stopPropagation()
          void resolve(pos).then(async (items) => {
            if (items.length === 0) return
            const item =
              items.length === 1 ? items[0] : props.onDefinitionPick ? await props.onDefinitionPick(items) : items[0]
            if (!item) return
            await props.onDefinitionNavigate?.(item)
          })
          return true
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !props.review) {
          props.onContentChange?.(update.state.doc.toString())
        }
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main
          if (sel.empty) {
            props.onSelectionChange?.(null)
            return
          }
          const startLine = update.state.doc.lineAt(sel.from).number
          const endLine = update.state.doc.lineAt(sel.to).number
          props.onSelectionChange?.({ startLine, endLine })
        }
      }),
      EditorView.theme({
        "&": { height: "100%", fontSize: "var(--font-size-small, 13px)", backgroundColor: "transparent" },
        ".cm-scroller": { fontFamily: "var(--font-family-mono)", lineHeight: "24px" },
        ".cm-content": { caretColor: "var(--text-base, #e0e0e0)" },
        "&.cm-focused": { outline: "none" },
        ".cm-gutters": {
          borderRight: "1px solid var(--border-base, #333)",
          backgroundColor: "transparent",
        },
        ".cm-activeLineGutter": { backgroundColor: "transparent" },
        ".cm-find-hit": {
          backgroundColor: "color-mix(in oklab, var(--color-warning-500, #f59e0b) 28%, transparent)",
          borderRadius: "2px",
        },
        ".cm-find-hit-current": {
          backgroundColor: "color-mix(in oklab, var(--color-warning-500, #f59e0b) 52%, transparent)",
          boxShadow: "inset 0 0 0 1px color-mix(in oklab, white 18%, transparent)",
        },
        ".cm-diagnostic": {
          borderBottomWidth: "2px",
        },
        ".cm-diagnosticInfo, .cm-diagnosticHint": {
          opacity: "0.8",
        },
        ".cm-lintRange-error": {
          backgroundColor: "color-mix(in oklab, var(--color-danger-500, #ef4444) 14%, transparent)",
        },
        ".cm-lintRange-warning": {
          backgroundColor: "color-mix(in oklab, var(--color-warning-500, #f59e0b) 14%, transparent)",
        },
        ".cm-definition-link": {
          textDecoration: "underline",
          textDecorationThickness: "2px",
          textUnderlineOffset: "3px",
        },
      }),
    ]

    const lang = getLanguageExtension(props.file)
    if (lang) ext.push(lang)

    view = new EditorView({
      state: EditorState.create({ doc: currentContent(), extensions: ext }),
      parent: root,
    })
    const onScroll = () => {
      if (!view) return
      props.onScroll?.({
        top: view.scrollDOM.scrollTop,
        left: view.scrollDOM.scrollLeft,
      })
    }
    view.scrollDOM.addEventListener("scroll", onScroll)
    onCleanup(() => view?.scrollDOM.removeEventListener("scroll", onScroll))
    syncLint()
  })

  createEffect(() => {
    if (!view) return
    view.dispatch({
      effects: [
        markSlot.reconfigure(reviewExt(props.review)),
        readSlot.reconfigure(EditorState.readOnly.of(reviewing())),
        editSlot.reconfigure(EditorView.editable.of(!reviewing())),
      ],
    })
    syncLint()
  })

  createEffect(() => {
    find.open
    find.query
    find.idx
    currentContent()
    if (!view) return
    syncFind()
  })

  createEffect(() => {
    const search = props.search
    if (!search) return
    const handle = {
      focus: (query?: string) => openFind(query),
    } satisfies FileSearchHandle
    search.register(handle)
    onCleanup(() => search.register(null))
  })

  createEffect(() => {
    const content = currentContent()
    if (!view) return
    const doc = view.state.doc.toString()
    if (doc !== content) {
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: content },
      })
    }
  })

  createEffect(() => {
    props.diagnostics
    props.lint?.copy
    props.lint?.chat
    props.lint?.label.copy
    props.lint?.label.chat
    if (!view) return
    syncLint()
  })

  createEffect(() => {
    props.scrollTop
    props.scrollLeft
    if (!view) return
    if (props.selectedLines || props.jumpLines) return
    requestAnimationFrame(restoreScroll)
  })

  createEffect(() => {
    const item = props.selectedLines
    if (!view || !item) return
    const next = lineRange(view.state.doc, item)
    const cur = view.state.selection.main
    if (cur.from === next.from && cur.to === next.to) return
    view.dispatch({
      selection: { anchor: next.from, head: next.to },
      scrollIntoView: true,
    })
    view.focus()
  })

  createEffect(() => {
    const item = props.jumpLines
    if (!view || !item) return
    const next = lineRange(view.state.doc, item)
    const dom = view.scrollDOM
    if (smooth) clearTimeout(smooth)
    dom.style.scrollBehavior = "smooth"
    view.dispatch({
      effects: EditorView.scrollIntoView(next.from, {
        y: "center",
      }),
    })
    smooth = setTimeout(() => {
      if (view?.scrollDOM !== dom) return
      dom.style.scrollBehavior = ""
      smooth = undefined
    }, 220)
    view.focus()
    props.onJumpApplied?.()
  })

  onCleanup(() => {
    clearLink()
    if (smooth) clearTimeout(smooth)
    view?.destroy()
  })

  return (
    <div class="editable-file">
      <div class="editable-file-toolbar">
        <div class="editable-file-toolbar-left">
          <span class="editable-file-mode-label">
            {reviewing() ? "AI Review" : "Edit Mode"}
            <Show when={reviewing()}>
              <span class="editable-file-unsaved"> • {props.review!.count} pending</span>
            </Show>
            <Show when={hasChanges()}>
              <span class="editable-file-unsaved"> • Unsaved</span>
            </Show>
          </span>
        </div>
        <div class="editable-file-toolbar-right">
          <Show when={reviewing()}>
            <Button
              variant="ghost"
              size="small"
              onClick={() => props.review?.onRejectAll()}
              disabled={props.review?.busy}
            >
              Reject All
            </Button>
            <Button
              variant="primary"
              size="small"
              onClick={() => props.review?.onApproveAll()}
              disabled={props.review?.busy}
            >
              Approve All
            </Button>
          </Show>
          <Show when={!reviewing() && hasChanges()}>
            <Button variant="ghost" size="small" onClick={handleDiscard} disabled={saving()}>
              Discard
            </Button>
          </Show>
          <Show when={!reviewing() && hasChanges()}>
            <Button variant="primary" size="small" onClick={() => void handleSave()} disabled={saving()}>
              {saving() ? "Saving..." : "Save"}
              <kbd class="ml-1 rounded border border-current/20 px-1 font-mono text-[10px] uppercase opacity-70">
                ⌘S
              </kbd>
            </Button>
          </Show>
          <Show when={!reviewing()}>
            <Button variant="ghost" size="small" onClick={() => openFind()} title="Find in file">
              Find
            </Button>
          </Show>
          <Show when={!reviewing()}>
            <Button variant="secondary" size="small" onClick={() => props.onViewMode?.()} title="Switch to view mode">
              View
            </Button>
          </Show>
        </div>
      </div>

      <Show when={find.open}>
        <div class="editable-file-find">
          <div class="editable-file-find-frame">
            <div class="editable-file-find-main">
              <input
                ref={findInput}
                value={find.query}
                placeholder="Find"
                class="editable-file-find-input editable-file-find-input-main"
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
                onInput={(event) => setFind("query", event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault()
                    closeFind()
                    return
                  }
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  step(event.shiftKey ? -1 : 1)
                }}
              />
              <Show when={!reviewing()}>
                <input
                  value={find.replace}
                  placeholder="Replace"
                  class="editable-file-find-input"
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                  onInput={(event) => setFind("replace", event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault()
                      closeFind()
                      return
                    }
                    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "enter") return
                    event.preventDefault()
                    swap(false)
                  }}
                />
              </Show>
            </div>
            <div class="editable-file-find-side">
              <div class="editable-file-find-count">{find.count ? `${find.idx + 1}/${find.count}` : "0/0"}</div>
              <button type="button" class="editable-file-find-btn" disabled={find.count === 0} onClick={() => step(1)}>
                Next
              </button>
              <button type="button" class="editable-file-find-btn" disabled={find.count === 0} onClick={() => step(-1)}>
                Prev
              </button>
              <Show when={!reviewing()}>
                <button
                  type="button"
                  class="editable-file-find-btn"
                  disabled={find.count === 0 || !find.replace.trim()}
                  onClick={() => swap(false)}
                >
                  Replace
                </button>
                <button
                  type="button"
                  class="editable-file-find-btn"
                  disabled={find.count === 0 || !find.replace.trim()}
                  onClick={() => swap(true)}
                >
                  All
                </button>
              </Show>
              <button type="button" class="editable-file-find-close" onClick={closeFind} aria-label="Close find">
                ×
              </button>
            </div>
          </div>
        </div>
      </Show>

      <div class="editable-file-editor" ref={root} />
    </div>
  )
}
