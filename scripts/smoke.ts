#!/usr/bin/env node
/**
 * e2e smoke: threshold + WP-1 flip must produce a real continuation that
 * finishes WP-2 and exits 0. A handoff file alone is not success (F3).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const opencode = process.env.OPENCODE_BIN ?? "/opt/homebrew/bin/opencode"
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const smokeDir = join(root, ".smoke", stamp)
const planFile = join(smokeDir, "plan.md")
const handoffDir = join(smokeDir, "handoff")
const doneFile = join(smokeDir, "done-wp2.txt")
const plugin = join(root, "src/index.ts")

function write(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

function countLog(text: string, name: string): number {
  const patterns = [
    new RegExp(`message=${name}(?:\\s|$)`, "g"),
    new RegExp(`message="${name}"`, "g"),
  ]
  let n = 0
  for (const re of patterns) {
    n = Math.max(n, (text.match(re) ?? []).length)
  }
  return n
}

mkdirSync(handoffDir, { recursive: true })
write(
  planFile,
  `# Smoke plan

- [ ] **WP-1** Fake package to complete during this run
- [ ] **WP-2** Create done-wp2.txt containing exactly ok

<!-- handoffs -->
`,
)

const overlay = join(smokeDir, "opencode.json")
write(
  overlay,
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: process.env.OPENCODE_SMOKE_MODEL ?? "opencode/mimo-v2.5-free",
      permission: { "*": "allow" },
      plugin: [
        [
          plugin,
          {
            enabled: true,
            contextThreshold: 0.0001,
            hardCeiling: 0.99,
            minTurnsBetweenHandoffs: 0,
            handoffDir,
            planFile,
            logging: true,
            handoffTimeoutMs: 60000,
          },
        ],
      ],
    },
    null,
    2,
  ),
)

const prompt = `Working directory is ${root}. Only edit these smoke files:

Plan file (absolute): ${planFile}
Handoff directory (absolute): ${handoffDir}
WP-2 output file (absolute): ${doneFile}

Steps:
1. Edit the plan file so WP-1 is marked done: \`- [x] **WP-1** Fake package to complete during this run\`
2. After that edit, if you receive handoff instructions, write the handoff markdown to the exact path they specify (it will be under ${handoffDir}), then stop and wait for the continuation user message.
3. After continuation, do WP-2: write ${doneFile} containing exactly the two letters ok and nothing else. Do not mark WP-2 done in the plan.
4. Reply SMOKE_DONE.

Do not edit README, src/, or .opencode/plan. Do not wait for a human. Do not keep re-reading the handoff file in a loop.`

const result = spawnSync(
  opencode,
  [
    "--print-logs",
    "--log-level",
    "INFO",
    "run",
    "--auto",
    "--format",
    "json",
    "--dir",
    root,
    "--title",
    "handoff-smoke",
    prompt,
  ],
  {
    cwd: root,
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      OPENCODE_CONFIG: overlay,
      OPENCODE_CONFIG_CONTENT: readFileSync(overlay, "utf8"),
    },
  },
)

const stderr = result.stderr ?? ""
const files = existsSync(handoffDir) ? readdirSync(handoffDir) : []
const handoffs = files.filter((f) => f.startsWith("handoff-") && f.endsWith(".md"))
const doneBody = existsSync(doneFile) ? readFileSync(doneFile, "utf8") : null
const cleared = countLog(stderr, "messages-cleared")
const injected = countLog(stderr, "continuation-injected")
const requested = countLog(stderr, "handoff-requested")
const written = countLog(stderr, "handoff-written")

const failures: string[] = []
if (result.error) failures.push(`process error: ${String(result.error)}`)
if (result.status !== 0) failures.push(`exit status ${result.status} (want 0)`)
if (handoffs.length < 1) failures.push("no handoff-*.md written")
if (doneBody?.trim() !== "ok") failures.push(`WP-2 file missing or not exactly ok (got ${JSON.stringify(doneBody)})`)
if (injected < 1) failures.push("continuation-injected log missing")
if (requested < 1) failures.push(`handoff-requested count ${requested} (want >= 1)`)
if (written !== requested) failures.push(`handoff-written count ${written} !== handoff-requested ${requested}`)
if (cleared !== written) {
  failures.push(`messages-cleared count ${cleared} !== plugin handoff-written ${written}`)
}
if (cleared > 8) failures.push(`messages-cleared count ${cleared} looks like the per-call loop`)

const report = {
  status: result.status,
  error: result.error ? String(result.error) : null,
  stdoutTail: (result.stdout ?? "").slice(-2000),
  stderrTail: stderr.slice(-4000),
  smokeDir,
  files,
  handoffs,
  doneBody,
  counts: { requested, written, cleared, injected },
  failures,
  plan: existsSync(planFile) ? readFileSync(planFile, "utf8") : null,
}

mkdirSync(join(root, ".smoke-reports"), { recursive: true })
write(join(root, ".smoke-reports/smoke-report.json"), JSON.stringify(report, null, 2))

if (failures.length > 0) {
  console.error(JSON.stringify(report, null, 2))
  process.exit(1)
}

if (process.env.SMOKE_KEEP !== "1") {
  rmSync(join(root, ".smoke"), { recursive: true, force: true })
}

console.log("smoke ok", {
  handoffs: handoffs.join(", "),
  counts: { requested, written, cleared, injected },
})
process.exit(0)
