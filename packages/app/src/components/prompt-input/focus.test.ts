import { describe, expect, test } from "bun:test"
import { getCursorPosition } from "./editor-dom"
import { applyPromptFocus } from "./focus"

describe("prompt focus", () => {
  test("focuses the prompt input and moves the cursor", () => {
    const el = document.createElement("div")
    el.dataset.component = "prompt-input"
    el.setAttribute("contenteditable", "true")
    el.textContent = "hello"
    document.body.appendChild(el)

    const ok = applyPromptFocus(3)

    expect(ok).toBe(true)
    expect(document.activeElement).toBe(el)
    expect(getCursorPosition(el)).toBe(3)

    el.remove()
  })
})
