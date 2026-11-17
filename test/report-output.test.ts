import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
const root = dirname(dirname(fileURLToPath(import.meta.url)))
test("project configuration uses tool-owned paths, not retired companion paths", () => {
  const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"))
  const options = config.plugin.find((entry: unknown[]) => Array.isArray(entry) && entry[0] === "./src/index.ts")[1]
  assert.equal(options.handoffDir ?? ".opencode/handoff", ".opencode/handoff")
  assert.equal(options.planFile ?? ".opencode/plan/active-plan.md", ".opencode/plan/active-plan.md")
})
test("research probes write evidence without recreating a developer directory", () => {
  assert.ok(process.env.TMPDIR)
  const probes: Array<[string, string, string]> = [["json-array-plugin.ts", "JsonArrayProbe", "json-array-load.jsonl"], ["spike-alt.ts", "SpikeAlt", "alt-dir-load.jsonl"], ["spike-probe.ts", "SpikeProbe", "init-default.json"]]
  for (const [file, exported, output] of probes) {
    const cwd: string = mkdtempSync(join(process.env.TMPDIR, "handoff-probe-"))
    try {
      const code = `const m=await import(${JSON.stringify(new URL('../spike/' + file, import.meta.url).href)}); await m[${JSON.stringify(exported)}]({directory:process.cwd(),client:{}})`
      const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { cwd, encoding: "utf8", env: { ...process.env, SPIKE_HTTP: "0", SPIKE_LABEL: "default" } })
      assert.equal(result.status, 0, result.stderr)
      assert.ok(existsSync(join(cwd, ".spike-evidence", output)), `${file} evidence missing`)
      assert.equal(existsSync(join(cwd, ".dev")), false)
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  }
})
test("failed smoke retains its real diagnostic report without recreating .dev", () => {
  assert.ok(process.env.TMPDIR, "TMPDIR is required for isolated tests")
  const fixture = mkdtempSync(join(process.env.TMPDIR, "handoff-report-"))
  try {
    mkdirSync(join(fixture, "scripts")); mkdirSync(join(fixture, "src"))
    writeFileSync(join(fixture, "package.json"), '{"type":"module"}')
    copyFileSync(join(root, "scripts/smoke.ts"), join(fixture, "scripts/smoke.ts"))
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/smoke.ts"], {
      cwd: fixture, encoding: "utf8", env: { ...process.env, OPENCODE_BIN: "/usr/bin/false", PI_BIN: "/usr/bin/false" },
    })
    assert.notEqual(result.status, 0, "a deliberately failing local CLI cannot pass the smoke")
    const reportPath = join(fixture, ".smoke-reports/smoke-report.json")
    assert.ok(existsSync(reportPath), "failed smoke must retain its report outside the retired directory")
    const report = JSON.parse(readFileSync(reportPath, "utf8"))
    assert.equal(report.status, 1); assert.ok(report.failures.length > 0)
    assert.equal(existsSync(join(fixture, ".dev")), false)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
