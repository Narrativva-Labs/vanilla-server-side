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
const DEADLINE_MS = 300;
// Key directories and IP lists load in the background; a slow operator endpoint (about 0.9 s
// from a European VPS for chatgpt.com) must not be aborted by the per-hit deadline.
const FETCH_TIMEOUT_MS = 3000;
const names = ["agent_claim", "agent_verification", "agent_operator"];

export function createAgentLabeller(host: string | undefined, options: AgentVerifierOptions) {
  if (!host) throw new Error("Set TRACKER_DOMAIN to the external tracker host");
  const verifier = createVerifier({
    ...options,
    registry: defaultRegistry,
    authorities: [host],
    reverseDns: { enabled: false },
    deadlineMs: DEADLINE_MS,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
  });
  return async (req: FastifyRequest): Promise<Partial<AgentFields>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Also bound unexpected library failures or a verifier that never settles.
      return await Promise.race([
        Promise.resolve().then(async () => {
          const verdict = await verifier.verify({
            method: req.method,
            host,
            headers: req.raw.rawHeaders,
            clientIp: req.ip,
            target: req.url,
          });
          if (
            ["internal_error", "deadline_exceeded", "ip_evidence_unavailable"].includes(
              verdict.reason,
            ) ||
            verdict.reason.startsWith("directory_")
          )
            return {};
          return toAnalyticsFields(verdict);
        }),
        new Promise<Partial<AgentFields>>((resolve) => {
          timer = setTimeout(() => resolve({}), DEADLINE_MS);
        }),
      ]);
    } catch {
      return {};
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Keep server labels ahead of custom parameters, inside the existing 25-field limit. */
export function withAgentFields(
  params: Record<string, unknown>,
  fields?: Partial<AgentFields>,
): Record<string, unknown> {
  if (fields === undefined) return params;
  return {
    ...fields,
    ...Object.fromEntries(Object.entries(params).filter(([key]) => !names.includes(key))),
  };
}
