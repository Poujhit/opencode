# Feature 5: Git Diffs in Edit Mode

## Objective
Show added, modified, and deleted line indicators in the CodeMirror gutter within the `EditableCode` view, similar to VS Code's git diff gutters.

## Knowledge & Current State
- **Frontend Code Editor**: The codebase uses CodeMirror 6 for editing files. The primary component for this is `EditableCode` (found in `packages/app/src/components/editable-file.tsx`).
- **CodeMirror Ecosystem**: CodeMirror 6 supports custom gutter extensions which is the standard way to implement git diff indicators.
- **Backend API**: The backend is powered by Hono (`packages/opencode/src/server/routes/`). It interacts with the file system and running shell commands (`$` from `bun`). 
- **Git Context**: We can use `git show HEAD:<path>` to get the original state of a file before any uncommitted edits.
- **Diffing**: The project already has dependencies capable of diffing. In `packages/opencode/package.json` there is `"diff": "catalog:"` and `@pierre/diffs` which could be used, or the frontend can compute diffs using an existing library.
- **SDK Generation**: Opencode exposes functionality via an auto-generated client SDK. When we add endpoints to the backend, we run `bun run build` in `packages/sdk/js` to generate the TypeScript client.

## Implementation Plan

### 1. Backend: Fetch Original Git Content
**File:** `packages/opencode/src/server/routes/git.ts` (or `file.ts`)
- Add a `GET /git/original` endpoint (or similar) that accepts a file path.
- Endpoint logic: Run `git show HEAD:<relative-path>`.
- **Handling Errors**: If the file is untracked, or the directory is not a git repository, the command will fail. We should gracefully catch this and return a status indicating no original content exists snippet (e.g., `404` or `{ ok: false, reason: "untracked" }`).

### 2. Update SDK Client
**Action:** Run OpenAPI client generation.
- After adding the backend route, run `bun run build` in `packages/sdk/js` to update the frontend API client.

### 3. Frontend: Expose Git File Context
**File:** `packages/app/src/context/file.tsx`
- Add a new method to the context (e.g., `getOriginalContent(path)`).
- This method calls the new SDK endpoint `sdk.client.git.original(...)`.
- We should cache the result to avoid spamming the backend over and over for the same unchanged git head. (Can be cleared/re-fetched when a commit or sync happens).

### 4. CodeMirror Gutter Extension
**File:** Create a new extension, e.g., `app/src/components/codemirror/git-diff-gutter.ts`
- Implement a CodeMirror 6 `gutter()` extension.
- Use `StateField` to store the original text and compute the diff state asynchronously, or pass the diff ranges as CodeMirror `RangeSet<GutterMarker>`.
- Compare the `EditorView.state.doc` against `originalContent`. Compute hunks:
  - **Added**: Lines that exist in current doc but not in original.
  - **Modified**: Lines that changed.
  - **Deleted**: Lines that were removed (usually represented by a small triangle marker between lines).

### 5. Integration in EditableFile
**File:** `packages/app/src/components/editable-file.tsx`
- Consume `file.getOriginalContent(path)` asynchronously when the file loads or the path changes.
- Provide the original text to the CodeMirror instance (likely via a `Compartment` that reconfigures the diff extension when the original text is loaded).
- Ensure styles for `.cm-git-added`, `.cm-git-modified`, and `.cm-git-deleted` are defined in the app's CSS (e.g., in `index.css`).

## Design Considerations
- **Performance**: Computing a diff on every single keystroke can be expensive for very large files. The diff computation inside the CodeMirror extension should ideally be debounced on `EditorView.updateListener` or modeled using a Web Worker if it gets too heavy. However, for a first pass, synchronous calculation or deferred requestAnimationFrame calculation is usually fine.
- **Fallback State**: If `isGitRepo` is false or the content fetch fails, the gutter simply won't render any markers.
