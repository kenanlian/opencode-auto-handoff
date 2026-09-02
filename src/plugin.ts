import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { parseConfig, type PluginConfig } from "./config.ts"
import {
  createCycle,
  decideIdle,
  decideTransform,
  injectHandoffSystem,
  markWritten,
  noteClearedLogged,
  noteContinuationPrompted,
  noteCursor,
  noteFirstClear,
  notePersisted,
  requestHandoff as cycleRequest,
  type HandoffCycle,
} from "./cycle.ts"
import { createLogger, type Logger } from "./log.ts"
import { applyClear, applyFilterSince, idsOf, spliceSystem, type TransformMessage } from "./messages.ts"
import { appendHandoffMarker, nextIncomplete, newlyCompleted, parsePlan, type PlanSnapshot } from "./plan.ts"
import { evaluateTrigger, initialState, reduce, type MachineState, type TriggerReason } from "./machine.ts"
import { bundledContinuationPrompt, bundledHandoffPrompt, loadText, render } from "./templates.ts"
import { contextTokens, hasAuthoritativeUsage, occupancy, type TokenUsage } from "./usage.ts"

type PendingHandoff = {
  path: string
  number: number
  reason: TriggerReason
  startedAt: number
  attempt: number
}

type Runtime = {
  cfg: PluginConfig
  directory: string
  log: Logger
  state: MachineState
  cycle: HandoffCycle
  sessionID?: string
  limit: number
  limitWarned: boolean
  lastUsage: TokenUsage | null
  lastRatio: number
  inFlightTools: number
  plan: PlanSnapshot | null
  pending: PendingHandoff | null
  injecting: boolean
  handoffPrompt: string
  continuationTemplate: string
}

function abs(directory: string, p: string): string {
  return resolve(directory, p)
}

function readPlan(cfg: PluginConfig, directory: string): PlanSnapshot | null {
  const file = abs(directory, cfg.planFile)
  if (!existsSync(file)) return null
  return parsePlan(readFileSync(file, "utf8"))
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-")
}

function nextHandoffPath(cfg: PluginConfig, directory: string, n: number): string {
  const dir = abs(directory, cfg.handoffDir)
  mkdirSync(dir, { recursive: true })
  return join(dir, `handoff-${String(n).padStart(3, "0")}-${stamp()}.md`)
}

function loadPrompts(cfg: PluginConfig, directory: string): { handoff: string; continuation: string } {
  const handoff = cfg.handoffPromptFile
    ? loadText(abs(directory, cfg.handoffPromptFile), "handoff-prompt.md")
    : bundledHandoffPrompt()
  const continuation = cfg.continuationPrompt
    ? cfg.continuationPrompt
    : cfg.continuationPromptFile
      ? loadText(abs(directory, cfg.continuationPromptFile), "continuation-prompt.md")
      : bundledContinuationPrompt()
  return { handoff, continuation }
}

function handoffVars(rt: Runtime, pending: PendingHandoff): Record<string, string> {
  const hard =
    pending.reason === "hard-ceiling"
      ? "HARD CEILING: finish the current WP, persist plan/state to disk, then write this handoff. Do not start new WPs."
      : ""
  return {
    handoffPath: pending.path,
    planFile: rt.cfg.planFile,
    handoffNumber: String(pending.number),
    timestamp: new Date(pending.startedAt).toISOString(),
    reason: pending.reason,
    hardCeilingNote: hard,
  }
}

function markPlan(rt: Runtime, pending: PendingHandoff): void {
  const file = abs(rt.directory, rt.cfg.planFile)
  if (!existsSync(file)) return
  const next = appendHandoffMarker(readFileSync(file, "utf8"), {
    n: pending.number,
    file: pending.path,
    ts: new Date(pending.startedAt).toISOString(),
  })
  writeFileSync(file, next)
}

function continuationFor(rt: Runtime, pending: PendingHandoff): string {
  const next = readPlan(rt.cfg, rt.directory)
  return render(rt.continuationTemplate, {
    handoffPath: pending.path,
    planFile: rt.cfg.planFile,
    nextWp: nextIncomplete(next ?? { packages: [], handoffCount: 0 })?.id ?? "next incomplete WP",
  })
}

function requestHandoff(rt: Runtime, reason: TriggerReason): void {
  const plan = readPlan(rt.cfg, rt.directory)
  const n = (plan?.handoffCount ?? rt.state.lastHandoffNumber) + 1
  if (!cycleRequest(rt.cycle, n)) return
  const path = nextHandoffPath(rt.cfg, rt.directory, n)
  rt.pending = { path, number: n, reason, startedAt: Date.now(), attempt: 1 }
  rt.state = reduce(rt.state, { type: "request-handoff", reason })
  rt.log.log("info", "handoff-requested", {
    phase: rt.state.phase,
    reason,
    path,
    number: n,
    ratio: rt.lastRatio,
    sessionID: rt.sessionID,
  })
}

function verifyHandoffFile(rt: Runtime): boolean {
  if (!rt.pending) return false
  if (!existsSync(rt.pending.path)) return false
  const body = readFileSync(rt.pending.path, "utf8").trim()
  return body.length > 40
}

async function lastUserId(client: any, sessionID: string): Promise<string | undefined> {
  const listed = await client.session.messages({ path: { id: sessionID } })
  const msgs = listed?.data ?? listed
  if (!Array.isArray(msgs)) return undefined
  const lastUser = [...msgs].reverse().find((m: { info?: { role?: string; id?: string } }) => m.info?.role === "user")
  return lastUser?.info?.id
}

async function runIdlePlan(rt: Runtime, client: any, sessionID: string): Promise<void> {
  if (rt.injecting) return
  const plan = decideIdle(rt.cycle)
  if (plan.kind === "none") return
  rt.injecting = true
  try {
    if (plan.kind === "prompt-continuation") {
      rt.state = reduce(rt.state, { type: "cleared" })
      rt.log.log("info", "clearing", { sessionID, via: "session.prompt" })
      rt.log.log("info", "messages-cleared", { kept: 1, mode: "prompt" })
      noteClearedLogged(rt.cycle)
      rt.log.log("info", "continuation-injected", { sessionID, via: "prompt" })
      try {
        await client.session.prompt({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: plan.continuationText }] },
        })
        const id = await lastUserId(client, sessionID)
        if (id) noteContinuationPrompted(rt.cycle, id)
        else notePersisted(rt.cycle)
        rt.state = reduce(rt.state, { type: "continuation-injected" })
        rt.pending = null
      } catch (err) {
        rt.log.log("warn", "continuation-prompt-failed-using-transform", { error: String(err) })
      }
      return
    }
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: { noReply: true, parts: [{ type: "text", text: plan.continuationText }] },
      })
      const id = await lastUserId(client, sessionID)
      if (id) noteContinuationPrompted(rt.cycle, id)
      else notePersisted(rt.cycle)
      rt.state = reduce(rt.state, { type: "continuation-injected" })
      rt.pending = null
      rt.log.log("info", "continuation-injected", { sessionID, keepFromId: rt.cycle.keepFromId, via: "noreply" })
    } catch (err) {
      rt.log.log("warn", "continuation-prompt-failed-using-transform", { error: String(err) })
    }
  } finally {
    rt.injecting = false
  }
}

function onHandoffVerified(rt: Runtime): void {
  if (!rt.pending) return
  const cont = continuationFor(rt, rt.pending)
  if (!markWritten(rt.cycle, rt.pending.number, cont)) return
  markPlan(rt, rt.pending)
  rt.lastRatio = 0
  rt.lastUsage = null
  rt.state = reduce(rt.state, { type: "handoff-written" })
  rt.log.log("info", "handoff-written", { path: rt.pending.path, number: rt.pending.number })
}

function maybeTimeout(rt: Runtime, now: number): void {
  if (!rt.pending || rt.state.phase !== "handoff-requested") return
  if (now - rt.pending.startedAt < rt.cfg.handoffTimeoutMs) return
  if (rt.pending.attempt < 2) {
    rt.pending.attempt += 1
    rt.pending.startedAt = now
    rt.state = reduce(rt.state, { type: "handoff-retry" })
    rt.log.log("warn", "handoff-retry", { attempt: rt.pending.attempt, path: rt.pending.path })
    return
  }
  rt.log.log("error", "handoff-give-up", { path: rt.pending.path, attempts: rt.pending.attempt })
  rt.pending = null
  rt.state = reduce(rt.state, { type: "handoff-give-up" })
}

function considerTrigger(rt: Runtime): void {
  if (rt.inFlightTools > 0) return
  if (rt.pending) {
    if (verifyHandoffFile(rt)) onHandoffVerified(rt)
    else maybeTimeout(rt, Date.now())
    return
  }
  const plan = readPlan(rt.cfg, rt.directory)
  const newly = newlyCompleted(rt.plan, plan ?? { packages: [], handoffCount: 0 })
  rt.plan = plan
  const reason = evaluateTrigger({
    enabled: rt.cfg.enabled,
    ratio: rt.lastRatio,
    threshold: rt.cfg.contextThreshold,
    hardCeiling: rt.cfg.hardCeiling,
    wpBoundary: newly.length > 0,
    turnsSinceHandoff: rt.state.turnsSinceHandoff,
    minTurnsBetweenHandoffs: rt.cfg.minTurnsBetweenHandoffs,
    phase: rt.state.phase,
  })
  if (!reason) return
  requestHandoff(rt, reason)
}

export function createPlugin(): Plugin {
  const plugin: Plugin = async (ctx, options) => {
    const cfg = parseConfig(options as Record<string, unknown> | undefined)
    const prompts = loadPrompts(cfg, ctx.directory)
    const rt: Runtime = {
      cfg,
      directory: ctx.directory,
      log: createLogger({
        enabled: cfg.logging,
        write: (level, message, extra) => {
          void ctx.client.app.log({
            body: {
              service: "opencode-auto-handoff",
              level: level === "debug" ? "debug" : level === "warn" ? "warn" : level === "error" ? "error" : "info",
              message,
              extra: extra ?? {},
            },
          })
        },
      }),
      state: initialState(),
      cycle: createCycle(),
      limit: cfg.assumedContextLimit,
      limitWarned: false,
      lastUsage: null,
      lastRatio: 0,
      inFlightTools: 0,
      plan: readPlan(cfg, ctx.directory),
      pending: null,
      injecting: false,
      handoffPrompt: prompts.handoff,
      continuationTemplate: prompts.continuation,
    }
    rt.state = reduce(rt.state, { type: "start-monitoring" })
    rt.log.log("info", "plugin-loaded", {
      enabled: cfg.enabled,
      contextThreshold: cfg.contextThreshold,
      hardCeiling: cfg.hardCeiling,
      handoffDir: cfg.handoffDir,
      planFile: cfg.planFile,
    })

    let idleLock = false
    const onIdle = async (sessionID: string) => {
      if (idleLock) return
      idleLock = true
      try {
        rt.sessionID = sessionID
        considerTrigger(rt)
        if (rt.state.phase === "handoff-requested" && rt.pending && rt.inFlightTools === 0) {
          try {
            await ctx.client.session.prompt({
              path: { id: sessionID },
              body: { parts: [{ type: "text", text: render(rt.handoffPrompt, handoffVars(rt, rt.pending)) }] },
            })
          } catch (err) {
            rt.log.log("warn", "handoff-prompt-failed", { error: String(err) })
          }
        }
        await runIdlePlan(rt, ctx.client, sessionID)
      } finally {
        idleLock = false
      }
    }

    return {
      config: async (input) => {
        const pluginField = (input as { plugin?: unknown }).plugin
        rt.log.log("debug", "config-hook", { plugin: pluginField ?? null })
      },
      "chat.params": async (input) => {
        rt.sessionID = input.sessionID
        const limit = (input.model as { limit?: { context?: number } } | undefined)?.limit?.context
        if (typeof limit === "number" && limit > 0) {
          rt.limit = limit
        } else if (!rt.limitWarned) {
          rt.limitWarned = true
          rt.log.log("warn", "assumed-context-limit", { assumedContextLimit: rt.cfg.assumedContextLimit })
        }
        considerTrigger(rt)
      },
      "chat.message": async (input) => {
        rt.sessionID = input.sessionID
      },
      "experimental.chat.messages.transform": async (_input, output) => {
        considerTrigger(rt)
        const messages = (output as { messages?: TransformMessage[] }).messages
        if (!Array.isArray(messages)) return
        const plan = decideTransform(rt.cycle)
        if (plan.kind === "none") return
        if (plan.kind === "first-clear") {
          const before = idsOf(messages)
          const result = applyClear(messages, { replacementText: plan.continuationText })
          noteFirstClear(rt.cycle, before)
          rt.state = reduce(rt.state, { type: "cleared" })
          if (plan.logCleared) {
            rt.log.log("info", "clearing", { sessionID: rt.sessionID, mode: result.mode })
            rt.log.log("info", "messages-cleared", result)
          }
          return
        }
        if (plan.kind === "filter-since") {
          applyFilterSince(messages, plan.preClearIds, plan.continuationText)
          return
        }
        const result = applyClear(messages, { keepFromId: plan.keepFromId })
        if (plan.logCleared) {
          noteClearedLogged(rt.cycle)
          noteCursor(rt.cycle, plan.keepFromId)
          rt.state = reduce(rt.state, { type: "cleared" })
          rt.log.log("info", "clearing", { sessionID: rt.sessionID, keepFromId: plan.keepFromId })
          rt.log.log("info", "messages-cleared", result)
        }
      },
      "experimental.chat.system.transform": async (_input, output) => {
        considerTrigger(rt)
        const system = (output as { system?: string[] }).system
        if (!Array.isArray(system)) return
        if (injectHandoffSystem(rt.cycle) && rt.pending) {
          spliceSystem(system, render(rt.handoffPrompt, handoffVars(rt, rt.pending)))
        }
      },
      "tool.execute.before": async () => {
        rt.inFlightTools += 1
      },
      "tool.execute.after": async () => {
        rt.inFlightTools = Math.max(0, rt.inFlightTools - 1)
        if (rt.pending && verifyHandoffFile(rt)) onHandoffVerified(rt)
      },
      event: async ({ event }) => {
        const type = (event as { type?: string }).type
        const props = (event as { properties?: Record<string, unknown> }).properties ?? {}
        if (type === "message.updated") {
          const info = props.info as {
            sessionID?: string
            role?: string
            tokens?: TokenUsage
            time?: { completed?: number }
          }
          if (info?.sessionID) rt.sessionID = info.sessionID
          if (info?.role === "assistant" && hasAuthoritativeUsage(info.tokens)) {
            rt.lastUsage = info.tokens ?? null
            rt.lastRatio = occupancy(info.tokens, rt.limit)
            if (info.time?.completed) {
              rt.state = reduce(rt.state, { type: "turn-completed" })
            }
            rt.log.log("debug", "usage", {
              contextTokens: contextTokens(info.tokens),
              limit: rt.limit,
              ratio: rt.lastRatio,
            })
          }
        }
        const idle =
          type === "session.idle" ||
          (type === "session.status" && (props.status as { type?: string } | undefined)?.type === "idle")
        if (idle) {
          const sessionID = String(props.sessionID ?? rt.sessionID ?? "")
          if (sessionID) void onIdle(sessionID)
        }
      },
    }
  }
  return plugin
}
