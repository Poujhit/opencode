import { createSignal, createEffect, onCleanup, onMount, Show } from "solid-js"
import { showToast } from "@opencode-ai/ui/toast"
import { Button } from "@opencode-ai/ui/button"
import { useFile } from "@/context/file"

import { EditorView, basicSetup } from "codemirror"
import { EditorState } from "@codemirror/state"
import { oneDark } from "@codemirror/theme-one-dark"

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
  onContentChange?: (content: string) => void
  onSelectionChange?: (range: { startLine: number; endLine: number } | null) => void
  onSave?: (content: string) => Promise<void>
  onViewMode?: () => void
}

export function EditableFile(props: EditableFileProps) {
  const file = useFile()
  const [saving, setSaving] = createSignal(false)
  let editorContainer: HTMLDivElement | undefined
  let editorView: EditorView | undefined

  const currentContent = () => props.editedContent ?? props.content
  const hasChanges = () => currentContent() !== props.content

  const handleSave = async () => {
    if (!hasChanges() || saving()) return
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
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
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
      }),
    ]

    const langExt = getLanguageExtension(props.file)
    if (langExt) extensions.push(langExt)

    editorView = new EditorView({
      state: EditorState.create({ doc: currentContent(), extensions }),
      parent: editorContainer,
    })
  })

  // Sync external content changes into CodeMirror
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
            Edit Mode
            <Show when={hasChanges()}>
              <span class="editable-file-unsaved"> • Unsaved</span>
            </Show>
          </span>
        </div>
        <div class="editable-file-toolbar-right">
          <Show when={hasChanges()}>
            <Button variant="ghost" size="small" onClick={handleDiscard} disabled={saving()}>
              Discard
            </Button>
          </Show>
          <Show when={hasChanges()}>
            <Button variant="primary" size="small" onClick={handleSave} disabled={saving()}>
              {saving() ? "Saving..." : "Save"}
              <kbd class="ml-1 opacity-70 text-[10px] uppercase font-mono border border-current/20 rounded px-1">⌘S</kbd>
            </Button>
          </Show>
          <Button
            variant="secondary"
            size="small"
            onClick={() => props.onViewMode?.()}
            title="Switch to view mode"
          >
            View
          </Button>
        </div>
      </div>

      <div class="editable-file-editor" ref={editorContainer} />
    </div>
  )
}
