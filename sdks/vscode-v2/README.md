# opencode v2 for VS Code

Preview VS Code extension for running a managed local `opencode serve` instance, chatting in-editor, and reviewing AI file changes with native VS Code diff editors and SCM gutters.

## Preview Scope

- Runs one managed local `opencode serve` process per VS Code window
- Tracks one active opencode session per workspace folder
- Sends file and selection context through the published `@opencode-ai/sdk`
- Reviews AI file changes with native diff editors, multi-file review, and quick-diff gutters
- Supports file-level apply and reject actions for reviewed changes

## Prerequisites

This extension requires the [opencode CLI](https://opencode.ai) to be installed locally. Configure `opencodeV2.cliPath` if the binary is not available on your `PATH`.

## Commands

- `opencodeV2.openChat`
- `opencodeV2.startSession`
- `opencodeV2.sendSelection`
- `opencodeV2.sendFile`
- `opencodeV2.reviewSession`
- `opencodeV2.reviewFile`
- `opencodeV2.applyFile`
- `opencodeV2.rejectFile`

## Settings

- `opencodeV2.cliPath`
- `opencodeV2.autoStartServer`
- `opencodeV2.openDiffOnChange`
- `opencodeV2.chatLocation`
- `opencodeV2.trace.server`

## Development

1. `code sdks/vscode-v2`
2. `bun install`
3. Press `F5` to launch the extension host

This package is standalone and does not share packaging or publish scripts with `sdks/vscode`.
