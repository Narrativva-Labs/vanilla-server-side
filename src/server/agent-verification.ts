import {
  createVerifier,
  defaultRegistry,
  toAnalyticsFields,
  type VerifierOptions,
} from "visitor-verdict-server";
import type { FastifyRequest } from "fastify";

export type AgentFields = ReturnType<typeof toAnalyticsFields>;
// Test dependencies are supplied in code, never from the environment or a request.
export type AgentVerifierOptions = Pick<VerifierOptions, "fetcher" | "now">;
// Key directories and IP lists load in the background; a slow operator endpoint (about 0.9 s
// from a European VPS for chatgpt.com) must not be aborted by the per-hit deadline.
const FETCH_TIMEOUT_MS = 3000;

export function createAgentLabeller(host: string | undefined, options: AgentVerifierOptions) {
  if (!host) throw new Error("Set TRACKER_DOMAIN to the external tracker host");
  const verifier = createVerifier({
    ...options,
    registry: defaultRegistry,
    authorities: [host],
    reverseDns: { enabled: false },
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
  });
  try {
    // Fetch the operator key directories now and refresh them shortly before they expire, so the
    // first signed hit and hits during a refresh do not wait for a slow directory. Startup never
    // waits for this; cache misses only start background loads. Logs nothing.
    void Promise.resolve(verifier.warm({ refreshAhead: true })).catch(() => {});
  } catch {
    // Warm-up is optional.
  }
  const label = async (req: FastifyRequest): Promise<Partial<AgentFields>> => {
    try {
      const verdict = await verifier.verify(
        {
          method: req.method,
          host,
          headers: req.raw.rawHeaders,
          clientIp: req.ip,
          target: req.url,
        },
        { cacheOnly: true },
      );
      if (
        ["cache_miss", "internal_error", "deadline_exceeded", "ip_evidence_unavailable"].includes(
          verdict.reason,
        ) ||
        verdict.reason.startsWith("directory_")
      )
        return {};
      return toAnalyticsFields(verdict);
    } catch {
      return {};
    }
  };
  /** Stop the background refresh timers; call from the app's onClose hook. */
  const close = () => {
    try {
      verifier.close();
    } catch {
      // Nothing left to stop.
    }
  };
  return { label, close };
}
