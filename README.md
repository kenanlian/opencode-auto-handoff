# opencode-auto-handoff

Development records no longer require a companion-directory link. Smoke diagnostics are retained in `.smoke-reports/smoke-report.json`; temporary smoke work remains in `.smoke/`. Historical records are archived outside this checkout.

OpenCode **1.18.x** plugin that, on long tasks, performs **handoff → drop active model context → continue** while keeping the **same process PID and session id**.

Trigger is **two-sided**: context occupancy must exceed a threshold **and** a work-package (WP) boundary must have just completed. A **hard ceiling** fires even mid-WP (the model is told to finish and persist the current WP first). Occupancy uses the provider’s usage on the latest assistant message, never a character heuristic.

```
contextTokens = tokens.input + tokens.cache.read + tokens.cache.write
ratio         = contextTokens / model.limit.context
```

## Install (local)

This repository is the plugin. Point a project `opencode.json` at `src/index.ts` (OpenCode 1.18.x loads that TypeScript file with Bun):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "./src/index.ts",
      {
        "contextThreshold": 0.5,
        "hardCeiling": 0.75,
        "handoffDir": ".opencode/handoff",
        "planFile": ".opencode/plan/active-plan.md"
      }
    ]
  ]
}
```

Auto-load from `.opencode/plugins/` (or `.opencode/plugin/`) also works, but **options are `null`** for directory-discovered files. Prefer the `plugin` tuple so configuration is explicit.

Requires OpenCode **1.18.x** (verified on **1.18.25**). Not supported on 1.0.x. No V2-beta dual implementation.

```bash
npm test
```

## Configuration

All keys are optional. Defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `contextThreshold` | `0.5` | Soft trigger (needs WP boundary) |
| `hardCeiling` | `0.75` | Always trigger |
| `assumedContextLimit` | `200000` | Used if `chat.params` has no `model.limit.context` (warns once) |
| `handoffDir` | `.opencode/handoff` | Where `handoff-NNN-<timestamp>.md` is written |
| `planFile` | `.opencode/plan/active-plan.md` | WP status markdown |
| `handoffPromptFile` | bundled `templates/handoff-prompt.md` | Handoff instructions sent to the model |
| `continuationPromptFile` | bundled `templates/continuation-prompt.md` | Resume instructions |
| `continuationPrompt` | `""` | Inline continuation override (wins over file) |
| `minTurnsBetweenHandoffs` | `3` | Debounce (completed assistant turns) |
| `logging` | `true` | `client.app.log` structured events |
| `handoffTimeoutMs` | `90000` | Wait for the handoff file; one retry, then give up |

## Work-package file format

Human-readable markdown. The plugin understands:

**Checklists**

```markdown
- [x] **WP-1** Spike
- [~] **WP-2** Implement
- [!] **WP-3** Blocked
- [ ] **WP-4** Later
```

**Status tables** (aligned with `.opencode/plan` execution files)

```markdown
| ID | Status | Notes |
| --- | --- | --- |
| WP-01 | verified | … |
| WP-02 | in-progress | … |
```

Done-like statuses: `done`, `verified`, `complete`, checklist `[x]`.  
A **WP boundary** is a WP whose status **became** done-like since the last snapshot the plugin took.

Handoffs are recorded as HTML comments (and a `## Handoffs` section is created if needed):

```html
<!-- handoff n=1 file=.opencode/handoff/handoff-001-….md ts=2026-09-02T02:00:00.000Z -->
```

## Handoff template

The bundled prompt asks the current model to write a short operational document (goal, WP states, path/commit pointers, interrupt point, next actions, risks) to an **exact path** under `handoffDir`. Replace it with `handoffPromptFile`. Placeholders: `{{handoffPath}}`, `{{planFile}}`, `{{handoffNumber}}`, `{{timestamp}}`, `{{reason}}`, `{{hardCeilingNote}}`.

Continuation placeholders: `{{handoffPath}}`, `{{planFile}}`, `{{nextWp}}`.

## How clearing works (1.18.25)

Spike findings are in [`docs/spike-report.md`](docs/spike-report.md). Summary:

- **Clear once:** after the handoff file is verified, the next LLM call splices conversation history down to a continuation payload (`messages-cleared` once). Later calls in that same turn **keep** messages created after that snapshot so context can grow again (and so the model does not lose its own tool results). Durable history (`GET /session/{id}/message`, `opencode export`) is **not** deleted.
- **Not used:** V1 `session.revert` (can undo `patch` file edits), `DELETE /session/{id}/message` (permanently deletes archives), opening a new session, killing the process.
- **Continue:** same-session `client.session.prompt` when idle (a real user message, visible in `opencode export`). If the model keeps generating in the same turn after the file is verified, the plugin projects that continuation via the splice above so the original `opencode run` prompt can finish; a `noReply` persist then writes the continuation user message for export.
- System prompt / prompt cache (~8k tokens on the free zen models) remains. Conversation tokens drop on the first post-clear call, then rise again as work continues.

## Known limits

- **1.18.x only.** V2 `Plugin.define` / `ctx.session.hook` is a different API.
- V2 HTTP `POST /api/session/{id}/revert/stage` exists on 1.18.25 but does **not** see V1 `opencode run` messages (`MessageNotFoundError`).
- `opencode run` stdout is the **first** user turn. Extra prompts the plugin injects after `session.status` idle complete in-process but are not replayed to `run`’s JSON stream. PID and `session_id` stay the same. `npm run smoke` asserts that this extra turn still finishes WP-2 and the process **exits 0** (a handoff file after `ETIMEDOUT` is a failure).
- Handoff is requested only when **no tool is in flight**.
- If the model does not write the handoff file, the plugin retries once then **gives up** (logs `handoff-give-up`) so the task cannot hang.
- Per handoff, logs fire once in order: `handoff-requested` → `handoff-written` → `clearing` / `messages-cleared` → `continuation-injected`. `messages-cleared` must not repeat on every model call.
- `/clear` in the TUI is `/new` (new session). This plugin does not use it.

## License

Use with your OpenCode installation. No npm publish from this tree unless you choose to later.
