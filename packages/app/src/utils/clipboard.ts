export function writeClipboardText(value: string) {
  const body = typeof document === "undefined" ? undefined : document.body
  if (body) {
    const area = document.createElement("textarea")
    area.value = value
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    area.style.pointerEvents = "none"
    body.appendChild(area)
    area.select()
    const ok = document.execCommand("copy")
    body.removeChild(area)
    if (ok) return Promise.resolve(true)
  }

  const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clip?.writeText) return Promise.resolve(false)
  return clip.writeText(value).then(
    () => true,
    () => false,
  )
}
