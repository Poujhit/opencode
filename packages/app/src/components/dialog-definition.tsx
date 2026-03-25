import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { List } from "@opencode-ai/ui/list"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import { createMemo } from "solid-js"
import type { LspLocation } from "@/context/file"

type Row = {
  id: string
  full: string
  kind: string
  line: string
  loc: LspLocation
  name: string
  path: string
}

function short(input: string) {
  const parts = getDirectory(input).split("/").filter(Boolean)
  if (parts.length <= 4) return `/${parts.join("/")}/`
  return `/${parts.slice(0, 2).join("/")}/.../${parts.slice(-2).join("/")}/`
}

function kind(input: string) {
  if (input.includes("/node_modules/")) return "Dependency"
  return "Project"
}

function key(input: LspLocation) {
  return [
    input.path,
    input.range.start.line,
    input.range.start.character,
    input.range.end.line,
    input.range.end.character,
  ].join(":")
}

export function DialogDefinition(props: { items: LspLocation[]; onSelect: (item: LspLocation) => void }) {
  const dialog = useDialog()
  const count = createMemo(() => props.items.length)
  const rows = createMemo<Row[]>(() =>
    props.items.map((loc) => ({
      id: key(loc),
      full: loc.path,
      kind: kind(loc.path),
      line: String(loc.range.start.line + 1),
      loc,
      name: getFilename(loc.path),
      path: short(loc.path),
    })),
  )

  const pick = (row: Row | undefined) => {
    if (!row) return
    props.onSelect(row.loc)
    dialog.close()
  }

  return (
    <Dialog
      title="Choose definition"
      description={`${count()} match${count() === 1 ? "" : "es"} found. Choose a destination to open.`}
      transition
    >
      <List
        class="flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: "Filter definitions", autofocus: true }}
        emptyMessage="No definitions found"
        items={rows}
        key={(item) => item.id}
        filterKeys={["name", "full", "kind", "line"]}
        onSelect={pick}
      >
        {(item) => (
          <div class="w-full flex items-start justify-between gap-3 rounded-md">
            <div class="flex items-start gap-x-3 grow min-w-0">
              <FileIcon node={{ path: item.loc.path, type: "file" }} class="shrink-0 size-4 mt-0.5" />
              <div class="flex flex-col gap-1 min-w-0">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="truncate text-14-regular text-text-strong">{item.name}</span>
                  <span class="shrink-0 text-12-regular text-text-weak">{item.kind}</span>
                </div>
                <span class="truncate font-mono text-12-regular text-text-weak">{item.path}</span>
              </div>
            </div>
            <span class="shrink-0 text-12-regular text-text-weak">Line {item.line}</span>
          </div>
        )}
      </List>
    </Dialog>
  )
}
