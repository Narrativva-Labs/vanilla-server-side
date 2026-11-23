// Frozen Vanilla 0.2.0 echo reader and schema from commit 6379298.
// Generated from src/client/server-verdict.ts + src/shared/verdict.ts; retain for wire compatibility tests.
var LegacyEcho020 = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if ((from && typeof from === "object") || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, {
            get: () => from[key],
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
          });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // <stdin>
  var stdin_exports = {};
  __export(stdin_exports, {
    createVerdictEcho: () => createVerdictEcho,
    serverVerdict: () => serverVerdict,
    verdictOperators: () => verdictOperators,
  });
  var verdictOperators = [
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
  function serverVerdict(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const x = value;
    if (
      x.v !== 1 ||
      !Number.isInteger(x.ttl) ||
      x.ttl < 0 ||
      x.ttl > 1800 ||
      !["agent_verified", "crawler_verified"].includes(x.type) ||
      typeof x.operator !== "string" ||
      x.operator.length > 24 ||
      !verdictOperators.includes(x.operator) ||
      !["signature_valid", "ip_match"].includes(x.verification) ||
      !["user_directed", "crawler", "intermediary", "unknown"].includes(x.purpose) ||
      (x.type === "crawler_verified") !== (x.purpose === "crawler")
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
  var KEY = "vanilla.verdict.v1";
  var TTL = 30 * 60 * 1e3;
  var LIMIT = 1024;
  function createVerdictEcho(host, now = Date.now, layerName) {
    const win = host;
    let published;
    let granted = false;
    let revision = 0;
    function publish(vv) {
      try {
        Object.defineProperty(win, "__visitorVerdictServer", {
          value: Object.freeze({ ...vv }),
          configurable: true,
          writable: false,
        });
        if (vv.type === "crawler_verified") return;
        const claim =
          vv.purpose === "intermediary"
            ? "server_intermediary"
            : vv.verification === "signature_valid"
              ? "server_signature"
              : "server_ip";
        if (
          published?.operator === vv.operator &&
          (published.claim === claim ||
            (published.claim === "server_signature" && claim === "server_ip"))
        )
          return;
        const detector = win.__visitorVerdict;
        if (
          detector?.class === "declared_agent" &&
          detector.agent === vv.operator &&
          detector.claim === claim
        )
          return;
        const name = layerName || win.visitorVerdictConfig?.dataLayerName || "dataLayer";
        if (
          typeof name !== "string" ||
          !name.length ||
          name.length > 128 ||
          ["__proto__", "prototype", "constructor"].includes(name)
        )
          return;
        const layer = (win[name] ??= []);
        if (
          typeof layer.length !== "number" ||
          !Number.isFinite(layer.length) ||
          layer.length < 0 ||
          !Number.isInteger(layer.length) ||
          typeof layer.push !== "function"
        )
          return;
        const event = {
          event: "traffic_class",
          traffic_class: "declared_agent",
          traffic_phase: "agent",
          traffic_agent: vv.operator,
          traffic_agent_claim: claim,
          traffic_score: void 0,
          traffic_signals: void 0,
          traffic_source: "vanilla",
        };
        if (
          typeof detector?.version === "string" &&
          /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(detector.version) &&
          detector.version.length <= 32
        )
          event.traffic_version = detector.version;
        published = { operator: vv.operator, claim };
        layer.push(event);
      } catch {}
    }
    try {
      const raw = win.sessionStorage?.getItem(KEY);
      if (typeof raw === "string" && raw.length <= LIMIT) {
        const saved = JSON.parse(raw);
        const vv = serverVerdict(saved.vv);
        if (
          vv &&
          Number.isFinite(saved.at) &&
          saved.at <= now() &&
          now() - saved.at < Math.min(TTL, vv.ttl * 1e3)
        )
          publish(vv);
      }
    } catch {}
    const receive = async (response, persist = false) => {
      const epoch = revision;
      const receivedAt = now();
      try {
        if (
          response.status !== 200 ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
        )
          return;
        const reader = response.body?.getReader();
        if (!reader) return;
        let size = 0;
        const chunks = [];
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          void reader.cancel().catch(() => {});
        }, 2e3);
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > LIMIT) {
              void reader.cancel().catch(() => {});
              return;
            }
            chunks.push(part.value);
          }
        } finally {
          clearTimeout(timer);
          reader.releaseLock();
        }
        if (timedOut) return;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const vv = serverVerdict(JSON.parse(new TextDecoder().decode(bytes)).vv);
        if (!vv || (persist && (epoch !== revision || !granted))) return;
        if (persist && granted)
          try {
            win.sessionStorage?.setItem(KEY, JSON.stringify({ at: receivedAt, vv }));
          } catch {}
        publish(vv);
      } catch {}
    };
    receive.consent = (value, revoke = false) => {
      if (granted !== value || revoke) revision++;
      granted = value;
      if (revoke) {
        try {
          win.sessionStorage?.removeItem(KEY);
        } catch {}
      }
    };
    return receive;
  }
  return __toCommonJS(stdin_exports);
})();
