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
export function trafficUpdateFields(params: Record<string, unknown>) {
  const fields = trafficFields(params.traffic_class, params.traffic_phase, params.traffic_agent);
  if (!fields.traffic_class || !["final", "agent"].includes(fields.traffic_phase ?? "")) return;
  if (
    fields.traffic_phase === "agent" &&
    (fields.traffic_class !== "declared_agent" || !fields.traffic_agent)
  )
    return;
  return fields;
}
