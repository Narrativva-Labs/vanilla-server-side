import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { TrackingEvent } from "../shared/event.js";
const runtimeTraffic = new Set([
  "traffic_class",
  "traffic_phase",
  "traffic_agent",
  "traffic_agent_claim",
]);
/** Stable JSON ordering; only ordinary events receive changing runtime traffic fields. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function retryFingerprint(
  event: TrackingEvent,
  req: Pick<FastifyRequest, "headers" | "ip" | "method" | "url">,
) {
  const names = new Set(["user-agent"]);
  for (const name of Object.keys(req.headers)) if (name.startsWith("signature")) names.add(name);
  // A changed covered header must miss the cache even if normally volatile (e.g. a signed cookie).
  const input = req.headers["signature-input"];
  for (const group of String(input ?? "").matchAll(/\(([^)]*)\)/g))
    for (const component of group[1]!.matchAll(/"([^"\\]+)"/g))
      if (!component[1]!.startsWith("@")) names.add(component[1]!.toLowerCase());
  const params =
    event.name === "traffic_class"
      ? event.params
      : Object.fromEntries(
          Object.entries(event.params).filter(([key]) => !runtimeTraffic.has(key)),
        );
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical([
          { ...event, params },
          req.ip,
          req.method,
          req.url,
          [...names].sort().map((name) => [name, req.headers[name]]),
        ]),
      ),
    )
    .digest("hex");
}
