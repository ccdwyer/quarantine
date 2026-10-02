// One quarantined tool result: where it came from and how many lines were defanged.
export type Hit = { source: string; lines: number; reasons: string[] }

declare module 'claude-code' {
  interface PluginState {
    quarantine: {
      // tool_use_id -> source label, for calls whose output is untrusted.
      pending: Record<string, string>
      // Files untrusted commands wrote; later reads of them stay quarantined.
      tainted: string[]
      hits: Hit[]
      results: number
      lines: number
      strict: boolean
    }
  }
}
