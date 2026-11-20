import type { AgentFields } from "./agent-verification.js";
import { trafficFields } from "../shared/traffic.js";
const agentNames = ["agent_verification", "agent_operator", "agent_claim"] as const;
const trafficNames = ["traffic_class", "traffic_phase"];
/**
 * Agent label names are reserved, including when verification is off or yields no labels.
 * Only server results may supply them. validateParams gives automatic and standard event fields
 * priority, then these optional labels, then other site parameters. Browser classes are forwarded
 * only with a known value; an invalid one drops the parameter only.
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
        ([key]) => !trafficNames.includes(key) && !(agentNames as readonly string[]).includes(key),
      ),
    ),
  };
}
