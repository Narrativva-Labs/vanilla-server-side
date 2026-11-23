import {
  createVerifier,
  MemoryNonceStore,
  defaultRegistry,
  type AgentVerdict,
  type VerifierOptions,
} from "visitor-verdict-server";
import type { FastifyRequest } from "fastify";

export type AgentFields = AgentVerdict & { obviousBot?: boolean; proofExpiresAt?: number };
// Test dependencies are supplied in code, never from the environment or a request.
export type AgentVerifierOptions = Pick<VerifierOptions, "fetcher" | "now">;
// Key directories and IP lists load in the background; a slow operator endpoint (about 0.9 s
// from a European VPS for chatgpt.com) must not be aborted by the per-hit deadline.
const FETCH_TIMEOUT_MS = 3000;
const warnings = new Map<string, number>();
function warnRefresh(host: string, reason: string) {
  const now = Date.now();
  const previous = warnings.get(host);
  if (previous !== undefined && now >= previous && now - previous < 600000) return;
  for (const [name, at] of warnings) if (now < at || now - at >= 600000) warnings.delete(name);
  if (!warnings.has(host) && warnings.size >= 128) return;
  warnings.delete(host);
  warnings.set(host, now);
  console.warn(`Agent verification refresh failed for ${host}: ${reason}`);
}

export function createAgentLabeller(host: string | undefined, options: AgentVerifierOptions) {
  if (!host) throw new Error("Set TRACKER_DOMAIN to the external tracker host");
  const now = options.now ?? (() => Date.now() / 1000);
  const nonceStore = new MemoryNonceStore(10000, now, 2500);
  const verifier = createVerifier({
    ...options,
    registry: defaultRegistry,
    now,
    nonceStore,
    // ChatGPT agent signatures observed at exactly 3600 s (2026-11-20); keep headroom.
    maxLifetimeSeconds: 7200,
    authorities: [host],
    reverseDns: { enabled: false },
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    onRefresh: (event) => {
      if (!event.ok) warnRefresh(event.hostname || "unknown", event.reason ?? "refresh_failed");
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
          // Preserve original client hints/fetch metadata as well as signed fields.
          headers: req.raw.rawHeaders,
          clientIp: req.ip,
          target: req.url,
        },
        { cacheOnly: true },
      );
      // Anchor IP evidence to verification time, before any wait for session delivery.
      return verdict.verification === "ip_match"
        ? { ...verdict, proofExpiresAt: now() + 30 * 60 }
        : verdict;
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
      replay: nonceStore.status(),
      directoriesLoaded: `${state.directories.loaded}/${state.directories.total}`,
      lastRefreshOk: state.lastRefreshOk,
    };
  };
  return { label, close, status };
}
