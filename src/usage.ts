export type TokenUsage = {
  input: number
  output: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

export function contextTokens(tokens: TokenUsage | null | undefined): number {
  if (!tokens) return 0
  const read = tokens.cache?.read ?? 0
  const write = tokens.cache?.write ?? 0
  return tokens.input + read + write
}

export function occupancy(tokens: TokenUsage | null | undefined, limit: number): number {
  if (!limit || limit <= 0) return 0
  return contextTokens(tokens) / limit
}

export function hasAuthoritativeUsage(tokens: TokenUsage | null | undefined): boolean {
  if (!tokens) return false
  return contextTokens(tokens) > 0 || (tokens.output ?? 0) > 0
}
