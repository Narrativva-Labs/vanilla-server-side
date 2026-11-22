import { trafficFields } from "../shared/traffic.js";
/**
 * The browser class of the optional Visitor Verdict detector, read when an event is sent.
 * Only a frozen snapshot counts, and only its class, phase and optional page-marker operator
 * (`agent`) are read, so other fields added by a later detector version are ignored. A detector
 * without `agent` gives exactly the class and phase, as before. Anything else, including a getter
 * that throws, gives no parameters and never stops the event.
 */
export function readTraffic(host: object) {
  try {
    const verdict = (host as { __visitorVerdict?: Record<string, unknown> }).__visitorVerdict;
    if (verdict && typeof verdict === "object" && Object.isFrozen(verdict))
      return trafficFields(verdict.class, verdict.phase, verdict.agent);
  } catch {
    // A hostile or broken global is the same as no detector.
  }
  return {};
}
