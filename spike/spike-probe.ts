/**
 * Spike probe for opencode 1.18.25 plugin surface.
 * Writes JSONL evidence under .dev/spike-evidence/. Controlled by env:
 *   SPIKE_CLEAR=1       splice outgoing messages to last 1 on transform
 *   SPIKE_CONTINUE=1    on first idle, prompt the same session
 *   SPIKE_REVERT=1      on first idle, try session.revert to first user message
 *   SPIKE_V2_STAGE=1    on first idle, POST /api/session/{id}/revert/stage files:false
 *   SPIKE_HTTP=1        on init, probe HTTP endpoints (openapi, revert/stage, DELETE message)
 *   SPIKE_LABEL=...     extra tag in log lines
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const EVIDENCE_DIR = join(process.cwd(), ".dev/spike-evidence")
mkdirSync(EVIDENCE_DIR, { recursive: true })

const LOG = join(EVIDENCE_DIR, `probe-${process.env.SPIKE_LABEL ?? "default"}.jsonl`)
const INIT = join(EVIDENCE_DIR, `init-${process.env.SPIKE_LABEL ?? "default"}.json`)

function log(event: string, data: unknown) {
  const line = JSON.stringify({ t: Date.now(), pid: process.pid, event, data }) + "\n"
  appendFileSync(LOG, line)
}

function summarize(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value !== "object") return value
  if (Array.isArray(value)) return { type: "array", length: value.length, sample: value.slice(0, 3).map((v) => summarize(v, depth + 1)) }
  if (depth >= 3) return { type: "object", keys: Object.keys(value as object).slice(0, 40) }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "function") out[k] = "function"
    else if (v && typeof v === "object") out[k] = summarize(v, depth + 1)
    else out[k] = v
  }
  return out
}

function methodNames(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return []
  const names = new Set<string>()
  let current: object | null = obj as object
  while (current && current !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(current)) {
      try {
        if (typeof (current as Record<string, unknown>)[key] === "function") names.add(key)
      } catch {}
    }
    current = Object.getPrototypeOf(current)
  }
  return [...names].sort()
}

async function dumpJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2))
}

export const SpikeProbe = async (ctx: any, options?: Record<string, unknown>) => {
  const ctxKeys = Object.keys(ctx ?? {})
  const clientKeys = methodNames(ctx.client)
  const sessionKeys = methodNames(ctx.client?.session)
  const configKeys = methodNames(ctx.client?.config)
  const appKeys = methodNames(ctx.client?.app)
  const providerKeys = methodNames(ctx.client?.provider)
  const init = {
    label: process.env.SPIKE_LABEL ?? "default",
    pid: process.pid,
    cwd: process.cwd(),
    loadHint: "from .opencode/plugins/spike-probe.ts named export SpikeProbe",
    ctxKeys,
    options: options ?? null,
    directory: ctx.directory,
    worktree: ctx.worktree,
    project: summarize(ctx.project),
    serverUrl: String(ctx.serverUrl ?? ""),
    clientKeys,
    sessionKeys,
    configKeys,
    appKeys,
    providerKeys,
    env: {
      SPIKE_CLEAR: process.env.SPIKE_CLEAR ?? null,
      SPIKE_CONTINUE: process.env.SPIKE_CONTINUE ?? null,
      SPIKE_REVERT: process.env.SPIKE_REVERT ?? null,
      SPIKE_V2_STAGE: process.env.SPIKE_V2_STAGE ?? null,
      SPIKE_HTTP: process.env.SPIKE_HTTP ?? null,
    },
  }
  await dumpJson(INIT, init)
  log("plugin.init", init)

  try {
    await ctx.client.app.log({
      body: {
        service: "spike-probe",
        level: "info",
        message: "spike-probe initialized",
        extra: { label: process.env.SPIKE_LABEL ?? "default", ctxKeys },
      },
    })
  } catch (err) {
    log("plugin.app.log.error", String(err))
  }

  const eventTypes = new Set<string>()
  const usageSamples: unknown[] = []
  const transformCounts: number[] = []
  let idleCount = 0
  let continueFired = false
  let revertFired = false
  let stageFired = false
  let lastSessionID: string | undefined
  let firstUserMessageID: string | undefined
  let lastModel: unknown
  let lastChatParamsInput: unknown

  if (process.env.SPIKE_HTTP === "1") {
    const base = String(ctx.serverUrl ?? "http://127.0.0.1:4096").replace(/\/$/, "")
    const probes = [
      "/doc",
      "/openapi.json",
      "/openapi",
      "/swagger",
      "/session",
    ]
    for (const path of probes) {
      try {
        const res = await fetch(base + path)
        const text = await res.text()
        log("http.probe", {
          path,
          status: res.status,
          contentType: res.headers.get("content-type"),
          bodyPreview: text.slice(0, 400),
        })
      } catch (err) {
        log("http.probe.error", { path, error: String(err) })
      }
    }
  }

  return {
    config: async (cfg: unknown) => {
      const c = cfg as Record<string, unknown>
      log("hook.config", {
        keys: Object.keys(c ?? {}),
        plugin: c?.plugin,
        model: c?.model,
      })
    },
    "chat.params": async (input: any, output: any) => {
      lastSessionID = input?.sessionID
      lastModel = input?.model
      lastChatParamsInput = {
        sessionID: input?.sessionID,
        agent: input?.agent,
        modelKeys: input?.model ? Object.keys(input.model) : [],
        modelLimit: input?.model?.limit,
        modelID: input?.model?.id ?? input?.model?.modelID,
        providerID: input?.model?.providerID ?? input?.provider?.info?.id,
        providerKeys: input?.provider ? Object.keys(input.provider) : [],
        messageRole: input?.message?.role,
        outputKeys: output ? Object.keys(output) : [],
      }
      log("hook.chat.params", lastChatParamsInput)
    },
    "chat.message": async (input: any, output: any) => {
      lastSessionID = input?.sessionID
      log("hook.chat.message", {
        sessionID: input?.sessionID,
        agent: input?.agent,
        model: input?.model,
        messageID: input?.messageID,
        partCount: output?.parts?.length,
        partTypes: (output?.parts ?? []).map((p: any) => p?.type),
      })
    },
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      const messages = output?.messages
      if (!Array.isArray(messages)) {
        log("hook.messages.transform.unexpected", { outputKeys: Object.keys(output ?? {}) })
        return
      }
      transformCounts.push(messages.length)
      const summary = messages.map((m: any) => ({
        role: m?.info?.role,
        id: m?.info?.id,
        tokens: m?.info?.tokens,
        partCount: m?.parts?.length,
      }))
      log("hook.messages.transform", {
        count: messages.length,
        summary,
        clear: process.env.SPIKE_CLEAR === "1",
      })
      if (!firstUserMessageID) {
        const firstUser = messages.find((m: any) => m?.info?.role === "user")
        firstUserMessageID = firstUser?.info?.id
      }
      if (process.env.SPIKE_CLEAR === "1" && messages.length > 1) {
        const keep = messages.slice(-1)
        messages.splice(0, messages.length, ...keep)
        log("hook.messages.transform.spliced", { kept: keep.length, keptRole: keep[0]?.info?.role })
      }
    },
    "experimental.chat.system.transform": async (input: any, output: any) => {
      log("hook.system.transform", {
        sessionID: input?.sessionID,
        modelLimit: input?.model?.limit,
        systemCount: Array.isArray(output?.system) ? output.system.length : null,
        systemPreview: Array.isArray(output?.system)
          ? output.system.map((s: string) => String(s).slice(0, 80))
          : null,
      })
    },
    "tool.execute.before": async (input: any) => {
      log("hook.tool.before", { tool: input?.tool, sessionID: input?.sessionID, callID: input?.callID })
    },
    "tool.execute.after": async (input: any) => {
      log("hook.tool.after", { tool: input?.tool, sessionID: input?.sessionID, callID: input?.callID })
    },
    event: async ({ event }: { event: any }) => {
      eventTypes.add(event?.type)
      if (event?.properties?.sessionID) lastSessionID = event.properties.sessionID
      if (event?.properties?.info?.sessionID) lastSessionID = event.properties.info.sessionID

      if (event?.type === "message.updated") {
        const info = event.properties?.info
        if (info?.role === "assistant" && info?.tokens) {
          const contextTokens =
            (info.tokens.input ?? 0) + (info.tokens.cache?.read ?? 0) + (info.tokens.cache?.write ?? 0)
          const sample = {
            sessionID: info.sessionID,
            messageID: info.id,
            modelID: info.modelID,
            providerID: info.providerID,
            tokens: info.tokens,
            contextTokens,
            cost: info.cost,
            time: info.time,
          }
          usageSamples.push(sample)
          log("event.message.updated.usage", sample)
        } else {
          log("event.message.updated", {
            role: info?.role,
            id: info?.id,
            sessionID: info?.sessionID,
            keys: info ? Object.keys(info) : [],
          })
        }
      } else if (event?.type === "session.status" || event?.type === "session.idle") {
        log("event.session-boundary", {
          type: event.type,
          properties: event.properties,
        })
      } else if (
        event?.type === "message.removed" ||
        event?.type === "message.part.removed" ||
        event?.type === "session.compacted"
      ) {
        log("event.removal-or-compact", { type: event.type, properties: event.properties })
      } else {
        log("event.other", {
          type: event.type,
          propKeys: event.properties ? Object.keys(event.properties) : [],
        })
      }

      const isIdle =
        event?.type === "session.idle" ||
        (event?.type === "session.status" && event?.properties?.status?.type === "idle")
      if (!isIdle) return

      idleCount += 1
      const sessionID = event.properties?.sessionID ?? lastSessionID
      log("idle.handler.enter", { idleCount, sessionID, eventType: event.type })

      if (process.env.SPIKE_REVERT === "1" && !revertFired && sessionID) {
        revertFired = true
        try {
          const listed = await ctx.client.session.messages({ path: { id: sessionID } })
          const data = listed?.data ?? listed
          const msgs = Array.isArray(data) ? data : []
          const first = msgs.find((m: any) => m?.info?.role === "user") ?? msgs[0]
          log("spike.revert.messages", {
            count: msgs.length,
            firstID: first?.info?.id,
            ids: msgs.map((m: any) => ({ id: m?.info?.id, role: m?.info?.role })),
          })
          if (first?.info?.id) {
            const result = await ctx.client.session.revert({
              path: { id: sessionID },
              body: { messageID: first.info.id },
            })
            log("spike.revert.result", summarize(result))
          }
        } catch (err) {
          log("spike.revert.error", String(err))
        }
      }

      if (process.env.SPIKE_V2_STAGE === "1" && !stageFired && sessionID) {
        stageFired = true
        const base = String(ctx.serverUrl ?? "").replace(/\/$/, "")
        try {
          const listed = await ctx.client.session.messages({ path: { id: sessionID } })
          const msgs = listed?.data ?? listed
          const list = Array.isArray(msgs) ? msgs : []
          const firstUser = list.find((m: any) => m?.info?.role === "user")
          log("spike.v2stage.pre", {
            v1MessageCount: list.length,
            firstUserID: firstUser?.info?.id,
          })
          const endpoints = [
            `/api/session/${sessionID}/context`,
            `/api/session/${sessionID}/history`,
            `/session/${sessionID}/message`,
          ]
          for (const path of endpoints) {
            const res = await fetch(base + path)
            const text = await res.text()
            log("spike.v2stage.get", { path, status: res.status, preview: text.slice(0, 500), length: text.length })
          }
          if (firstUser?.info?.id) {
            const stageRes = await fetch(base + `/api/session/${sessionID}/revert/stage`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ messageID: firstUser.info.id, files: false }),
            })
            const stageText = await stageRes.text()
            log("spike.v2stage.post", { status: stageRes.status, body: stageText.slice(0, 1500) })
            for (const path of endpoints) {
              const res = await fetch(base + path)
              const text = await res.text()
              log("spike.v2stage.get.after", { path, status: res.status, preview: text.slice(0, 500), length: text.length })
            }
          }
        } catch (err) {
          log("spike.v2stage.error", String(err))
        }
      }

      if (process.env.SPIKE_CONTINUE === "1" && !continueFired && sessionID) {
        continueFired = true
        try {
          log("spike.continue.start", { sessionID, pid: process.pid })
          const result = await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
              noReply: false,
              parts: [{ type: "text", text: "SPIKE_CONTINUE: reply with exactly the word CONTINUED and nothing else." }],
            },
          })
          log("spike.continue.result", summarize(result))
        } catch (err) {
          log("spike.continue.error", String(err))
        }
      }

      writeFileSync(
        join(EVIDENCE_DIR, `summary-${process.env.SPIKE_LABEL ?? "default"}.json`),
        JSON.stringify(
          {
            eventTypes: [...eventTypes].sort(),
            idleCount,
            usageSamples,
            transformCounts,
            lastModel,
            lastChatParamsInput,
            pid: process.pid,
            sessionID,
          },
          null,
          2,
        ),
      )
    },
  }
}
