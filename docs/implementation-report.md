# Implementation report — opencode-auto-handoff v1

**Implementer:** Cursor Grok 4.6 (this session)  
**Date:** 2026-09-02  
**Target:** OpenCode 1.18.25 (`/opt/homebrew/bin/opencode`)  
**Not done:** git commit, push, npm publish (per brief)

## Rework round 1 (Watson acceptance 2026-09-02)

Watson's real A–E run (sandbox `/tmp/handoff-accept-BCDE`, evidence kept in the maintainer's local acceptance archive) passed A and E, failed B and D, and only partially passed C. Root causes confirmed in code:

**F1 — per-call clear vs idle-gated injection.** `onHandoffVerified` (from `tool.execute.after`, still inside the original turn) used to set `rt.cleared = true`. Every later `experimental.chat.messages.transform` in that turn ran `applyClear` (last-user wipe), so the model lost its own tool results, re-read the handoff/plan forever, never idled, and `injectContinuation` (idle + `rt.pending`) never ran. `rt.cleared` was also never reset, so even a later injection would have been permanent amnesia.

Fix: `src/cycle.ts` owns the handoff cycle. `markWritten` does **not** enable last-user wipe on every call. The next transform is `first-clear` (log `clearing` / `messages-cleared` once, snapshot ids). Later transforms are `filter-since` / `filter-cursor` (keep the continuation payload plus messages **not** in that snapshot) so context can grow. If the session goes idle before that first LLM call, `session.prompt` injects a real continuation user message (export’s second user). If work already continued in-loop, idle persists the same text with `noReply: true`. Handoff system-prompt injection stops after `written` so the model is not asked to write another handoff.

**F2 — `handoff-written` not idempotent.** `markWritten` records `completedNumbers` and returns false on repeats; `onHandoffVerified` only logs when it returns true.

**F3 — smoke masked ETIMEDOUT.** `scripts/smoke.ts` now requires process exit 0, `done-wp2.txt` containing exactly `ok`, `continuation-injected` in stderr, and `messages-cleared` count equal to the number of handoff files. A handoff file after `spawnSync` timeout is a failure; the smoke dir is kept on failure.

Tests added: `test/cycle.test.ts`, `test/plugin-hooks.test.ts` (fake events: `tool.execute.after` verify mid-turn, no idle, 8 further transforms must not re-log `messages-cleared`).

## What shipped

- Spike report with command-level evidence: `docs/spike-report.md`, logs in `.dev/spike-evidence/`
- Plugin: `src/` (TypeScript strict, zero runtime dependencies), including `src/cycle.ts`
- Bundled templates: `templates/handoff-prompt.md`, `templates/continuation-prompt.md`
- Unit tests: `test/machine.test.ts`, `test/core.test.ts`, `test/cycle.test.ts`, `test/plugin-hooks.test.ts`
- Smoke: `scripts/smoke.ts` (exit 0 + WP-2 artifact + continuation log + once-only clear)
- `opencode.json` (this repo: `handoffDir` = `.dev`, `planFile` = `.dev/plan/active-plan.md`)
- `opencode.example.json` (generic defaults, no personal paths in plugin code)
- README.md
- Dogfood plan: `.dev/plan/active-plan.md`, `.dev/execution-summary.md`

## Spike conclusions (short)

1. **Load:** V1 `(ctx, options?) => hooks`. Both `.opencode/plugins/` and `.opencode/plugin/` auto-load. `opencode.json` key is `plugin` (tuple for options). `opencode run` loads plugins.
2. **Usage:** `message.updated` assistant `tokens`; `contextTokens = input + cache.read + cache.write`. Limit from `chat.params` `model.limit.context`.
3. **Clear (selected):** `experimental.chat.messages.transform` in-place splice. Durable history kept. Files kept.
4. **Rejected clears:** V1 `session.revert` (file undo via patches), `DELETE` message (export loses data), V2 `revert/stage` (MessageNotFoundError on V1 sessions).
5. **Idle:** `session.status` `{type:"idle"}` then `session.idle`. Debounce both. Never while tools in flight.
6. **Continue:** `client.session.prompt` same session/PID; `run` stdout is first turn only.

## Known limits

See README “Known limits” and the spike report. Main operational one: after `run`’s first idle, injected turns may not appear on stdout; Hermes should watch PID + session_id **and** the WP-2 artifact / process exit 0, not stdout completeness. `messages-cleared` is once per handoff.

## Watson / Hermes re-test (after rework)

Use `/opt/homebrew/bin/opencode` 1.18.25. From this repo root, then the existing driver if it is still at the evidence path:

```bash
npm test
npx tsc --noEmit
npm run smoke
# Watson driver (kept in the maintainer's local acceptance archive, not this repo):
# see docs/spike-report.md for how to rebuild an equivalent sandbox driver
```

Expect B: WP-1 flip → one handoff file + plan marker → one `messages-cleared` → `continuation-injected` (second user message in `opencode export`) → `done-wp2.txt` with `ok` → `ACCEPT_DONE` → process exits 0, same PID + session_id. C: first post-clear context drops, then grows. E unchanged (pre-handoff history still exported).

## Hermes acceptance (how to reproduce a full loop)

Use `/opt/homebrew/bin/opencode` 1.18.25. From this repo root.

### A — Load

```bash
/opt/homebrew/bin/opencode --print-logs --log-level INFO run --auto --format json \
  --title accept-A \
  "Reply with exactly PING. Do not use tools."
```

Expect log line `service=opencode-auto-handoff message=plugin-loaded` and no plugin throw.

### B — Trigger (low threshold + fake WP done)

Temporarily set in `opencode.json` plugin options:

- `contextThreshold`: `0.0001`
- `minTurnsBetweenHandoffs`: `0`

Ensure `.dev/plan/active-plan.md` has at least one WP marked done (`- [x] **WP-1**` or table `done`/`verified`).

```bash
/opt/homebrew/bin/opencode --print-logs --log-level INFO run --auto --format json \
  --title accept-B \
  "Follow plugin handoff instructions if injected. If asked to write a handoff file, write that exact path, then continue WP-2 by creating .dev/accept-b-continued.txt with the word ok. Do not wait for a human."
```

Expect: `handoff-NNN-*.md` under `.dev/`, `<!-- handoff n=… -->` in the plan file, logs `handoff-requested` → `handoff-written` → `messages-cleared` / `continuation-injected` (each once per plugin handoff). WP-2 artifact if the prompt asks for one. Process exits 0.

Or: `npm run smoke` (temp project; requires exit 0, `done-wp2.txt` with `ok`, `continuation-injected`, and `messages-cleared` == `handoff-written`; report at `.dev/spike-evidence/smoke-report.json`).

### C — Metering

From `message.updated` / `step_finish` JSON, compare `input + cache.read + cache.write` on the assistant message **after** clear vs the last message **before**. Conversation tokens should drop; system cache (~8k on zen free models) remains. Do not use `tokens.total`.

### D — Relay identity

Same `opencode run` invocation: plugin init `pid` equals the opencode PID; `sessionID` in `session.created` equals later `session.prompt` / events. Process exits 0 and prints a result. Do not start a second `opencode` process.

### E — Archive

```bash
/opt/homebrew/bin/opencode export <sessionID> | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["messages"]))'
```

Count should include pre-handoff messages. Clearing must not `DELETE` them.

Restore `contextThreshold` / `minTurnsBetweenHandoffs` after the test.
