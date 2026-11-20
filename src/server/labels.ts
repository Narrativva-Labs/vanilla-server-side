import type { AgentFields } from "./agent-verification.js";
import { trafficFields } from "../shared/traffic.js";
const agentNames = ["agent_verification", "agent_operator", "agent_claim"] as const;
const trafficNames = ["traffic_class", "traffic_phase"];
/**
 * Labels come before the site's own parameters, so the 25-parameter limit, which counts the
 * automatic fields first, never drops them: agent_verification, agent_operator, agent_claim,
 * traffic_class, traffic_phase, then site parameters in their order. Server labels replace
 * client values of the same names when verification ran. Browser classes are forwarded only
 * with a known value, independently of verification; an invalid one drops the parameter only.
 */
export function withLabels(
  params: Record<string, unknown>,
  fields?: Partial<AgentFields>,
): Record<string, unknown> {
  const agent: Record<string, unknown> = {};
  if (fields !== undefined)
    for (const name of agentNames) if (fields[name] !== undefined) agent[name] = fields[name];
  return {
    ...agent,
    ...trafficFields(params.traffic_class, params.traffic_phase),
    ...Object.fromEntries(
      Object.entries(params).filter(
        ([key]) =>
          !trafficNames.includes(key) &&
          (fields === undefined || !(agentNames as readonly string[]).includes(key)),
      ),
    ),
  };
}
