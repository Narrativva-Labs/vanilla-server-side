/** Visitor Verdict browser classes and phases; any other value is never forwarded. */
const classes = ["human", "suspicious", "automated", "declared_agent"];
const phases = ["initial", "final"];
/** `traffic_class`, and `traffic_phase` only with a valid class, or nothing. */
export function trafficFields(trafficClass: unknown, phase: unknown) {
  const fields: Record<string, string> = {};
  if (classes.includes(trafficClass as string)) {
    fields.traffic_class = trafficClass as string;
    if (phases.includes(phase as string)) fields.traffic_phase = phase as string;
  }
  return fields;
}
