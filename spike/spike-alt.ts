import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const dir = join(process.cwd(), ".spike-evidence")
mkdirSync(dir, { recursive: true })
const logPath = join(dir, "alt-dir-load.jsonl")

export const SpikeAlt = async (ctx: any) => {
  appendFileSync(
    logPath,
    JSON.stringify({
      t: Date.now(),
      pid: process.pid,
      loadedFrom: ".opencode/plugin/spike-alt.ts",
      ctxKeys: Object.keys(ctx ?? {}),
      directory: ctx.directory,
    }) + "\n",
  )
  return {}
}
