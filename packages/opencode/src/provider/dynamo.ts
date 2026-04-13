/**
 * Dynamo-specific request extension types.
 *
 * These types mirror the `nvext` payload used by Dynamo-compatible OpenAI-style
 * backends. When injected into a Responses API request body, they enable:
 * - Session control: sticky routing and KV isolation for subagent workloads
 * - Agent hints: priority, expected output length, and speculative prefill
 *
 * Ported from the codex dynamo provider patch.
 */

export namespace Dynamo {
  export interface NvExt {
    session_control?: SessionControl
    agent_hints?: AgentHints
    extra_fields?: string[]
  }

  export interface SessionControl {
    session_id: string
    action?: "open" | "close"
    timeout: number
  }

  export interface AgentHints {
    priority?: number
    osl?: number
    speculative_prefill?: boolean
  }

  export interface NvExtConfig {
    sessionTimeout: number
    extraFields: string[]
  }

  export const defaultConfig: NvExtConfig = {
    sessionTimeout: parseInt(process.env.DYNAMO_SESSION_TIMEOUT ?? "300", 10),
    extraFields: ["worker_id"],
  }

  export class SessionState {
    readonly sessionId: string
    modelId: string = ""
    private firstTurn = true
    private closeRequested = false
    private readonly config: NvExtConfig

    constructor(sessionId: string, config?: Partial<NvExtConfig>) {
      this.sessionId = sessionId
      this.config = { ...defaultConfig, ...config }
    }

    nvextForTurn(): NvExt {
      const action = this.closeRequested
        ? ("close" as const)
        : this.firstTurn
          ? ("open" as const)
          : undefined

      if (this.firstTurn) this.firstTurn = false

      const sessionControl: SessionControl = {
        session_id: this.sessionId,
        timeout: this.config.sessionTimeout,
        ...(action ? { action } : {}),
      }

      return {
        session_control: sessionControl,
        extra_fields: this.config.extraFields.length > 0 ? this.config.extraFields : undefined,
      }
    }

    requestClose(): void {
      this.closeRequested = true
    }

    get isClosed(): boolean {
      return this.closeRequested
    }
  }
}
