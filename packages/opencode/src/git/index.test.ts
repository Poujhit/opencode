import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Git } from "./index"
import { Instance } from "@/project/instance"

const dirs: string[] = []

function dir() {
  const next = mkdtempSync(path.join(tmpdir(), "opencode-git-"))
  dirs.push(next)
  return next
}

function run(cwd: string, args: string[]) {
  const out = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
    },
  })
  const text = out.stdout.toString().trim()
  const err = out.stderr.toString().trim()
  if (out.exitCode === 0) return text
  throw new Error(err || text || `git ${args.join(" ")} failed`)
}

function create() {
  const root = dir()
  run(root, ["init", "-b", "main"])
  run(root, ["config", "user.name", "Test User"])
  run(root, ["config", "user.email", "test@example.com"])
  writeFileSync(path.join(root, "readme.md"), "hello\n")
  run(root, ["add", "readme.md"])
  run(root, ["commit", "-m", "init"])
  return root
}

function change(root: string, file: string, text: string) {
  writeFileSync(path.join(root, file), text)
}

async function withGit<T>(root: string, fn: () => Promise<T>) {
  return Instance.provide({
    directory: root,
    fn,
  })
}

afterEach(async () => {
  await Instance.disposeAll()
  for (const item of dirs.splice(0)) rmSync(item, { recursive: true, force: true })
})

describe("git parse helpers", () => {
  test("parses porcelain status counts", () => {
    const result = Git.parseStatus([
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 MM N... 100644 100644 100644 1111111 2222222 file.ts",
      "1 .M N... 100644 100644 100644 1111111 2222222 note.ts",
      "? new.ts",
    ].join("\n"))
    expect(result.branch).toBe("main")
    expect(result.upstream).toBe("origin/main")
    expect(result.ahead).toBe(2)
    expect(result.behind).toBe(1)
    expect(result.staged).toBe(1)
    expect(result.unstaged).toBe(2)
    expect(result.untracked).toBe(1)
    expect(result.changed).toBe(3)
  })

  test("parses numstat and branch lists", () => {
    expect(
      Git.parseRows([
        "4\t2\talpha.ts",
        "1\t0\tbeta.ts",
        "-\t-\timage.png",
      ].join("\n")),
    ).toEqual({
      files: 3,
      added: 5,
      removed: 2,
    })
    expect(
      Git.parseBranches([
        "dev\t ",
        "main\t*",
        "feat\t ",
      ].join("\n")),
    ).toEqual([
      { name: "main", current: true },
      { name: "dev", current: false },
      { name: "feat", current: false },
    ])
  })

  test("compacts file and hunk summaries for commit generation", () => {
    expect(
      Git.compactNames([
        "M\treadme.md",
        "A\tnote.md",
      ].join("\n")),
    ).toBe([
      "M\treadme.md",
      "A\tnote.md",
    ].join("\n"))

    expect(
      Git.compactPatch([
        "diff --git a/readme.md b/readme.md",
        "index 1111111..2222222 100644",
        "--- a/readme.md",
        "+++ b/readme.md",
        "@@ -1 +1 @@",
        "-hello",
        "+world",
      ].join("\n")),
    ).toBe([
      "diff --git a/readme.md b/readme.md",
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1 +1 @@",
    ].join("\n"))
  })
})

describe("git integration", () => {
  test("detects git after the instance was created before repo init", async () => {
    const root = dir()

    const first = await Instance.provide({
      directory: root,
      fn: () => Git.status(),
    })
    expect(first.root).toBeUndefined()

    run(root, ["init", "-b", "main"])

    const next = await Instance.provide({
      directory: root,
      fn: () => Git.status(),
    })
    expect(next.root).toBe(realpathSync(root))
    expect(next.branch).toBe("main")
  })

  test("lists branches and checks out an existing branch", async () => {
    const root = create()
    run(root, ["checkout", "-b", "feat"])
    run(root, ["checkout", "main"])

    const list = await withGit(root, () => Git.branches())
    expect(list.map((item) => item.name)).toEqual(["main", "feat"])

    const result = await withGit(root, () => Git.checkout("feat"))
    expect(result.branch).toBe("feat")
    await expect(withGit(root, () => Git.checkout("missing"))).rejects.toThrow('Branch "missing" was not found')
  })

  test("commits staged changes only when include_unstaged is false", async () => {
    const root = create()
    change(root, "readme.md", "hello\nworld\n")

    await expect(
      withGit(root, () =>
        Git.commit({
          message: "feat: skip",
          include_unstaged: false,
        }),
      ),
    ).rejects.toThrow("No staged changes to commit")

    run(root, ["add", "readme.md"])
    const result = await withGit(root, () =>
      Git.commit({
        message: "feat: staged",
        include_unstaged: false,
      }),
    )
    expect(result.sha).toHaveLength(40)
    expect(result.status.clean).toBe(true)
  })

  test("includes unstaged and untracked changes when requested", async () => {
    const root = create()
    change(root, "readme.md", "hello\nworld\n")
    change(root, "note.md", "new\n")

    const result = await withGit(root, () =>
      Git.commit({
        message: "feat: all",
        include_unstaged: true,
      }),
    )
    expect(result.sha).toHaveLength(40)
    expect(result.status.clean).toBe(true)
    expect(run(root, ["show", "--stat", "--oneline", "-1"])).toContain("note.md")
  })

  test("pushes a branch to origin when no upstream exists yet", async () => {
    const root = create()
    const remote = dir()
    run(tmpdir(), ["init", "--bare", remote])
    run(root, ["remote", "add", "origin", remote])
    run(root, ["checkout", "-b", "feat"])
    change(root, "readme.md", "hello\npush\n")
    run(root, ["add", "readme.md"])
    run(root, ["commit", "-m", "feat: push"])

    const before = await withGit(root, () => Git.status())
    expect(before.has_upstream).toBe(false)
    expect(before.can_push).toBe(true)

    const result = await withGit(root, () => Git.push())
    expect(result.status.has_upstream).toBe(true)
    expect(run(remote, ["branch", "--list"])).toContain("feat")
  })

  test("fails to push without an upstream or origin", async () => {
    const root = create()
    await expect(withGit(root, () => Git.push())).rejects.toThrow(
      "No upstream or origin remote is configured for this branch",
    )
  })

  test("fails to generate a commit message for an empty diff", async () => {
    const root = create()
    await expect(withGit(root, () => Git.generate({ include_unstaged: false }))).rejects.toThrow(
      "No diff is available to generate a commit message",
    )
  })
})
