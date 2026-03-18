import { createSignal, createEffect, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { showToast } from "@opencode-ai/ui/toast"
import { Button } from "@opencode-ai/ui/button"
import type { FileSearchHandle } from "@opencode-ai/ui/file"
import { useFile } from "@/context/file"
import type { ReviewMark } from "@/context/review-state"

import { EditorView, basicSetup } from "codemirror"
import { Compartment, EditorState, StateField } from "@codemirror/state"
import { oneDark } from "@codemirror/theme-one-dark"
import { Decoration, WidgetType } from "@codemirror/view"

import { javascript } from "@codemirror/lang-javascript"
import { html } from "@codemirror/lang-html"
import { css } from "@codemirror/lang-css"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { cpp } from "@codemirror/lang-cpp"
import { java } from "@codemirror/lang-java"
import { xml } from "@codemirror/lang-xml"
import { sql } from "@codemirror/lang-sql"
import { yaml } from "@codemirror/lang-yaml"
import { php } from "@codemirror/lang-php"
import { go } from "@codemirror/lang-go"

function getLanguageExtension(filePath: string) {
  const ext = filePath.split(".").pop()?.toLowerCase()
  switch (ext) {
    case "js": case "mjs": case "cjs": return javascript()
    case "ts": case "mts": case "cts": return javascript({ typescript: true })
    case "jsx": return javascript({ jsx: true })
    case "tsx": return javascript({ jsx: true, typescript: true })
    case "html": case "htm": case "svelte": case "vue": return html()
    case "css": case "scss": case "less": return css()
    case "json": case "jsonc": return json()
    case "md": case "mdx": return markdown()
    case "py": case "pyw": return python()
    case "rs": return rust()
    case "c": case "h": case "cpp": case "cxx": case "cc": case "hpp": return cpp()
    case "java": case "kt": case "kts": return java()
    case "xml": case "svg": case "xsl": return xml()
    case "sql": return sql()
    case "yaml": case "yml": return yaml()
    case "php": return php()
    case "go": return go()
    default: return null
  }
}

export interface EditableFileProps {
  file: string
  content: string
  editedContent?: string
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
  let editorContainer: HTMLDivElement | undefined
  let editorView: EditorView | undefined
  let findInput: HTMLInputElement | undefined
  const markSlot = new Compartment()
  const readSlot = new Compartment()
  const editSlot = new Compartment()
  const findSlot = new Compartment()

  const reviewing = () => !!props.review
  const currentContent = () => props.review ? props.review.text : props.editedContent ?? props.content
  const hasChanges = () => !reviewing() && currentContent() !== props.content

  const syncFind = (input?: { reset?: boolean; scroll?: boolean }) => {
    if (!editorView) return

    const query = find.query.trim()
    const items = query ? hits(editorView.state.doc.toString(), query) : []
    const idx = items.length === 0 ? 0 : Math.min(input?.reset ? 0 : find.idx, items.length - 1)

    if (find.count !== items.length) setFind("count", items.length)
    if (find.idx !== idx) setFind("idx", idx)

    editorView.dispatch({
      effects: findSlot.reconfigure(findExt(items, idx)),
    })

    const item = input?.scroll ? items[idx] : undefined
    if (!item) return
    editorView.dispatch({
      selection: { anchor: item.from, head: item.to },
      scrollIntoView: true,
    })
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
    if (!editorView) return
    editorView.dispatch({
      effects: findSlot.reconfigure(findExt([], 0)),
    })
  }

  const step = (dir: 1 | -1) => {
    if (!find.open || !editorView || find.count === 0) return
    setFind("idx", (find.idx + dir + find.count) % find.count)
    requestAnimationFrame(() => syncFind({ scroll: true }))
  }

  const swap = (all: boolean) => {
    if (reviewing() || !editorView) return

    const query = find.query.trim()
    if (!query) return

    const next = find.replace
    const text = editorView.state.doc.toString()
    const items = hits(text, query)
    if (items.length === 0) return

    if (all) {
      const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
      editorView.dispatch({
        changes: { from: 0, to: text.length, insert: text.replace(re, next) },
      })
      setFind("idx", 0)
      requestAnimationFrame(() => syncFind({ reset: true, scroll: true }))
      return
    }

    const item = items[Math.min(find.idx, items.length - 1)]
    if (!item) return
    editorView.dispatch({
      changes: { from: item.from, to: item.to, insert: next },
    })
    requestAnimationFrame(() => syncFind({ scroll: true }))
  }

  const handleSave = async () => {
    if (reviewing() || !hasChanges() || saving()) return
    setSaving(true)
    try {
      if (props.onSave) {
        await props.onSave(currentContent())
      } else {
        await file.save(props.file, currentContent())
      }
      showToast({ variant: "success", title: "File saved", description: props.file })
    } catch (e) {
      showToast({
        variant: "error",
        title: "Failed to save",
        description: e instanceof Error ? e.message : "Unknown error",
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    if (reviewing()) return
    props.onContentChange?.(props.content)
    if (editorView) {
      const doc = editorView.state.doc.toString()
      if (doc !== props.content) {
        editorView.dispatch({
          changes: { from: 0, to: doc.length, insert: props.content },
        })
      }
    }
  }

  // Cmd+S shortcut (captures before CodeMirror)
  createEffect(() => {
    if (typeof window === "undefined") return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return
      event.preventDefault()
      event.stopPropagation()
      handleSave()
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, { capture: true }))
  })

  onMount(() => {
    if (!editorContainer) return

    const extensions = [
      basicSetup,
      oneDark,
      markSlot.of(reviewExt(props.review)),
      readSlot.of(EditorState.readOnly.of(reviewing())),
      editSlot.of(EditorView.editable.of(!reviewing())),
      findSlot.of(findExt([], 0)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !props.review) {
          props.onContentChange?.(update.state.doc.toString())
        }
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main
          if (sel.empty) {
            props.onSelectionChange?.(null)
          } else {
            const startLine = update.state.doc.lineAt(sel.from).number
            const endLine = update.state.doc.lineAt(sel.to).number
            props.onSelectionChange?.({ startLine, endLine })
          }
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
      }),
    ]

    const langExt = getLanguageExtension(props.file)
    if (langExt) extensions.push(langExt)

    editorView = new EditorView({
      state: EditorState.create({ doc: currentContent(), extensions }),
      parent: editorContainer,
    })
  })

  createEffect(() => {
    if (!editorView) return
    editorView.dispatch({
      effects: [
        markSlot.reconfigure(reviewExt(props.review)),
        readSlot.reconfigure(EditorState.readOnly.of(reviewing())),
        editSlot.reconfigure(EditorView.editable.of(!reviewing())),
      ],
    })
  })

  // Sync external content changes into CodeMirror
  createEffect(() => {
    find.open
    find.query
    find.idx
    currentContent()
    if (!editorView) return
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
    if (!editorView) return
    const doc = editorView.state.doc.toString()
    if (doc !== content) {
      editorView.dispatch({
        changes: { from: 0, to: doc.length, insert: content },
      })
    }
  })

  onCleanup(() => editorView?.destroy())

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
            <Button variant="primary" size="small" onClick={handleSave} disabled={saving()}>
              {saving() ? "Saving..." : "Save"}
              <kbd class="ml-1 opacity-70 text-[10px] uppercase font-mono border border-current/20 rounded px-1">⌘S</kbd>
            </Button>
          </Show>
          <Show when={!reviewing()}>
            <Button variant="ghost" size="small" onClick={() => openFind()} title="Find in file">
              Find
            </Button>
          </Show>
          <Show when={!reviewing()}>
            <Button
              variant="secondary"
              size="small"
              onClick={() => props.onViewMode?.()}
              title="Switch to view mode"
            >
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

      <div class="editable-file-editor" ref={editorContainer} />
    </div>
  )
}
