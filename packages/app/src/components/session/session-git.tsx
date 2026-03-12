import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { TextField } from "@opencode-ai/ui/text-field"
import { Switch } from "@opencode-ai/ui/switch"
import { useParams } from "@solidjs/router"
import { For, Match, Show, Switch as SolidSwitch, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { summary, useGit } from "@/context/git"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { formatServerError } from "@/utils/server-errors"

type Action = "commit" | "commit_push"

export function summaryText(input?: { files: number; added: number; removed: number }) {
  if (!input) return ""
  return (
    <>
      <span class="text-text-on-success-base">+{input.added}</span>
      <span class="inline-block w-2" />
      <span class="text-text-on-critical-base">-{input.removed}</span>
      <span> · {input.files}</span>
    </>
  )
}

function repo(input?: string) {
  if (!input) return ""
  return input.split(/[/\\]/).filter(Boolean).at(-1) ?? input
}

function requestError(language: ReturnType<typeof useLanguage>, err: unknown) {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: formatServerError(err, language.t, language.t("common.requestFailed")),
  })
}

function DialogCommit() {
  const git = useGit()
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const sdk = useSDK()
  const params = useParams()
  const [store, setStore] = createStore({
    message: "",
    include_unstaged: true,
    action: "commit" as Action,
  })
  const picked = createMemo(() => summary(git.status, store.include_unstaged))
  const busy = createMemo(() => git.committing || git.pushing || git.generating)
  const model = createMemo(() => local.model.current())
  const modelText = createMemo(() => {
    const item = model()
    if (!item) return language.t("git.commit.model.default")
    return `${item.provider.id}/${item.id}`
  })
  const root = createMemo(() => git.status?.root)
  const name = createMemo(() => repo(root()))
  const mismatch = createMemo(() => Boolean(root() && sdk.directory !== root()))
  const has = createMemo(() => (picked()?.files ?? 0) > 0)
  const actionText = createMemo(() =>
    store.action === "commit_push" ? language.t("git.action.commitPush") : language.t("git.action.commit"),
  )

  const auto = async () => {
    try {
      const model = local.model.current()
      const result = await git.generate({
        include_unstaged: store.include_unstaged,
        providerID: model?.provider.id,
        modelID: model?.id,
        sessionID: params.id,
      })
      if (!result?.message) return
      setStore("message", result.message)
    } catch (err) {
      requestError(language, err)
    }
  }

  const submit = async () => {
    if (!store.message.trim()) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("git.commit.message.required"),
      })
      return
    }
    try {
      await git.commit({
        message: store.message,
        include_unstaged: store.include_unstaged,
      })
      if (store.action === "commit_push") {
        await git.push()
      }
      showToast({
        variant: "success",
        title:
          store.action === "commit_push"
            ? language.t("git.toast.commitPush.title")
            : language.t("git.toast.commit.title"),
        description: git.status?.branch,
      })
      dialog.close()
    } catch (err) {
      requestError(language, err)
    }
  }

  return (
    <Dialog
      title={language.t("git.commit.title")}
      size="large"
      class="w-full max-w-[520px] mx-auto [&_[data-slot=dialog-body]]:overflow-y-auto"
    >
      <div class="flex min-h-0 flex-col gap-4 px-4 pb-4">
        <div class="rounded-md border border-border-weak-base bg-surface-panel px-3 py-2.5">
          <div class="flex flex-wrap items-center gap-2">
            <div class="inline-flex items-center gap-2 rounded-md border border-border-weak-base bg-surface-panel px-2.5 py-1.5 text-12-regular text-text-weak">
              <Icon name="folder" size="small" class="text-icon-base" />
              <span>{language.t("git.repo.label")}</span>
              <span class="text-text-strong">{name() || language.t("git.repo.unknown")}</span>
            </div>
            <div class="inline-flex items-center gap-2 rounded-md border border-border-weak-base bg-surface-panel px-2.5 py-1.5 text-12-regular text-text-weak">
              <Icon name="branch" size="small" class="text-icon-base" />
              <span class="text-text-strong">{git.status?.branch ?? language.t("git.branch.unknown")}</span>
            </div>
            <div class="inline-flex items-center gap-2 rounded-md border border-border-weak-base bg-surface-panel px-2.5 py-1.5 text-12-regular text-text-weak">
              <Icon name="models" size="small" class="text-icon-base" />
              <span>{language.t("git.commit.model.label")}</span>
              <span class="text-text-strong">{modelText()}</span>
            </div>
          </div>
          <div class="mt-2 text-12-regular text-text-weak break-all">
            <span class="text-text-muted">{language.t("git.repo.path")}</span>
            <span class="ml-2 text-text-strong">{root() ?? sdk.directory}</span>
          </div>
          <Show when={mismatch()}>
            <div class="mt-2 rounded-md border border-border-critical-base bg-critical-secondary px-3 py-2 text-12-regular text-text-on-critical-base">
              {language.t("git.repo.warning", {
                current: sdk.directory,
                root: root() ?? "",
              })}
            </div>
          </Show>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div class="rounded-md border border-border-weak-base bg-surface-panel px-3 py-2">
            <div class="text-11-medium text-text-weak uppercase">{language.t("git.summary.staged")}</div>
            <div class="mt-1 text-12-regular text-text-strong">{summaryText(git.status?.staged)}</div>
          </div>
          <div class="rounded-md border border-border-weak-base bg-surface-panel px-3 py-2">
            <div class="text-11-medium text-text-weak uppercase">{language.t("git.summary.unstaged")}</div>
            <div class="mt-1 text-12-regular text-text-strong">{summaryText(git.status?.unstaged)}</div>
          </div>
          <div class="rounded-md border border-border-weak-base bg-surface-panel px-3 py-2">
            <div class="text-11-medium text-text-weak uppercase">{language.t("git.summary.selected")}</div>
            <div class="mt-1 text-12-regular text-text-strong">{summaryText(picked())}</div>
          </div>
        </div>

        <div class="flex items-center justify-between gap-3 rounded-md border border-border-weak-base bg-surface-panel px-3 py-2">
          <div class="min-w-0">
            <div class="text-12-medium text-text-strong">{language.t("git.commit.include")}</div>
            <div class="text-12-regular text-text-weak">{language.t("git.commit.include.help")}</div>
          </div>
          <Switch checked={store.include_unstaged} onChange={(value) => setStore("include_unstaged", value)} />
        </div>

        <TextField
          multiline
          autofocus
          value={store.message}
          onChange={(value) => setStore("message", value)}
          label={language.t("git.commit.message.label")}
          placeholder={language.t("git.commit.message.placeholder")}
          class="min-h-[96px]"
        />

        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <Button variant="ghost" size="small" onClick={auto} disabled={busy() || !has()}>
            <SolidSwitch>
              <Match when={git.generating}>{language.t("git.commit.generate.loading")}</Match>
              <Match when={true}>{language.t("git.commit.generate")}</Match>
            </SolidSwitch>
          </Button>

          <DropdownMenu placement="bottom-end" gutter={4}>
            <DropdownMenu.Trigger
              as={Button}
              variant="ghost"
              size="small"
              class="justify-between min-w-[168px]"
            >
              <span>{actionText()}</span>
              <Icon name="chevron-down" size="small" class="text-icon-weak" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content>
                <DropdownMenu.RadioGroup
                  value={store.action}
                  onChange={(value) => {
                    if (value === "commit" || value === "commit_push") {
                      setStore("action", value)
                    }
                  }}
                >
                  <DropdownMenu.RadioItem value="commit">
                    <DropdownMenu.ItemLabel>{language.t("git.action.commit")}</DropdownMenu.ItemLabel>
                    <DropdownMenu.ItemIndicator>
                      <Icon name="check-small" size="small" class="text-icon-weak" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                  <DropdownMenu.RadioItem value="commit_push">
                    <DropdownMenu.ItemLabel>{language.t("git.action.commitPush")}</DropdownMenu.ItemLabel>
                    <DropdownMenu.ItemIndicator>
                      <Icon name="check-small" size="small" class="text-icon-weak" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>

        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()} disabled={busy()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={submit} disabled={busy() || !has()}>
            <SolidSwitch>
              <Match when={git.committing || git.pushing}>{language.t("git.commit.submitting")}</Match>
              <Match when={true}>{actionText()}</Match>
            </SolidSwitch>
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function SessionGit() {
  const git = useGit()
  const dialog = useDialog()
  const language = useLanguage()
  const branch = createMemo(() => git.status?.branch ?? language.t("git.titlebar.unavailable"))
  const loading = createMemo(() => git.branching && git.branches.length === 0)
  const ready = createMemo(() => git.active())
  const clean = createMemo(() => git.status?.clean ?? true)

  const openCommit = () => dialog.show(() => <DialogCommit />)
  const checkout = async (name: string) => {
    try {
      await git.checkout(name)
    } catch (err) {
      requestError(language, err)
    }
  }
  const load = async () => {
    try {
      await git.load(true)
    } catch (err) {
      requestError(language, err)
    }
  }

  const push = async () => {
    try {
      await git.push()
      showToast({
        variant: "success",
        title: language.t("git.toast.push.title"),
        description: git.status?.branch,
      })
    } catch (err) {
      requestError(language, err)
    }
  }

  return (
      <div class="hidden xl:flex items-center gap-2">
        <DropdownMenu gutter={4} placement="bottom-end" onOpenChange={(open) => open && void load()}>
          <DropdownMenu.Trigger
            as={Button}
            variant="ghost"
            size="small"
            class="h-[24px] px-2 border border-border-weak-base bg-surface-panel shadow-none gap-1.5"
            disabled={!ready() || git.branching}
          >
            <Icon name="branch" size="small" class="text-icon-base" />
            <span class="max-w-[140px] truncate text-12-regular text-text-strong">{branch()}</span>
            <Icon name="chevron-down" size="small" class="text-icon-weak" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <Show when={git.branches.length > 0}>
                <DropdownMenu.RadioGroup
                  value={branch()}
                  onChange={(value) => {
                    if (typeof value === "string") {
                      void checkout(value)
                    }
                  }}
                >
                  <For each={git.branches}>
                    {(item) => (
                      <DropdownMenu.RadioItem value={item.name} disabled={git.branching}>
                        <DropdownMenu.ItemLabel>{item.name}</DropdownMenu.ItemLabel>
                        <DropdownMenu.ItemIndicator>
                          <Icon name="check-small" size="small" class="text-icon-weak" />
                        </DropdownMenu.ItemIndicator>
                      </DropdownMenu.RadioItem>
                    )}
                  </For>
                </DropdownMenu.RadioGroup>
              </Show>
              <Show when={loading()}>
                <DropdownMenu.Item disabled>
                  <DropdownMenu.ItemLabel>{language.t("common.loading")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>

        <div class="h-[24px] px-2 rounded-md border border-border-weak-base bg-surface-panel flex items-center text-12-regular text-text-weak">
          <Show when={ready()} fallback={language.t("git.summary.unavailable")}>
            <Show when={git.status?.clean} fallback={summaryText(git.status?.combined)}>
              {language.t("git.summary.clean")}
            </Show>
          </Show>
        </div>

        <DropdownMenu gutter={4} placement="bottom-end">
          <DropdownMenu.Trigger
            as={Button}
            variant="ghost"
            size="small"
            class="h-[24px] px-2 border border-border-weak-base bg-surface-panel shadow-none gap-1.5"
            disabled={!ready() || git.committing || git.pushing}
          >
            <span class="text-12-regular text-text-strong">{language.t("git.titlebar.actions")}</span>
            <Icon name="chevron-down" size="small" class="text-icon-weak" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <DropdownMenu.Item onSelect={openCommit} disabled={clean()}>
                <DropdownMenu.ItemLabel>{language.t("git.action.commit")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => void push()}
                disabled={!git.status?.can_push || git.pushing || clean()}
              >
                <DropdownMenu.ItemLabel>{language.t("git.action.push")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </div>
  )
}
