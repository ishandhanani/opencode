/**
 * Global registry for Dynamo session state.
 *
 * Maps OpenCode sessionID -> Dynamo.SessionState so that each session
 * (including subagent sessions) gets its own sticky routing and KV isolation.
 *
 * Lifecycle:
 *   1. create() on first LLM call for a dynamo-backed session
 *   2. get() on each subsequent turn to build nvext
 *   3. close() when the session/subagent completes (marks close, next turn sends action=close)
 *   4. destroy() after the close action has been sent
 */

import { Dynamo } from "./dynamo"
import { Log } from "../util/log"
import { Config } from "../config/config"

const log = Log.create({ service: "dynamo-sessions" })

export namespace DynamoSessionRegistry {
  const sessions = new Map<string, Dynamo.SessionState>()

  export function create(sessionID: string, config?: Partial<Dynamo.NvExtConfig>): Dynamo.SessionState {
    const existing = sessions.get(sessionID)
    if (existing) return existing

    const dynamoSessionId = `opencode-${sessionID}`
    const state = new Dynamo.SessionState(dynamoSessionId, config)
    sessions.set(sessionID, state)
    log.info("created dynamo session", { sessionID, dynamoSessionId })
    return state
  }

  export function get(sessionID: string): Dynamo.SessionState | undefined {
    return sessions.get(sessionID)
  }

  export function getOrCreate(sessionID: string, config?: Partial<Dynamo.NvExtConfig>): Dynamo.SessionState {
    const existing = sessions.get(sessionID)
    if (existing && !existing.isClosed) return existing
    // Closed or missing -- create fresh
    if (existing) sessions.delete(sessionID)
    return create(sessionID, config)
  }

  export async function close(sessionID: string): Promise<void> {
    const state = sessions.get(sessionID)
    if (!state) return
    sessions.delete(sessionID)
    // Send explicit close to Dynamo
    await sendClose(state).catch((e) => {
      log.error("failed to close dynamo session", { sessionID, error: String(e) })
    })
    log.info("closed dynamo session", { sessionID, dynamoSessionId: state.sessionId })
  }

  async function sendClose(state: Dynamo.SessionState): Promise<void> {
    const config = await Config.get()
    const baseURL = config.provider?.["dynamo"]?.options?.baseURL ?? "http://localhost:8000/v1"
    const nvext: Dynamo.NvExt = {
      session_control: {
        session_id: state.sessionId,
        action: "close",
        timeout: 0,
      },
    }
    // Match codex pattern: send a Responses API request with max_output_tokens=0
    // and the close action. The backend sees the close and frees KV.
    const res = await fetch(`${baseURL}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: state.modelId || "unknown",
        input: [],
        max_output_tokens: 0,
        stream: false,
        nvext,
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      log.warn("dynamo close response", { status: res.status })
    }
  }

  export function destroy(sessionID: string): void {
    sessions.delete(sessionID)
    log.info("destroyed dynamo session", { sessionID })
  }

  export function activeCount(): number {
    return sessions.size
  }

  export function closeAll(): void {
    for (const [sessionID, state] of sessions) {
      if (!state.isClosed) {
        state.requestClose()
        log.info("closing dynamo session (shutdown)", { sessionID })
      }
    }
  }
}
