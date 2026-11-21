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
  bot_spoofed: 4.5,
};
/** Bounded, memory-only evidence per session (or denied page), never per IP. */
export function createLabelMemory(capacity = 10000, ttlMs = 30 * 60 * 1000, now = Date.now) {
  const sessions = new Map<
    string,
    { type: Labels["vv_type"]; operator: string; expires: number }
  >();
  return {
    /** With commit=false, preview the label without changing sticky evidence or its expiry. */
    apply(
      key: string,
      labels: Labels,
      commit = true,
      proofExpiresMs?: number,
      isReplay = false,
    ): Labels {
      const time = now();
      const saved = sessions.get(key);
      const previous = saved && time < saved.expires ? saved : undefined;
      if (isReplay && previous && rank[previous.type] === 5) return labels;
      const incomingVerified = rank[labels.vv_type] === 5;
      if (incomingVerified && proofExpiresMs !== undefined && !Number.isFinite(proofExpiresMs))
        return labels;
      // Active verified proof wins over malformed signatures; a later proof can repair spoofed state.
      const inherited = previous && rank[previous.type] > rank[labels.vv_type];
      const type = inherited ? previous.type : labels.vv_type;
      const isVerified = type === "agent_verified" || type === "crawler_verified";
      const expires = inherited
        ? previous.expires
        : Math.min(time + ttlMs, isVerified ? (proofExpiresMs ?? time + ttlMs) : time + ttlMs);
      // Proof can still verify within skew, but cannot be retained beyond signed expiry.
      if (isVerified && !(expires > time)) return labels;
      const detail = labels.vv_detail.split("|");
      const operator = inherited ? previous.operator : detail[0]!;
      detail[0] = operator;
      // Operator segments validated by visitorLabels; replacing none cannot exceed its limit.
      const vv_detail = detail.join("|");
      if (vv_detail.length > 100) throw new RangeError("vv_detail exceeds 100 characters");
      if (type === "pending") return labels;
      if (commit) {
        if (sessions.size >= capacity && !sessions.has(key)) {
          for (const [savedKey, value] of sessions)
            if (!(value.expires > time)) sessions.delete(savedKey);
        }
        sessions.delete(key);
        sessions.set(key, { type, operator, expires });
        while (sessions.size > capacity) sessions.delete(sessions.keys().next().value!);
      }
      return { vv_type: type, vv_detail };
    },
    sweep() {
      const time = now();
      for (const [key, value] of sessions) {
        if (!(value.expires > time)) sessions.delete(key);
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
  const proofExpires = verdict?.proofExpiresAt ?? verdict?.verified?.expiresAt;
  const isReplay =
    verdict?.verification !== "signature_valid" &&
    (verdict?.reason === "replay" ||
      verdict?.signatures.some((s) => s.reason === "replay") === true);
  if (sticky)
    labels = sticky.memory.apply(
      sticky.key,
      labels,
      true,
      proofExpires === undefined ? undefined : proofExpires * 1000,
      isReplay,
    );
  observe?.(labels, verdict, browser.traffic_class);
  return {
    ...labels,
    ...Object.fromEntries(Object.entries(params).filter(([key]) => !reserved.has(key))),
  };
}

/** Independent admission budgets: page churn cannot displace session evidence. */
export function createLabelMemories(capacity = 10000) {
  return { sessions: createLabelMemory(capacity), pages: createLabelMemory(capacity) };
}
