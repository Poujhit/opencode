import { describe, expect, test } from "bun:test"
import { active, changes, summary } from "./git"

const state = {
  root: "/repo",
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  clean: false,
  staged: { files: 1, added: 2, removed: 0 },
  unstaged: { files: 2, added: 3, removed: 1 },
  untracked: { files: 1, added: 4, removed: 0 },
  combined: { files: 3, added: 5, removed: 1 },
  has_upstream: true,
  can_push: true,
}

describe("git helpers", () => {
  test("selects staged or combined summaries", () => {
    expect(summary(undefined, false)).toBeUndefined()
    expect(summary(state, false)).toEqual(state.staged)
    expect(summary(state, true)).toEqual(state.combined)
  })

  test("counts combined file changes", () => {
    expect(changes(undefined)).toBe(0)
    expect(changes(state)).toBe(3)
    expect(changes({ ...state, combined: undefined } as unknown as Parameters<typeof changes>[0])).toBe(1)
  })

  test("reports whether git is active", () => {
    expect(active(undefined)).toBe(false)
    expect(active(state)).toBe(true)
    expect(active({ ...state, branch: undefined })).toBe(true)
    expect(active({ ...state, branch: undefined, root: undefined })).toBe(false)
  })
})
