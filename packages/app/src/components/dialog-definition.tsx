import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import { For, createMemo } from "solid-js"
import type { LspLocation } from "@/context/file"

function short(input: string) {
  const parts = getDirectory(input).split("/").filter(Boolean)
  if (parts.length <= 4) return `/${parts.join("/")}/`
  return `/${parts.slice(0, 2).join("/")}/…/${parts.slice(-2).join("/")}/`
}

function origin(input: string) {
  if (input.includes("/node_modules/")) return "Dependency definition"
  return "Project definition"
}

export function DialogDefinition(props: { items: LspLocation[]; onSelect: (item: LspLocation) => void }) {
  const dialog = useDialog()
  const count = createMemo(() => props.items.length)

  return (
    <Dialog
      title="Choose definition"
      fit
      class="w-full max-w-[720px] mx-auto [&_[data-slot=dialog-body]]:overflow-hidden"
    >
      <div class="flex h-[min(78vh,720px)] min-w-[36rem] max-w-[44rem] flex-col gap-4 px-1 pb-1">
        <div class="rounded-xl bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-panel)_92%,white_4%),var(--surface-base))] px-4 py-3">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="text-12-medium uppercase tracking-[0.12em] text-text-weak">Go To Definition</div>
              <div class="mt-1 text-14-regular text-text-weak">
                {count()} matches found. Pick the destination you want to open.
              </div>
            </div>
            <div class="inline-flex items-center gap-2 rounded-full bg-surface-panel px-3 py-1 text-12-medium text-text-strong tabular-nums">
              <Icon name="arrow-down-to-line" size="small" class="text-icon-base" />
              {count()} result{count() === 1 ? "" : "s"}
            </div>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          <For each={props.items}>
            {(item, idx) => (
              <button
                type="button"
                autofocus={idx() === 0}
                class="group flex w-full flex-col gap-3 rounded-xl border border-transparent bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-panel)_88%,white_3%),var(--surface-base))] px-4 py-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-border-base hover:bg-surface-hover hover:shadow-[0_10px_30px_rgba(0,0,0,0.18)] focus-visible:outline-none focus-visible:border-border-base focus-visible:ring-2 focus-visible:ring-border-base"
                onClick={() => {
                  props.onSelect(item)
                  dialog.close()
                }}
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-panel/80 text-icon-base">
                        <FileIcon node={{ path: item.path, type: "file" }} class="size-4.5" />
                      </div>
                      <div class="min-w-0">
                        <div class="truncate text-16-medium text-text-strong">{getFilename(item.path)}</div>
                        <div class="text-12-regular text-text-weak">{origin(item.path)}</div>
                      </div>
                    </div>
                  </div>
                  <div class="shrink-0 rounded-full bg-surface-panel/80 px-2.5 py-1 text-12-medium text-text-strong tabular-nums">
                    Line {item.range.start.line + 1}
                  </div>
                </div>

                <div class="pt-1">
                  <div class="mb-2 inline-flex items-center rounded-full bg-surface-panel/80 px-2.5 py-1 text-11-medium uppercase tracking-[0.08em] text-text-dimmed">
                    Path
                  </div>
                  <div class="rounded-lg bg-black/10 px-3 py-2 font-mono text-12-regular text-text-strong break-all">
                    {short(item.path)}
                  </div>
                </div>
              </button>
            )}
          </For>
        </div>

        <div class="flex justify-end pt-2">
          <Button variant="ghost" size="small" onClick={() => dialog.close()}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
