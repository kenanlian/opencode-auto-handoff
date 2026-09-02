import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseConfig } from "../src/config.ts"
import { applyClear, applyFilterSince, spliceSystem } from "../src/messages.ts"
import { appendHandoffMarker, newlyCompleted, parsePlan } from "../src/plan.ts"
import { contextTokens, hasAuthoritativeUsage } from "../src/usage.ts"
import { render } from "../src/templates.ts"

describe("usage", () => {
  it("uses provider formula not tokens.total", () => {
    const tokens = { input: 6338, output: 26, reasoning: 0, cache: { read: 1792, write: 0 } }
    assert.equal(contextTokens(tokens), 8130)
    assert.equal(hasAuthoritativeUsage(tokens), true)
    assert.equal(hasAuthoritativeUsage({ input: 0, output: 0, cache: { read: 0, write: 0 } }), false)
  })
})

describe("parsePlan", () => {
  it("reads checkbox and table WPs plus handoff markers", () => {
    const md = `
# Plan
- [x] **WP-1** Spike
- [ ] **WP-2** Implement

| ID | Status | Notes |
| --- | --- | --- |
| WP-03 | in-progress | coding |
| WP-04 | blocked | wait |

<!-- handoff n=2 file=.dev/handoff-002.md ts=2026-09-02T00:00:00Z -->
`
    const snap = parsePlan(md)
    assert.deepEqual(
      snap.packages.map((p) => [p.id, p.status]),
      [
        ["WP-03", "in-progress"],
        ["WP-04", "blocked"],
        ["WP-1", "done"],
        ["WP-2", "todo"],
      ],
    )
    assert.equal(snap.handoffCount, 2)
  })

  it("detects a WP that just completed", () => {
    const prev = parsePlan("- [ ] **WP-1** A\n- [ ] **WP-2** B\n")
    const next = parsePlan("- [x] **WP-1** Spike\n- [ ] **WP-2** Implement\n")
    assert.deepEqual(newlyCompleted(prev, next), ["WP-1"])
    assert.deepEqual(newlyCompleted(next, next), [])
  })

  it("appends a handoff marker without duplicating", () => {
    const once = appendHandoffMarker("# Plan\n<!-- handoffs -->\n", {
      n: 1,
      file: "a.md",
      ts: "t",
    })
    assert.match(once, /handoff n=1/)
    const twice = appendHandoffMarker(once, { n: 1, file: "a.md", ts: "t" })
    assert.equal(twice, once)
  })
})

describe("config", () => {
  it("clamps and fills defaults", () => {
    const cfg = parseConfig({ contextThreshold: 0.2, hardCeiling: 0.1, enabled: false })
    assert.equal(cfg.contextThreshold, 0.2)
    assert.equal(cfg.hardCeiling, 0.2)
    assert.equal(cfg.enabled, false)
    assert.equal(cfg.handoffDir, ".opencode/handoff")
  })
})

describe("messages.applyClear", () => {
  it("drops history before a cursor id", () => {
    const messages = [
      { info: { id: "a", role: "user" }, parts: [] },
      { info: { id: "b", role: "assistant" }, parts: [] },
      { info: { id: "c", role: "user" }, parts: [{ type: "text", text: "go" }] },
    ]
    const result = applyClear(messages, { keepFromId: "c" })
    assert.equal(result.mode, "cursor")
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.info?.id, "c")
  })

  it("keeps the continuation clone plus messages absent from the pre-clear snapshot", () => {
    const messages = [
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "old" }] },
      { info: { id: "a1", role: "assistant" }, parts: [] },
      { info: { id: "a2", role: "assistant" }, parts: [{ type: "text", text: "new work" }] },
    ]
    const result = applyFilterSince(messages, new Set(["u1", "a1"]), "continue")
    assert.equal(result.mode, "since")
    assert.equal(messages.length, 2)
    assert.equal(messages[0]?.parts?.[0]?.text, "continue")
    assert.equal(messages[1]?.info?.id, "a2")
  })

  it("falls back to a cloned last user without mutating the original parts array", () => {
    const original = [{ type: "text", text: "old" }]
    const messages = [
      { info: { id: "a", role: "user" }, parts: original },
      { info: { id: "b", role: "assistant" }, parts: [] },
    ]
    applyClear(messages, { replacementText: "continue from handoff" })
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.parts?.[0]?.text, "continue from handoff")
    assert.equal(original[0]?.text, "old")
  })
})

describe("spliceSystem", () => {
  it("inserts and replaces the plugin block in place", () => {
    const system = ["base"]
    spliceSystem(system, "first")
    spliceSystem(system, "second")
    assert.equal(system.length, 2)
    assert.match(system[1] ?? "", /second/)
    assert.doesNotMatch(system[1] ?? "", /first/)
  })
})

describe("render", () => {
  it("replaces placeholders", () => {
    assert.equal(render("p={{path}}", { path: ".dev/x.md" }), "p=.dev/x.md")
  })
})
