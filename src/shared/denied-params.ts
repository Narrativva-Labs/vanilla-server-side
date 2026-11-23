/** Fixed denied-ping payload. Page title remains browser context; no ecommerce item or custom data. */
const allowed = new Set([
  "page_location",
  "page_referrer",
  "page_title",
  "value",
  "currency",
  "traffic_class",
  "traffic_phase",
  "traffic_agent",
  "traffic_agent_claim",
]);
export function deniedParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([key, value]) =>
        allowed.has(key) &&
        (key !== "value" || (typeof value === "number" && Number.isFinite(value))) &&
        (key !== "currency" || (typeof value === "string" && /^[A-Z]{3}$/.test(value))) &&
        (key !== "traffic_agent_claim" || ["dom_marker", "dom_host"].includes(value as string)) &&
        (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))),
    ),
  );
}
