import { describe, expect, test } from "bun:test"
import path from "path"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("file search and replace", () => {
  test("find groups matches by file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "const foo = 1\nfoo\n")
        await Bun.write(path.join(dir, "b.ts"), "foo bar\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.find({ pattern: "foo" })
        expect(result.total_files).toBe(2)
        expect(result.total_matches).toBe(3)
        expect(result.files[0]?.matches[0]?.text).toContain("foo")
      },
    })
  })

  test("find is case-insensitive by default", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "gemini\nGemini\nGEMINI\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.find({ pattern: "gemini" })
        expect(result.total_files).toBe(1)
        expect(result.total_matches).toBe(3)
      },
    })
  })

  test("find supports match case", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "gemini\nGemini\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.find({ pattern: "Gemini", sensitive: true })
        expect(result.total_files).toBe(1)
        expect(result.total_matches).toBe(1)
      },
    })
  })

  test("find supports whole word", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "gemini\ngeminiService\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.find({ pattern: "gemini", word: true })
        expect(result.total_files).toBe(1)
        expect(result.total_matches).toBe(1)
      },
    })
  })

  test("preview shows replaced lines", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "foo bar\nfoo baz\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.preview({ search: "foo", replace: "zip" })
        expect(result.total_matches).toBe(2)
        expect(result.files[0]?.matches[0]?.next).toBe("zip bar")
      },
    })
  })

  test("preview is case-insensitive by default", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "gemini\nGemini\nGEMINI\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.preview({ search: "gemini", replace: "nova" })
        expect(result.total_matches).toBe(3)
        expect(result.files[0]?.matches[1]?.next).toBe("nova")
      },
    })
  })

  test("replace writes updated file contents", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "foo\nfoo\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.replace({ search: "foo", replace: "zip" })
        expect(result.replacements).toBe(2)
        expect(result.files).toEqual(["a.ts"])
      },
    })

    const text = await Bun.file(path.join(tmp.path, "a.ts")).text()
    expect(text).toBe("zip\nzip\n")
  })

  test("replace is case-insensitive by default", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "gemini\nGemini\nGEMINI\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.replace({ search: "gemini", replace: "nova" })
        expect(result.replacements).toBe(3)
        expect(result.files).toEqual(["a.ts"])
      },
    })

    const text = await Bun.file(path.join(tmp.path, "a.ts")).text()
    expect(text).toBe("nova\nnova\nnova\n")
  })

  test("replace respects whole word", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "gemini\ngeminiService\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await File.replace({ search: "gemini", replace: "nova", word: true })
        expect(result.replacements).toBe(1)
        expect(result.files).toEqual(["a.ts"])
      },
    })

    const text = await Bun.file(path.join(tmp.path, "a.ts")).text()
    expect(text).toBe("nova\ngeminiService\n")
  })
})
