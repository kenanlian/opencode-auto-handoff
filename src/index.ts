import type { Plugin } from "@opencode-ai/plugin"
import { createPlugin } from "./plugin.ts"

const AutoHandoff: Plugin = createPlugin()

export default {
  id: "opencode-auto-handoff",
  server: AutoHandoff,
}
