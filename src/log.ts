export type Logger = {
  log: (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void
}

export function createLogger(input: {
  enabled: boolean
  write: (level: string, message: string, extra?: Record<string, unknown>) => void
}): Logger {
  return {
    log(level, message, extra) {
      if (!input.enabled && level !== "error") return
      input.write(level, message, extra)
    },
  }
}
