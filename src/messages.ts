export type TransformMessage = {
  info?: {
    id?: string
    role?: string
    sessionID?: string
    time?: { created?: number }
  }
  parts?: Array<{ type?: string; text?: string; [k: string]: unknown }>
}

export function applyClear(
  messages: TransformMessage[],
  input: { keepFromId?: string; replacementText?: string },
): { kept: number; mode: "cursor" | "last-user" | "empty" } {
  if (input.keepFromId) {
    const idx = messages.findIndex((m) => m.info?.id === input.keepFromId)
    if (idx >= 0) {
      messages.splice(0, idx)
      return { kept: messages.length, mode: "cursor" }
    }
  }

  const lastUserIdx = [...messages.keys()].reverse().find((i) => messages[i]?.info?.role === "user")
  if (lastUserIdx === undefined) {
    messages.splice(0, messages.length)
    return { kept: 0, mode: "empty" }
  }

  const lastUser = messages[lastUserIdx]
  if (!lastUser) {
    messages.splice(0, messages.length)
    return { kept: 0, mode: "empty" }
  }

  const clone: TransformMessage = {
    info: lastUser.info ? { ...lastUser.info } : { role: "user" },
    parts:
      input.replacementText !== undefined
        ? [
            {
              type: "text",
              text: input.replacementText,
            },
          ]
        : (lastUser.parts ?? []).map((p) => ({ ...p })),
  }
  messages.splice(0, messages.length, clone)
  return { kept: 1, mode: "last-user" }
}

export function idsOf(messages: TransformMessage[]): string[] {
  return messages.map((m) => m.info?.id).filter((id): id is string => typeof id === "string" && id.length > 0)
}

/** Keep a continuation user clone plus messages created after the clear snapshot. */
export function applyFilterSince(
  messages: TransformMessage[],
  preClearIds: ReadonlySet<string>,
  continuationText: string,
): { kept: number; mode: "since" } {
  const newer = messages.filter((m) => {
    const id = m.info?.id
    return typeof id === "string" && !preClearIds.has(id)
  })
  const template = [...messages].reverse().find((m) => m.info?.role === "user") ?? messages[0]
  const clone: TransformMessage = {
    info: template?.info ? { ...template.info, role: "user" } : { role: "user" },
    parts: [{ type: "text", text: continuationText }],
  }
  messages.splice(0, messages.length, clone, ...newer)
  return { kept: messages.length, mode: "since" }
}

export function spliceSystem(system: string[], text: string): void {
  const marker = "<!-- opencode-auto-handoff -->"
  const existing = system.findIndex((s) => s.includes(marker))
  const block = `${marker}\n${text}`
  if (existing >= 0) {
    system.splice(existing, 1, block)
    return
  }
  system.push(block)
}
