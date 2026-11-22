import { trafficFields, trafficUpdateFields } from "../shared/traffic.js";
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
  "traffic_agent",
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
const verifiedType = (type: Labels["vv_type"]) =>
  type === "agent_verified" || type === "crawler_verified";
const evidenceRank = (type: Labels["vv_type"], purpose: string) =>
  verifiedType(type) && purpose === "intermediary" ? 4.75 : rank[type];
/** Bounded, memory-only evidence per session (or denied page), never per IP. */
export function createLabelMemory(capacity = 10000, ttlMs = 30 * 60 * 1000, now = Date.now) {
  type Entry = {
    key: string;
    type: Labels["vv_type"];
    operator: string;
    purpose: string;
    expires: number;
    index: number;
  };
  const sessions = new Map<string, Entry>();
  // One heap node per retained entry, including renewals and LRU evictions.
  const heap: Entry[] = [];
  const swap = (a: number, b: number) => {
    [heap[a], heap[b]] = [heap[b]!, heap[a]!];
    heap[a]!.index = a;
    heap[b]!.index = b;
  };
  const up = (index: number) => {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent]!.expires <= heap[index]!.expires) break;
      swap(parent, index);
      index = parent;
    }
    return index;
  };
  const remove = (entry: Entry) => {
    const index = entry.index;
    const last = heap.pop()!;
    sessions.delete(entry.key);
    if (index >= heap.length) return;
    heap[index] = last;
    last.index = index;
    let i = up(index);
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < heap.length && heap[child + 1]!.expires < heap[child]!.expires) child++;
      if (heap[i]!.expires <= heap[child]!.expires) break;
      swap(i, child);
      i = child;
    }
  };
  const sweep = (time: number) => {
    while (heap.length && !(heap[0]!.expires > time)) remove(heap[0]!);
  };
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
      if (!Number.isFinite(time)) return labels;
      const saved = sessions.get(key);
      const previous = saved && time < saved.expires ? saved : undefined;
      if (isReplay && previous && verifiedType(previous.type)) return labels;
      const incomingVerified = verifiedType(labels.vv_type);
      const detail = labels.vv_detail.split("|");
      if (incomingVerified && proofExpiresMs !== undefined && !Number.isFinite(proofExpiresMs))
        return labels;
      // Active verified proof wins over malformed signatures; a later proof can repair spoofed state.
      const inherited =
        previous &&
        evidenceRank(previous.type, previous.purpose) > evidenceRank(labels.vv_type, detail[2]!);
      const type = inherited ? previous.type : labels.vv_type;
      const isVerified = verifiedType(type);
      let expires = inherited
        ? previous.expires
        : Math.min(time + ttlMs, isVerified ? (proofExpiresMs ?? time + ttlMs) : time + ttlMs);
      // Proof can still verify within skew, but cannot be retained beyond signed expiry.
      if (!(expires > time)) return labels;
      const operator = inherited ? previous.operator : detail[0]!;
      const purpose = inherited && isVerified ? previous.purpose : detail[2]!;
      if (
        previous &&
        previous.type === type &&
        previous.operator === operator &&
        previous.purpose === purpose
      )
        expires = Math.max(previous.expires, expires);
      detail[0] = operator;
      if (isVerified) detail[2] = purpose;
      // Operator segments validated by visitorLabels; replacing none cannot exceed its limit.
      const vv_detail = detail.join("|");
      if (vv_detail.length > 100) throw new RangeError("vv_detail exceeds 100 characters");
      if (type === "pending") return labels;
      if (commit) {
        sweep(time);
        const existing = sessions.get(key);
        if (existing) remove(existing);
        const entry = { key, type, operator, purpose, expires, index: heap.length };
        sessions.set(key, entry);
        heap.push(entry);
        up(entry.index);
        while (sessions.size > capacity) remove(sessions.values().next().value!);
      }
      return { vv_type: type, vv_detail };
    },
    sweep() {
      const time = now();
      if (Number.isFinite(time)) sweep(time);
    },
    clear() {
      sessions.clear();
      heap.length = 0;
    },
    get size() {
      return sessions.size;
    },
  };
}
export type LabelMemory = ReturnType<typeof createLabelMemory>;
/** Browser fields leave only on the dedicated update; all label names are reserved. */
export function withLabels(
  params: Record<string, unknown>,
  verdict?: AgentFields,
  sticky?: { memory: LabelMemory; key: string },
  observe?: LabelObserver,
  trafficUpdate = false,
): Record<string, unknown> {
  const browser = trafficFields(params.traffic_class, params.traffic_phase, params.traffic_agent);
  const input = {
    verdict,
    browserClass: browser.traffic_class,
    browserPhase: browser.traffic_phase,
  };
  let labels = visitorLabels({ ...input, browserAgent: browser.traffic_agent });
  const own = labels;
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
  if (labels.vv_type !== own.vv_type) {
    // Stronger sticky evidence supplies type and operator, so this hit's page marker no longer
    // names the operator: the claim reverts to the hit's server claim. It is never longer than
    // the 100-character bound (marker hits carry no verified or invalid verification segment).
    const detail = labels.vv_detail.split("|");
    if (detail[3] === "dom_marker") {
      detail[3] = visitorLabels(input).vv_detail.split("|")[3]!;
      labels = { ...labels, vv_detail: detail.join("|") };
    }
  }
  observe?.(labels, verdict, browser.traffic_class);
  return {
    ...labels,
    ...(trafficUpdate
      ? trafficUpdateFields(params)
      : Object.fromEntries(Object.entries(params).filter(([key]) => !reserved.has(key)))),
  };
}

/** Independent admission budgets: page churn cannot displace session evidence. */
export function createLabelMemories(capacity = 10000) {
  return { sessions: createLabelMemory(capacity), pages: createLabelMemory(capacity) };
}
