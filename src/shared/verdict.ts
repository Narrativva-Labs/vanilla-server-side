/** Wire vocabulary from visitor-verdict-server 0.6.1 defaultRegistry. */
export const verdictOperators = [
  "kimi",
  "commoncrawl",
  "seznam",
  "naver",
  "kagi",
  "baidu",
  "petal",
  "yandex",
  "amazon",
  "amazonads",
  "meta",
  "you",
  "sogou",
  "bytedance",
  "deepseek",
  "zhipu",
  "shenma",
  "qihoo",
  "diffbot",
  "timpi",
  "apple",
  "microsoft",
  "mistral",
  "duckduckgo",
  "openai",
  "google",
  "kernel",
  "cloudflare_browser_run",
  "shopify_cloudsurf",
  "browserbase",
  "manus",
  "anthropic",
  "perplexity",
];
export interface ServerVerdict {
  v: 1;
  ttl: number;
  type: "agent_verified" | "automation_verified" | "crawler_verified";
  operator: string;
  verification: "signature_valid" | "ip_match";
  purpose: "user_directed" | "crawler" | "intermediary" | "unknown";
}
/** Rebuild the value: never retain unknown keys from a response or storage. */
export function serverVerdict(value: unknown): ServerVerdict | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const x = value as ServerVerdict;
  if (
    x.v !== 1 ||
    !Number.isInteger(x.ttl) ||
    x.ttl < 0 ||
    x.ttl > 1800 ||
    !["agent_verified", "automation_verified", "crawler_verified"].includes(x.type) ||
    typeof x.operator !== "string" ||
    x.operator.length > 24 ||
    !verdictOperators.includes(x.operator) ||
    !["signature_valid", "ip_match"].includes(x.verification) ||
    !["user_directed", "crawler", "intermediary", "unknown"].includes(x.purpose) ||
    (x.type === "crawler_verified") !== (x.purpose === "crawler") ||
    (x.type === "automation_verified" && x.purpose !== "intermediary")
  )
    return;
  return {
    v: 1,
    ttl: x.ttl,
    type: x.type,
    operator: x.operator,
    verification: x.verification,
    purpose: x.purpose,
  };
}
