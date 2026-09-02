import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createCycle,
  decideIdle,
  decideTransform,
  injectHandoffSystem,
  markWritten,
  noteFirstClear,
  requestHandoff,
} from "../src/cycle.ts"
import { applyClear, applyFilterSince, idsOf, type TransformMessage } from "../src/messages.ts"

function msg(id: string, role: string, text = ""): TransformMessage {
  return { info: { id, role }, parts: [{ type: "text", text }] }
}

describe("markWritten", () => {
  it("is idempotent per handoff number (F2)", () => {
    const cycle = createCycle()
    assert.equal(requestHandoff(cycle, 1), true)
    assert.equal(markWritten(cycle, 1, "continue WP-2"), true)
    assert.equal(markWritten(cycle, 1, "continue WP-2 again"), false)
    assert.equal(markWritten(cycle, 1, "continue WP-2 again"), false)
    assert.equal(cycle.completedNumbers.size, 1)
    assert.equal(cycle.phase, "written")
  })
})

describe("F1 deadlock shape: verify mid-turn without idle", () => {
  it("clears once then keeps post-clear messages so the turn can finish", () => {
    const cycle = createCycle()
    requestHandoff(cycle, 1)
    assert.equal(injectHandoffSystem(cycle), true)

    // tool.execute.after verifies the file; session.idle has not fired.
    assert.equal(markWritten(cycle, 1, "Resume from WP-2. Do not rewrite the handoff."), true)
    assert.equal(injectHandoffSystem(cycle), false)
    assert.equal(decideIdle(cycle).kind, "prompt-continuation")

    const history = [msg("u1", "user", "original task"), msg("a1", "assistant", "did WP-1"), msg("a2", "assistant", "wrote handoff")]

    const first = decideTransform(cycle)
    assert.equal(first.kind, "first-clear")
    if (first.kind !== "first-clear") return
    assert.equal(first.logCleared, true)
    const before = idsOf(history)
    const cleared = applyClear(history, { replacementText: first.continuationText })
    noteFirstClear(cycle, before)
    assert.equal(cleared.mode, "last-user")
    assert.equal(history.length, 1)
    assert.equal(history[0]?.parts?.[0]?.text, first.continuationText)

    // Later LLM calls in the same turn (still no idle): must NOT last-user-wipe.
    assert.equal(decideIdle(cycle).kind, "persist-noreply")
    const second = decideTransform(cycle)
    assert.equal(second.kind, "filter-since")
    if (second.kind !== "filter-since") return
    assert.equal(second.logCleared, false)

    const fullAgain = [
      msg("u1", "user", "original task"),
      msg("a1", "assistant", "did WP-1"),
      msg("a2", "assistant", "wrote handoff"),
      msg("a3", "assistant", "read handoff"),
      msg("a4", "assistant", "start WP-2"),
    ]
    applyFilterSince(fullAgain, second.preClearIds, second.continuationText)
    assert.equal(fullAgain.length, 3)
    assert.equal(fullAgain[0]?.parts?.[0]?.text, second.continuationText)
    assert.deepEqual(
      fullAgain.slice(1).map((m) => m.info?.id),
      ["a3", "a4"],
    )

    const third = decideTransform(cycle)
    assert.equal(third.kind, "filter-since")
    if (third.kind !== "filter-since") return
    assert.equal(third.logCleared, false)
  })

  it("does not re-arm first-clear after the snapshot", () => {
    const cycle = createCycle()
    requestHandoff(cycle, 1)
    markWritten(cycle, 1, "go")
    noteFirstClear(cycle, ["u1", "a1"])
    for (let i = 0; i < 48; i++) {
      const plan = decideTransform(cycle)
      assert.equal(plan.kind, "filter-since")
      if (plan.kind === "filter-since") assert.equal(plan.logCleared, false)
    }
  })
})

describe("requestHandoff after a completed cycle", () => {
  it("allows a later handoff number while still projecting the previous filter", () => {
    const cycle = createCycle()
    requestHandoff(cycle, 1)
    markWritten(cycle, 1, "first")
    noteFirstClear(cycle, ["u1"])
    assert.equal(requestHandoff(cycle, 2), true)
    assert.equal(cycle.phase, "handoff-requested")
    const plan = decideTransform(cycle)
    assert.equal(plan.kind, "filter-since")
  })
})
