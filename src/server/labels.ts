import { trafficFields } from "../shared/traffic.js";
import { visitorLabels } from "visitor-verdict-server";
import type { AgentFields } from "./agent-verification.js";

const reserved = new Set([
  "vv_type",
  "vv_detail",
  "agent_verification",
  "agent_operator",
  "agent_purpose",
  "agent_claim",
  "traffic_class",
  "traffic_phase",
]);
type Labels = ReturnType<typeof visitorLabels>;
export type LabelObserver = (labels: Labels, verdict?: AgentFields, browserClass?: string) => void;
const rank: Record<Labels["vv_type"], number> = {
  pending: 0,
  human: 1,
  bot_suspicious: 2,
  agent_unverified: 3,
  bot_automation: 4,
  crawler_verified: 5,
  agent_verified: 5,
  bot_spoofed: 6,
};
/** Bounded, memory-only evidence per session (or denied page), never per IP. */
export function createLabelMemory(capacity = 10000, ttlMs = 30 * 60 * 1000, now = Date.now) {
  const sessions = new Map<string, { type: Labels["vv_type"]; operator: string; at: number }>();
  return {
    apply(key: string, labels: Labels): Labels {
      const time = now();
      const saved = sessions.get(key);
      const previous = saved && time - saved.at < ttlMs ? saved : undefined;
      const type =
        previous && rank[previous.type] >= rank[labels.vv_type] ? previous.type : labels.vv_type;
      const detail = labels.vv_detail.split("|");
      const operator = detail[0] !== "none" ? detail[0]! : (previous?.operator ?? "none");
      detail[0] = operator;
      // Operator segments validated by visitorLabels; replacing none cannot exceed its limit.
      const vv_detail = detail.join("|");
      if (vv_detail.length > 100) throw new RangeError("vv_detail exceeds 100 characters");
      sessions.delete(key);
      sessions.set(key, { type, operator, at: time });
      while (sessions.size > capacity) sessions.delete(sessions.keys().next().value!);
      return { vv_type: type, vv_detail };
    },
    sweep() {
      const time = now();
      for (const [key, value] of sessions) {
        if (time - value.at < ttlMs) break;
        sessions.delete(key);
      }
    },
    clear() {
      sessions.clear();
    },
    get size() {
      return sessions.size;
    },
  };
}
export type LabelMemory = ReturnType<typeof createLabelMemory>;
/** Only the two server-derived labels leave the collector; old and new names are reserved. */
export function withLabels(
  params: Record<string, unknown>,
  verdict?: AgentFields,
  sticky?: { memory: LabelMemory; key: string },
  observe?: LabelObserver,
): Record<string, unknown> {
  const browser = trafficFields(params.traffic_class, params.traffic_phase);
  let labels = visitorLabels({
    verdict,
    browserClass: browser.traffic_class,
    browserPhase: browser.traffic_phase,
  });
  if (sticky) labels = sticky.memory.apply(sticky.key, labels);
  observe?.(labels, verdict, browser.traffic_class);
  return {
    ...labels,
    ...Object.fromEntries(Object.entries(params).filter(([key]) => !reserved.has(key))),
  };
}
