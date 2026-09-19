import "dotenv/config";

/**
 * Every environment-derived constant, in one place.
 *
 * Deliberately does NOT throw on a missing API key at import time. A server that
 * refuses to boot without credentials is a server you cannot smoke-test on
 * conference wifi at hour 2. The routes report a clean 503 instead, so
 * `curl /session` still tells you whether the process is alive and the route is
 * wired — which is the question you are actually asking at that point.
 */
export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",

  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",

  /**
   * Verified against the GA Realtime docs. The preview interface used
   * POST /v1/realtime/sessions; GA uses POST /v1/realtime/client_secrets and
   * anything older than that in a tutorial points at a deprecated path.
   */
  realtime: {
    model: process.env.REALTIME_MODEL ?? "gpt-realtime-2.1",
    clientSecretsURL: "https://api.openai.com/v1/realtime/client_secrets",
    /** The phone opens this with `Authorization: Bearer <ephemeral token>`. */
    wsURL: "wss://api.openai.com/v1/realtime",
    /** Range 10..7200, API default 600. Short by design — mint per session. */
    ttlSeconds: Number(process.env.REALTIME_TOKEN_TTL_SECONDS ?? 600),
  },

  /**
   * The style planner. Off the critical path: 2-3s is fine because a "thinking"
   * animation covers it. Effort is held low for that reason, not to save money.
   */
  planner: {
    model: "claude-opus-5",
    maxOps: 12,
  },
} as const;

export function missingKeyResponse(which: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY") {
  return {
    error: "not_configured",
    message: `${which} is not set. Copy server/.env.example to server/.env and fill it in.`,
  };
}
