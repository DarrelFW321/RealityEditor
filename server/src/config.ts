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
/**
 * Reads a credential, treating an unedited `.env.example` placeholder as absent.
 *
 * `OPENAI_API_KEY=sk-proj-...` is a non-empty string, so the routes' `!key` guard
 * waved it through and the placeholder itself was sent to OpenAI as a bearer token.
 * OpenAI answered 401, the server turned that into a generic upstream error, and the
 * phone rendered it as "configure the backend API key" — instructing the one person
 * who had already edited the file to edit the file. A placeholder is not a
 * credential; that is decided here, once, instead of being discovered as a 401.
 */
function credential(name: string) {
  const raw = (process.env[name] ?? "").trim();
  return raw.endsWith("...") ? "" : raw;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",

  openaiApiKey: credential("OPENAI_API_KEY"),
  anthropicApiKey: credential("ANTHROPIC_API_KEY"),

  /**
   * Verified against the GA Realtime docs. The preview interface used
   * POST /v1/realtime/sessions; GA uses POST /v1/realtime/client_secrets and
   * anything older than that in a tutorial points at a deprecated path.
   */
  realtime: {
    /**
     * The mini tier of the same generation: $10/$20 per 1M audio tokens against
     * $32/$64 for plain `gpt-realtime-2.1`. This workload is short imperative
     * commands resolved against a spatial context packet the client has ALREADY
     * ranked — the model is not doing the geometry, so the larger tier buys
     * nothing here. Override with REALTIME_MODEL if a session proves otherwise.
     */
    model: process.env.REALTIME_MODEL ?? "gpt-realtime-2.1-mini",
    clientSecretsURL: "https://api.openai.com/v1/realtime/client_secrets",
    /** The phone opens this with `Authorization: Bearer <ephemeral token>`. */
    wsURL: "wss://api.openai.com/v1/realtime",
    /** Range 10..7200, API default 600. Short by design — mint per session. */
    ttlSeconds: Number(process.env.REALTIME_TOKEN_TTL_SECONDS ?? 600),
  },

  /**
   * One-shot frame inpainting for live erasure.
   *
   * No default model id: image model ids move, and an omitted one is an unrecorded
   * experiment. Unset means POST /inpaint reports `not_configured` rather than
   * guessing, and the device falls back to filling from surrounding colour.
   */
  inpaint: {
    /**
     * The local reconstruction worker, which is the preferred path.
     *
     * It segments the object inside the box and fills only those pixels, so what comes
     * back is mask-respecting BY CONSTRUCTION rather than by asking an endpoint nicely
     * — and it costs nothing, leaves no frame of the user's room with a third party,
     * and answers in seconds rather than a minute. Backboard stays behind it as a
     * fallback for deployments with no worker.
     */
    workerURL: process.env.RECONSTRUCTION_WORKER_URL ?? "",
    workerToken: credential("RECONSTRUCTION_WORKER_TOKEN"),
    /** Backboard's own key. Never leaves this process. */
    key: credential("BACKBOARD_API_KEY"),
    baseURL: process.env.BACKBOARD_BASE_URL ?? "https://app.backboard.io/api",
    /** Both required by the image tool; neither has a usable default. */
    imageProvider: process.env.INPAINT_IMAGE_PROVIDER ?? "",
    model: process.env.INPAINT_MODEL ?? "",
    timeoutMs: Number(process.env.INPAINT_TIMEOUT_MS ?? 90_000),
  },

  /**
   * The style planner. Off the critical path: 2-3s is fine because a "thinking"
   * animation covers it. Effort is held low for that reason, not to save money.
   */
  planner: {
    /** Sonnet, not Opus: this emits at most 12 ops against a constrained schema
     * that is re-validated server-side, and it is off the critical path. */
    model: "claude-sonnet-5",
    maxOps: 12,
  },
} as const;

export function missingKeyResponse(which: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY") {
  return {
    error: "not_configured",
    message: `${which} is not set. Copy server/.env.example to server/.env and fill it in.`,
  };
}
