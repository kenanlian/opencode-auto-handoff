import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { createPlugin } from "../src/plugin.ts"
import type { TransformMessage } from "../src/messages.ts"

type LogEvent = { message: string; extra: Record<string, unknown> }

function count(logs: LogEvent[], name: string): number {
  return logs.filter((e) => e.message === name).length
}

function msg(id: string, role: string, text = ""): TransformMessage {
  return { info: { id, role, sessionID: "ses_test" }, parts: [{ type: "text", text }] }
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "handoff-hooks-"))
  const handoffDir = join(dir, "handoff")
  mkdirSync(handoffDir)
  const planFile = join(dir, "plan.md")
  writeFileSync(
    planFile,
    `# Plan
- [ ] **WP-1** First
- [ ] **WP-2** Second

<!-- handoffs -->
`,
  )
  const logs: LogEvent[] = []
  let promptCalls = 0
  const ctx = {
    directory: dir,
    client: {
      app: {
        log: async ({ body }: { body: { message: string; extra?: Record<string, unknown> } }) => {
          logs.push({ message: body.message, extra: body.extra ?? {} })
        },
      },
      session: {
        prompt: async () => {
          promptCalls += 1
          throw new Error("session.prompt must not run during the mid-turn deadlock test")
        },
        messages: async () => ({ data: [] }),
      },
    },
  }
  const hooks = await createPlugin()(ctx as never, {
    enabled: true,
    contextThreshold: 0.0001,
    hardCeiling: 0.99,
    minTurnsBetweenHandoffs: 0,
    handoffDir,
    planFile,
    logging: true,
    handoffTimeoutMs: 60000,
  })
  return { hooks, logs, promptCalls: () => promptCalls, dir, handoffDir, planFile }
}

describe("plugin hooks: tool.execute.after verification without idle (F1)", () => {
  it("applies messages-cleared once and then keeps new assistant messages", async () => {
    const { hooks, logs, promptCalls, planFile } = await boot()
    assert.ok(hooks)

    await hooks.event?.({
      event: {
        type: "message.updated",
        properties: {
          info: {
            sessionID: "ses_test",
            role: "assistant",
            tokens: { input: 200, output: 8, cache: { read: 0, write: 0 } },
            time: { completed: Date.now() },
          },
        },
      },
    } as never)

    writeFileSync(
      planFile,
      `# Plan
- [x] **WP-1** First
- [ ] **WP-2** Second

<!-- handoffs -->
`,
    )

    await hooks["chat.params"]?.(
      { sessionID: "ses_test", model: { limit: { context: 200000 } } } as never,
      {} as never,
    )

    const seed: TransformMessage[] = [msg("u1", "user", "original task"), msg("a1", "assistant", "working")]
    await hooks["experimental.chat.messages.transform"]?.({} as never, { messages: seed } as never)
    assert.equal(count(logs, "handoff-requested"), 1)
    const requested = logs.find((e) => e.message === "handoff-requested")
    const path = String(requested?.extra.path ?? "")
    assert.match(path, /handoff-001-/)

    writeFileSync(
      path,
      `# Handoff 1\n\n## Task goal\nFinish the smoke.\n\n## Next actions\nWP-2\n`,
    )

    await hooks["tool.execute.before"]?.({} as never, {} as never)
    await hooks["tool.execute.after"]?.({} as never, {} as never)
    await hooks["tool.execute.after"]?.({} as never, {} as never)
    assert.equal(count(logs, "handoff-written"), 1)

    const firstCall: TransformMessage[] = [
      msg("u1", "user", "original task"),
      msg("a1", "assistant", "working"),
      msg("a2", "assistant", "wrote file"),
    ]
    await hooks["experimental.chat.messages.transform"]?.({} as never, { messages: firstCall } as never)
    assert.equal(count(logs, "messages-cleared"), 1)
    assert.equal(count(logs, "clearing"), 1)
    assert.equal(firstCall.length, 1)
    assert.match(String(firstCall[0]?.parts?.[0]?.text ?? ""), /WP-2|handoff|Continue/i)

    for (let i = 0; i < 8; i++) {
      const next: TransformMessage[] = [
        msg("u1", "user", "original task"),
        msg("a1", "assistant", "working"),
        msg("a2", "assistant", "wrote file"),
        msg("a3", "assistant", "read handoff"),
        msg(`n${i}`, "assistant", `step ${i}`),
      ]
      await hooks["experimental.chat.messages.transform"]?.({} as never, { messages: next } as never)
      assert.ok(next.length >= 3, `step ${i} should keep post-clear messages, got ${next.length}`)
      assert.equal(next.at(-1)?.info?.id, `n${i}`)
    }

    assert.equal(count(logs, "messages-cleared"), 1)
    assert.equal(count(logs, "handoff-written"), 1)
    assert.equal(count(logs, "continuation-injected"), 0)
    assert.equal(promptCalls(), 0)
  })
})
