export const JsonArrayProbe = async (ctx: any, options?: Record<string, unknown>) => {
  const { appendFileSync, mkdirSync } = await import("node:fs")
  const { join } = await import("node:path")
  const dir = join(process.cwd(), ".spike-evidence")
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    join(dir, "json-array-load.jsonl"),
    JSON.stringify({
      t: Date.now(),
      pid: process.pid,
      loadedFrom: "opencode.json plugin array -> ./spike/json-array-plugin.ts",
      options: options ?? null,
      ctxKeys: Object.keys(ctx ?? {}),
    }) + "\n",
  )
  return {}
}
