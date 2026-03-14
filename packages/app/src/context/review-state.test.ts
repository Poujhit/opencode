import { describe, expect, test } from "bun:test"
import { deriveReview, pending, renderReview, reviewSig, syncReview } from "./review-state"

function msg(id: string, time: number, file: string, base: string, next: string) {
  return {
    id,
    role: "user",
    time: { created: time },
    summary: {
      diffs: [
        {
          file,
          before: base,
          after: next,
          additions: 1,
          deletions: 1,
        },
      ],
    },
  }
}

describe("deriveReview", () => {
  test("keeps the latest proposal for the same file", () => {
    const out = deriveReview([
      msg("m1", 1, "src/a.ts", "a\n", "b\n"),
      msg("m2", 2, "src/a.ts", "b\n", "c\n"),
    ] as any)

    expect(out).toHaveLength(1)
    expect(out[0]?.msg).toBe("m2")
    expect(out[0]?.next).toBe("c\n")
  })
})

describe("syncReview", () => {
  test("preserves hunk decisions for the same proposal", () => {
    const item = deriveReview([msg("m1", 1, "src/a.ts", "a\n", "b\n")] as any)[0]!
    item.hunks[0]!.state = "accepted"

    const next = syncReview(
      { [item.file]: item },
      deriveReview([msg("m1", 1, "src/a.ts", "a\n", "b\n")] as any),
    )

    expect(next["src/a.ts"]?.hunks[0]?.state).toBe("accepted")
  })
})

describe("renderReview", () => {
  test("drops rejected hunks from the merged text", () => {
    const item = deriveReview([
      msg("m1", 1, "src/a.ts", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n", "a\nx\nc\nd\ne\nf\ng\nh\ni\ny\nk\n"),
    ] as any)[0]!

    item.hunks[0]!.state = "rejected"
    const out = renderReview(item)

    expect(out.text).toBe("a\nb\nc\nd\ne\nf\ng\nh\ni\ny\nk\n")
    expect(out.hunks).toHaveLength(1)
  })
})

describe("syncReview replacement", () => {
  test("replaces older file proposals with newer ones", () => {
    const old = deriveReview([msg("m1", 1, "src/a.ts", "a\n", "b\n")] as any)[0]!
    const next = deriveReview([msg("m2", 2, "src/a.ts", "b\n", "c\n")] as any)
    const out = syncReview({ [old.file]: old }, next)

    expect(out["src/a.ts"]?.msg).toBe("m2")
    expect(pending(out["src/a.ts"]!)).toBe(1)
  })

  test("skips dismissed proposals for the same file signature", () => {
    const next = deriveReview([msg("m1", 1, "src/a.ts", "a\n", "b\n")] as any)
    const out = syncReview({}, next, { "src/a.ts": reviewSig(next[0]!) })

    expect(out["src/a.ts"]).toBeUndefined()
  })
})
