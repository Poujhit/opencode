# Desktop App Feature Enhancements (Implementation Plan & Tasks)

This plan covers the remaining new features to enhance the opencode desktop app's workflow and Git integration.

## Completed Features ✅
- [x] Editable Code View with CodeMirror 6 and Save
- [x] Highlight Lines → Add to Prompt (Cmd+H)

---

## Feature 3: Clear Highlight on Prompt Send ✅
**Goal**: Remove the highlight from the editor and view mode once the user submits the prompt.
- [x] Remove highlight context item from the prompt input on submission
- [x] Retain text selection in the editor

**Approach**:
- We need to detect when the prompt is submitted. Currently, the prompt input likely lives in its own component.
- We will add an event or a reactive state (e.g., via a context or store) that triggers when the prompt is sent.
- In `file-tabs.tsx`, we will listen to this event and reset `editSelection(null)` (for edit mode) and clear the `activeSelection` in the pierre viewer (for view mode).

---

## Feature 3.5: Highlighted Files in Chat Messages ✅
**Goal**: Show the file selection highlights as clickable chips in the sent chat messages.
- [x] Render file context items (the highlight chips) in the sent chat messages.
- [x] Make the chips clickable to open the file and jump to the selection.

**Approach**:
- **Data Model**: Verify that `FileContextItem` data (the selection range) is being saved with the message in the backend/sync store.
- **Message UI**: Locate the component that renders chat messages (likely `message.tsx` or similar). Update it to render a chip for each file context item attached to the message.
- **Interaction**: Add an `onClick` handler to the chip that explicitly opens the file and scrolls/highlights the corresponding line range.

---

## Feature 4: File/Folder Operations in File Tree (Postponed)
**Goal**: Add right-click/dropdown operations for New File, New Folder, and Delete directly in the file tree.
- [ ] Add `File.mkdir` and `File.delete` to `opencode/src/file/index.ts`
- [ ] Add backend endpoints (`POST /file/mkdir`, `DELETE /file`)
- [ ] Add Context Menu/Dropdown to `FileTreeNode` (New File, New Folder, Delete)
- [ ] Add UI dialogs for naming and deletion confirmation
- [ ] Hook up frontend `file.tsx` context methods to the UI

- **Backend Operations (`opencode/src/file/index.ts`)**:
  - Add `File.mkdir(pathname: string)` to create directories.
  - Add `File.delete(pathname: string)` to delete files and directories.
  - `File.write()` is already sufficient for creating new empty files.
- **Backend Routes (`opencode/src/server/routes/file.ts`)**: 
  - Add `POST /file/mkdir` (calls `File.mkdir`).
  - Add `DELETE /file` (calls `File.delete`).
- **Frontend Context (`app/src/context/file.tsx`)**: 
  - Expose API wrappers for mkdir and delete in `file.tsx`.
- **UI (`app/src/pages/session/file-tree.tsx`)**: 
  - Wrap the `FileTreeNode` render or add an action button that triggers a `ContextMenu` (from `@opencode-ai/ui`).
  - Add actions: "New File", "New Folder", "Delete".
  - Use a simple modal/dialog component (or native prompt if suitable) to ask for the new file/folder name.
  - Show a confirmation dialog before calling the delete endpoint.

---

## Feature 5: Top Bar Git Integration (Codex Style)
**Goal**: Provide a Top Bar UI for Git operations, including branch selection, commit summary, and a commit modal with auto-generation capabilities.
- [x] Add backend endpoints for Git operations (`status`, `commit`, `push`, `pr`)
- [x] Add Top Bar Git UI (Branch name, diff summary, Commit dropdown)
- [x] Add Commit Modal UI (Include unstaged toggle, auto-generate message, commit/push actions)

**Approach**:
- **Backend API (`opencode/src/server/routes/git.ts`)**: 
  - Add `GET /git/status`: Returns current branch name, number of changed files, and total lines added/deleted.
  - Add `POST /git/commit`: Takes a commit message and an `includeUnstaged` flag to commit changes.
  - Add `POST /git/push`: Pushes committed changes to the remote repository.
  - Add `POST /git/commit-generate`: Uses an LLM to generate a commit message based on the current diffs.
- **Frontend File Context & SDK**:
  - Update OpenAPI SDK with new Git routes. Expose state in a React context to poll/subscribe to `git status`.
- **Top Bar UI (`app/src/pages/layout/session-header.tsx` or similar)**:
  - Render the current branch name with a branch icon.
  - Render a summary of changes (e.g., `+173 -0`).
  - Add a "Commit" dropdown button with options: "Commit", "Push", "Create PR".
- **Commit Modal UI**:
  - Clicking "Commit" opens a dialog showing the branch, file changes summary.
  - Includes a toggle for "Include unstaged" changes.
  - Contains a textarea for the commit message (with "Leave blank to autogenerate...").
  - Has a "Next steps" dropdown to select "Commit", "Commit and push", or "Commit and create PR".
  - Submitting calls the respective backend endpoints and closes the modal.

---

## Feature 6: AI Edit Diffs & Approvals
**Goal**: When AI makes changes to a file, show the changes as inline diffs in the editor with UI to approve or reject changes per hunk and per file.
- [ ] Render AI changes as inline diffs in CodeMirror (or overlay)
- [ ] Add approve/reject action buttons per line/hunk
- [ ] Add approve/reject all changes action for the whole file
- [ ] Sync approved changes to the main document and discard rejected ones

**Approach**:
- **Data Model**: When an AI edit applies to a file, keep the original content as the base state and the AI's changes as a proposed state.
- **Editor Integration**: 
  - Render proposed AI changes in the CodeMirror editor using a unified diff view or line widgets (e.g., green backgrounds for additions, red crossed-out backgrounds for deletions).
  - Inject CodeMirror gutter widgets (or line widgets) next to changed hunks with ✅ (Approve) and ❌ (Reject) buttons.
- **File-Level Actions**: Add "Approve All" and "Reject All" buttons to the editor toolbar when AI diffs are active.
- **State Resolution**: 
  - **Approve**: Merges the proposed hunk into the base document and removes the diff markers.
  - **Reject**: Reverts the hunk back to the original base text and removes the diff markers.

---

## Verification Plan
1. **Clear Highlight**: Submit a prompt and verify the editor selection disappears.
2. **File Ops**: Right-click in the file tree, create a file, create a folder, and delete an item. Verify changes on disk.
3. **Editor Git Diffs**: Edit a tracked file and observe the gutter colors updating in real-time.
4. **Tree Git Status**: Modify a file and observe its color change in the file tree.
5. **Git UI**: Open the Source Control tab, stage a file, enter a message, and commit. Verify with block `git log`.

## Implementation Rules
- **Strictly Sequential**: Each feature must be implemented one by one.
- **Approval Gated**: After implementing a feature, the agent will pause and wait for user approval before moving to the next.
