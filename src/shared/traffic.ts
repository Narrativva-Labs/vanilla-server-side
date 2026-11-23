/** Visitor Verdict browser classes, phases and page-marker operators; nothing else is forwarded. */
const classes = ["human", "suspicious", "automated", "declared_agent"];
const phases = ["initial", "final", "agent"];
const agents = ["openai", "anthropic"];
/**
 * `traffic_class`, and `traffic_phase` only with a valid class, or nothing. `traffic_agent`
 * only with `declared_agent`, the only class the detector reports an operator with.
 * Each value must match its list exactly; an unknown one is dropped on its own.
 */
export function trafficFields(trafficClass: unknown, phase: unknown, agent?: unknown) {
  const fields: Record<string, string> = {};
  if (classes.includes(trafficClass as string)) {
    fields.traffic_class = trafficClass as string;
    if (phases.includes(phase as string)) fields.traffic_phase = phase as string;
    if (trafficClass === "declared_agent" && agents.includes(agent as string))
      fields.traffic_agent = agent as string;
  }
  return fields;
}

/** Dedicated publications require a current phase; legacy detector events remain passive. */
export function trafficUpdateFields(params: unknown) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const input = params as Record<string, unknown>;
  const fields = trafficFields(input.traffic_class, input.traffic_phase, input.traffic_agent);
  if (!fields.traffic_class || !["final", "agent"].includes(fields.traffic_phase ?? "")) return;
  if (
    fields.traffic_phase === "agent" &&
    (fields.traffic_class !== "declared_agent" || !fields.traffic_agent)
  )
    return;
  if (
    fields.traffic_class === "declared_agent" &&
    ["dom_marker", "dom_host"].includes(input.traffic_agent_claim as string)
  )
    fields.traffic_agent_claim = input.traffic_agent_claim as string;
  for (const key of ["page_location", "page_title", "page_referrer"])
    if (typeof input[key] === "string") fields[key] = input[key];
  return fields;
}
