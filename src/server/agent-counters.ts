import type { IncomingHttpHeaders } from "node:http";
import { defaultRegistry, serverAgentTokens } from "visitor-verdict-server";
import type { LabelObserver } from "./labels.js";

const types = [
  "human",
  "pending",
  "agent_verified",
  "agent_unverified",
  "crawler_verified",
  "bot_automation",
  "bot_suspicious",
  "bot_spoofed",
] as const;
const verification = [
  "signature_valid",
  "ip_match",
  "signature_invalid",
  "no_signature",
  "none",
  "cache_miss/unavailable",
] as const;
const claims = serverAgentTokens(defaultRegistry).map(
  (token) =>
    new RegExp(
      "(?:^|[^A-Za-z0-9_-])" +
        token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "(?=$|[^A-Za-z0-9_-])",
      "i",
    ),
);
const zeros = (keys: readonly string[]): Record<string, number> =>
  Object.fromEntries(keys.map((key) => [key, 0]));
const totals = () => ({
  total: 0,
  byType: zeros(types),
  byVerification: zeros(verification),
  evidence: { signatureHeaders: 0, uaClaim: 0, browserNonHuman: 0 },
});
const increment = (counts: Record<string, number>, key: string) => {
  if (Object.hasOwn(counts, key)) counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key]! + 1);
};
/** Fixed-size aggregate state only; a hit observer captures booleans, never request data. */
export function createAgentCounters() {
  const counters = {
    since: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    events: totals(),
    pings: totals(),
  };
  return {
    counters,
    observe(kind: "events" | "pings", headers: IncomingHttpHeaders): LabelObserver {
      const signatureHeaders = ["signature", "signature-input", "signature-agent"].some((name) =>
        Object.hasOwn(headers, name),
      );
      const uaClaim = claims.some((pattern) => pattern.test(headers["user-agent"] ?? ""));
      let counted = false;
      return (labels, verdict, browserClass) => {
        if (counted) return;
        counted = true;
        const counts = counters[kind];
        counts.total = Math.min(Number.MAX_SAFE_INTEGER, counts.total + 1);
        increment(counts.byType, labels.vv_type);
        const unavailable =
          !verdict || /cache_miss|unavailable|timeout|feed_cache_busy/.test(verdict.reason);
        // Successful and invalid proof keep their outcome even if another source was unavailable.
        const outcome =
          unavailable && (!verdict || verdict.verification === "none")
            ? "cache_miss/unavailable"
            : verdict!.verification;
        increment(counts.byVerification, outcome);
        if (signatureHeaders) increment(counts.evidence, "signatureHeaders");
        if (uaClaim) increment(counts.evidence, "uaClaim");
        if (browserClass && browserClass !== "human") increment(counts.evidence, "browserNonHuman");
      };
    },
  };
}
