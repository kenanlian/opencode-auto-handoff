# Spike report: opencode-auto-handoff on 1.18.25

> Historical evidence: `.dev` paths and option values below describe the original experiment only, not current setup. Do not recreate that alias. Current configuration uses `.opencode/handoff` and `.opencode/plan`; new probe output goes to `.spike-evidence/`, and smoke reports to `.smoke-reports/`. Original logs remain archived externally.

**Date:** 2026-09-02  
**Host binary:** `/opt/homebrew/bin/opencode` **1.18.25** (Homebrew stable)  
**Probe:** `.opencode/plugins/spike-probe.ts` (named export, later moved to `spike/`)  
**Raw logs:** `.dev/spike-evidence/` (gitignored via `.dev`)

This report is the implementation contract. The plugin architecture below is what shipped.

---

## 1. Plugin load surface

### Conclusions

| Question | Result |
| --- | --- |
| Signature | **V1**: `(ctx, options?) => Promise<hooks>`. Not V2 `Plugin.define`. |
| Auto-load dirs | **Both** `.opencode/plugins/*.{ts,js}` **and** `.opencode/plugin/*.{ts,js}` (glob `{plugin,plugins}` under every discovered `.opencode` / config dir). |
| `opencode.json` key | **`plugin`** (singular). Spec is `string \| [string, options]`. |
| Options delivery | Tuple form `["./path.ts", { ... }]` → second argument of the plugin function. Directory-auto-loaded files get `options: null`. |
| `opencode run` loads plugins | **Yes.** `--pure` would disable them; we did not use `--pure`. |
| ctx keys | `client`, `project`, `worktree`, `directory`, `experimental_workspace`, `serverUrl`, `$` |
| Preferred export | `export default { id: "…", server }` (PluginModule). Named function exports also load (legacy). Do not export both or the legacy path can double-register. |

### Evidence

**Both directories loaded in one `opencode run`:**

- `.dev/spike-evidence/alt-dir-load.jsonl` — `loadedFrom: ".opencode/plugin/spike-alt.ts"`
- `.dev/spike-evidence/init-load-and-usage.json` — `ctxKeys` as above, `options: null`, `pid` matches the opencode process
- `hook.config` `plugin` field listed both `file:///…/.opencode/plugin/spike-alt.ts` and `file:///…/.opencode/plugins/spike-probe.ts`

**Tuple options** (`opencode.json` `"plugin": [["./spike/json-array-plugin.ts", { "contextThreshold": 0.5, "handoffDir": ".dev" }]]`):

```
{"loadedFrom":"opencode.json plugin array -> ./spike/json-array-plugin.ts","options":{"contextThreshold":0.5,"handoffDir":".dev"}, ...}
```

**`opencode run` log** (`run-load-and-usage.stderr`):

```
message="spike-probe initialized" label=load-and-usage ctxKeys="[\"client\",\"project\",\"worktree\",\"directory\",\"experimental_workspace\",\"serverUrl\",\"$\"]"
message=created id=ses_fa021e25fffehcH3D7FVBYARBa … version=1.18.25
```

**`client.session` methods present on 1.18.25** (from init dump):  
`abort, children, command, create, delete, diff, fork, get, init, list, message, messages, prompt, promptAsync, revert, share, shell, status, summarize, todo, unrevert, unshare, update`

**Not on the V1 SDK client:** `deleteMessage`, `revert.stage`, `revert.clear`. Those exist only as HTTP (see §3).

---

## 2. Context usage visibility

### Conclusions

| Need | 1.18.25 path |
| --- | --- |
| Latest assistant usage | Event `message.updated` → `event.properties.info.tokens` on **assistant** messages. Early events are all-zero; wait until `tokens.input` (or cache) is non-zero **or** `time.completed` is set. |
| Formula | `contextTokens = tokens.input + tokens.cache.read + tokens.cache.write` (matches `packages/opencode/src/acp/usage.ts`). Do **not** use `tokens.total` (includes output). |
| Model context limit | `chat.params` input `model.limit.context` (observed `200000` for `opencode/mimo-v2.5-free`). Fallback: `client.config.providers()` / configured `assumedContextLimit`. |
| `chat.params` cannot strip history | Output keys are only `temperature, topP, topK, maxOutputTokens, options`. |

### Evidence

From `summary-load-and-usage.json` / probe JSONL:

```
message.updated tokens: { total: 8156, input: 6338, output: 26, reasoning: 0, cache: { write: 0, read: 1792 } }
computed contextTokens: 8130   // 6338+1792+0, not 8156
model.limit: { context: 200000, output: 32000 }
```

`step_finish` JSON from `opencode run --format json` carries the same token object (useful for humans, not required for the plugin).

---

## 3. Clear-capability reachability (critical)

Tried in priority order.

### (a) Client / HTTP revert family

| API | Exists on 1.18.25? | Usable as “clear active context, keep durable history, keep files”? |
| --- | --- | --- |
| V1 `POST /session/{id}/revert` (`client.session.revert`) | **Yes** | **Partial / unsafe.** After revert-to-first-user-message, the **next** LLM call’s `experimental.chat.messages.transform` saw **1 message** (the new user prompt only) — active projection was cleared. `GET /session/{id}/message` and `opencode export` still listed the old messages. **But** the V1 revert implementation also restores snapshots / `patch` parts (file undo). `files: false` is **not** on this endpoint. Bash-only edits in the spike did not roll back the marker file (`diff: ""`), but `edit`/`write` patch parts **would**. **Rejected as primary.** |
| V2 `POST /api/session/{id}/revert/stage\|clear\|commit` | **Routes exist** (OpenAPI `/doc`, operationIds `v2.session.revert.stage` etc.). Body `{ messageID, files?: boolean }`. | **Not usable on V1 `opencode run` sessions.** `GET /api/session/{id}/context` and `/history` returned empty `{data:[]}`. Staging a real V1 message id returned `MessageNotFoundError`. V2 projection is a different, empty store for these sessions. |
| `DELETE /session/{id}/message/{messageID}` | **Yes** (`session.deleteMessage`). | **Rejected.** Permanently deletes. After deleting the assistant message, `opencode export` had **1** remaining user message. Violates contract 6. |

OpenAPI excerpt (from `GET http://127.0.0.1:4097/doc` against `opencode serve`):

- `POST /session/{sessionID}/revert` — “undoing its effects and restoring the previous state”
- `POST /api/session/{sessionID}/revert/stage` — “Stage or move a reversible session boundary and optionally apply its file changes” (`files` boolean)
- `DELETE /session/{sessionID}/message/{messageID}` — “Permanently delete … without reverting file changes”

Revert-followup evidence (`SPIKE_LABEL=revert-followup`, session `ses_fa01cf2efffeYPxne1VBPlES0w` after V1 revert):

```
hook.messages.transform { count: 1, summary: [{ role: "user", id: "msg_05fe3f2b3001BJOSURsKdyLBtz" }] }
usage: input=64, cache.read=8064, contextTokens=8128
marker file still contained AFTER-REVERT-WRITE
```

### (b) `chat.params` rewriting `messages` / `context`

**Not possible.** The hook cannot see or mutate the message list. Mutation would not persist anyway.

### (c) `message.part.removed` / message-removed APIs

Events `message.removed` and `message.part.removed` are documented and typed; they did **not** fire during normal turns. `DELETE` (above) is the write API and it destroys durable history.

### Selected clear mechanism

**`experimental.chat.messages.transform` in-place splice**, keyed by a plugin-owned cursor (last message id to keep / drop everything before the continuation user message).

Observed behaviour (`SPIKE_CLEAR=1`):

- Hook fires **before every LLM call** with the full durable list (`count` 1, then 2, then 3).
- `output.messages.splice(0, messages.length, ...keep)` **is observed** by the host (must mutate in place; reassignment is a known no-op).
- Splice does **not** persist: the next transform still receives full history. Durable storage untouched. Files untouched.
- Token drop is real for **conversation** tokens. The ~8k cached **system** prompt remains (`cache.read ≈ 8064`). A short session will not show a dramatic `contextTokens` drop; a long task will.

Also usable as a belt: `experimental.chat.system.transform` to inject “ignore prior history, follow handoff file” — does not shrink tokens by itself.

### Degradation (not needed)

(a)(b)(c) as specified: revert is unsafe, params cannot clear, delete destroys archives. Transform **is** viable, so we do **not** take the “instruction-only, lower the threshold” degradation as primary. That instruction can still be injected as a secondary guard.

**Forbidden (confirmed):** TUI `/clear` is `/new` (new session). Session delete / process restart would break PID + `session_id` identity.

---

## 4. Turn-boundary / idle

### Conclusions

Reliable signals on 1.18.25:

1. **`session.status`** with `properties.status.type === "idle"` (also `"busy"`). Fires first.
2. **`session.idle`** `{ sessionID }` immediately after (same millisecond in the probe). Still emitted; treat as duplicate of idle.
3. **Do not interrupt tools:** `tool.execute.before` / `tool.execute.after`. Only evaluate handoff when `inFlightTools === 0`.
4. **Mid-`opencode run` step boundary:** `experimental.chat.messages.transform` / `chat.params` run at the start of each LLM step, after previous tools have finished. This is the important boundary for a one-shot `opencode run` (one user prompt, many tool steps, idle only at the end).

**Debounce:** `session.status` idle and `session.idle` both invoke the `event` hook. The hook is **not awaited** by the host (`void hook.event(...)`). Handlers must be single-flight.

Event types observed in one run:  
`catalog.updated, integration.updated, message.part.delta, message.part.updated, message.updated, plugin.added, reference.updated, session.created, session.diff, session.idle, session.status, session.updated`

---

## 5. Continuation injection

### Conclusions

| Mechanism | Result |
| --- | --- |
| `client.session.prompt({ path: { id }, body: { parts } })` on idle | **Works on the same session_id and same PID.** Nested `path`/`body` (V1 SDK). |
| `opencode run` vs extra prompt | Run’s SSE loop **breaks on first `session.status` idle**, so the continuation is **not** in `run` stdout. The plugin’s `await session.prompt(...)` still completes before the process exits (pending promise keeps Bun alive; `finish()` does not `process.exit`). Hermes watching PID + session_id still sees one process through the extra turn. **Stdout of `run` is only the first turn.** |
| `promptAsync` | Available; not required. |
| Mid-loop continuation | Prefer **not** calling `session.prompt` (SessionBusy during the agent loop). Inject via `experimental.chat.system.transform` + cleared `messages.transform` so the **same** `run` `session.prompt()` HTTP stays open. |

Continue probe (`SPIKE_CONTINUE=1`, session `ses_fa01fa266ffewBCXvWPVPTrq0X`):

```
spike.continue.start { sessionID, pid: 31704 }
spike.continue.result { data: { info: { role: "assistant", sessionID: "ses_fa01fa266ffewBCXvWPVPTrq0X", ... } } }
```

`GET /session/{id}/message` afterwards included a third **user** part (the injected prompt). Same session id throughout.

---

## 6. V2 beta (recorded only, no dual implementation)

V2 docs (`Plugin.define`, `ctx.session.hook`, `ctx.catalog`, `ctx.storage`, `ctx.generate.text`, `POST /api/session/{id}/revert/stage|clear`) are a different plugin API. 1.18.25 already **serves** some `/api/session/...` routes, but they do not see V1 `opencode run` messages. This plugin targets **1.18.x V1 hooks only**.

---

## 7. Selected architecture (locked)

```
idle/monitoring
  → (ratio ≥ threshold ∧ WP just completed) OR (ratio ≥ hardCeiling)
    at a step boundary (transform/params, no in-flight tools) or idle
  → handoff-requested  (inject template; tell model the exact output path)
  → verify file (retry once; else log + return to monitoring, never hang)
  → clearing           (set cursor; splice in messages.transform every call)
  → continuation-injected  (system.transform and/or session.prompt if idle)
  → monitoring
```

- **Usage:** cache last non-zero assistant `tokens`; `contextTokens` formula above; limit from `chat.params` `model.limit.context`.
- **WP state:** parse the configured markdown plan (checkbox list **and** `| ID | Status |` tables). Done-like: `done`, `verified`, `complete`, `x`. Boundary = status transition into done-like since last snapshot.
- **No** V1 `session.revert` (file undo). **No** `DELETE` message (archive loss). **No** new session, **no** process restart.

---

## 8. Commands used

```bash
/opt/homebrew/bin/opencode --version          # 1.18.25
/opt/homebrew/bin/opencode serve --port 4097  # OpenAPI at GET /doc
/opt/homebrew/bin/opencode --print-logs --log-level INFO run --auto --format json --title spike-load "…"
# env SPIKE_LABEL / SPIKE_CLEAR / SPIKE_CONTINUE / SPIKE_REVERT / SPIKE_V2_STAGE
/opt/homebrew/bin/opencode export ses_…
```

Evidence files live under `.dev/spike-evidence/` (`init-*.json`, `probe-*.jsonl`, `summary-*.json`, `run-*.stdout/stderr`, `http/doc.body`).
