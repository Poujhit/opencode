import { setCursorPosition } from "./editor-dom"

const selector = '[data-component="prompt-input"]'

export function applyPromptFocus(position: number, root: Document | HTMLElement = document) {
  const el = root.querySelector(selector)
  if (!(el instanceof HTMLDivElement)) return false
  el.focus()
  setCursorPosition(el, position)
  return true
}

export function focusPrompt(position: number, root: Document | HTMLElement = document) {
  return new Promise<boolean>((resolve) => {
    requestAnimationFrame(() => {
      resolve(applyPromptFocus(position, root))
    })
  })
}
