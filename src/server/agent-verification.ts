import {
  createVerifier,
  defaultRegistry,
  type AgentVerdict,
  type VerifierOptions,
} from "visitor-verdict-server";
import type { FastifyRequest } from "fastify";

export type AgentFields = AgentVerdict;
// Test dependencies are supplied in code, never from the environment or a request.
export type AgentVerifierOptions = Pick<VerifierOptions, "fetcher" | "now">;
// Key directories and IP lists load in the background; a slow operator endpoint (about 0.9 s
// from a European VPS for chatgpt.com) must not be aborted by the per-hit deadline.
const FETCH_TIMEOUT_MS = 3000;
const warnings = new Map<string, number>();
function warnRefresh(host: string, reason: string) {
  const now = Date.now();
  const previous = warnings.get(host);
  if (previous !== undefined && now - previous < 600000) return;
  for (const [name, at] of warnings) if (now - at >= 600000) warnings.delete(name);
  if (!warnings.has(host) && warnings.size >= 128) return;
  warnings.delete(host);
  warnings.set(host, now);
  console.warn(`Agent verification refresh failed for ${host}: ${reason}`);
}

export function createAgentLabeller(host: string | undefined, options: AgentVerifierOptions) {
  if (!host) throw new Error("Set TRACKER_DOMAIN to the external tracker host");
  const verifier = createVerifier({
    ...options,
    registry: defaultRegistry,
    authorities: [host],
    reverseDns: { enabled: false },
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    onRefresh: (event) => {
      if (!event.ok) warnRefresh(host, event.reason ?? "refresh_failed");
    },
  });
  console.info(`Agent verification on for ${host}`);
  try {
    // Fetch the operator key directories now and refresh them shortly before they expire, so the
    // first signed hit and hits during a refresh do not wait for a slow directory. Startup never
    // waits for this; cache misses only start background loads.
    void Promise.resolve(verifier.warm({ refreshAhead: true })).catch(() => {});
  } catch {
    // Warm-up is optional.
  }
  const label = async (req: FastifyRequest): Promise<AgentFields | undefined> => {
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
      return verdict;
    } catch {
      return undefined;
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
  const status = () => {
    const state = verifier.status();
    return {
      enabled: true,
      directoriesLoaded: `${state.directories.loaded}/${state.directories.total}`,
      lastRefreshOk: state.lastRefreshOk,
    };
  };
  return { label, close, status };
}
