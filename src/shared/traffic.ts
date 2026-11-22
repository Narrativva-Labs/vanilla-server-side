/** Visitor Verdict browser classes, phases and page-marker operators; nothing else is forwarded. */
const classes = ["human", "suspicious", "automated", "declared_agent"];
const phases = ["initial", "final", "agent"];
const agents = ["openai", "anthropic"];
/**
 * `traffic_class`, and `traffic_phase` and `traffic_agent` only with a valid class, or nothing.
 * Each value must match its list exactly; an unknown one is dropped on its own.
 */
export function trafficFields(trafficClass: unknown, phase: unknown, agent?: unknown) {
  const fields: Record<string, string> = {};
  if (classes.includes(trafficClass as string)) {
    fields.traffic_class = trafficClass as string;
    if (phases.includes(phase as string)) fields.traffic_phase = phase as string;
    if (agents.includes(agent as string)) fields.traffic_agent = agent as string;
  }
  return fields;
}
