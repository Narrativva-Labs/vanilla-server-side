import { serverVerdict, type ServerVerdict } from "../shared/verdict.js";
const KEY = "vanilla.verdict.v1";
const TTL = 30 * 60 * 1000;
const LIMIT = 1024;
/** Per document publisher; detector snapshot stays untouched. */
export function createVerdictEcho(host: object, now = Date.now, layerName?: string) {
  const win = host as Record<string, unknown> & {
    sessionStorage?: Storage;
    visitorVerdictConfig?: { dataLayerName?: unknown };
    __visitorVerdict?: { class?: unknown; agent?: unknown; claim?: unknown; version?: unknown };
  };
  let published: { operator: string; claim: string } | undefined;
  // Use the original receipt/storage time: weaker responses must never extend this proof.
  let direct: { at: number; expires: number } | undefined;
  const isDirect = (vv: ServerVerdict) =>
    vv.type === "agent_verified" && vv.purpose !== "intermediary";
  function accept(vv: ServerVerdict, at: number) {
    const time = now();
    if (!isDirect(vv) && direct && direct.at <= time && time < direct.expires) return false;
    if (isDirect(vv)) direct = { at, expires: at + Math.min(TTL, vv.ttl * 1000) };
    return true;
  }
  let granted = false;
  let revision = 0;
  function publish(vv: ServerVerdict) {
    try {
      // Separate immutable snapshot, including the most recent identity even after publication.
      Object.defineProperty(win, "__visitorVerdictServer", {
        value: Object.freeze({ ...vv }),
        configurable: true,
        writable: false,
      });
      if (vv.type === "crawler_verified") return;
      const claim =
        vv.type === "automation_verified" || vv.purpose === "intermediary"
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
      const layer = (win[name] ??= []) as {
        length: number;
        push: (...items: unknown[]) => unknown;
      };
      if (
        typeof layer.length !== "number" ||
        !Number.isFinite(layer.length) ||
        layer.length < 0 ||
        !Number.isInteger(layer.length) ||
        typeof layer.push !== "function"
      )
        return;
      const event: Record<string, unknown> = {
        event: "traffic_class",
        traffic_class: "declared_agent",
        traffic_phase: "agent",
        traffic_agent: vv.operator,
        traffic_agent_claim: claim,
        traffic_score: undefined,
        traffic_signals: undefined,
        traffic_source: "vanilla",
      };
      if (
        typeof detector?.version === "string" &&
        /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(detector.version) &&
        detector.version.length <= 32
      )
        event.traffic_version = detector.version;
      published = { operator: vv.operator, claim }; // Before push: GTM and tracker hooks can reenter.
      layer.push(event);
    } catch {
      /* Optional globals must never affect delivery. */
    }
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
        now() - saved.at < Math.min(TTL, vv.ttl * 1000) &&
        accept(vv, saved.at)
      )
        publish(vv);
    }
  } catch {
    /* Storage can be unavailable. */
  }
  const receive = async (response: Response, persist = false) => {
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
      const chunks: Uint8Array[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void reader.cancel().catch(() => {});
      }, 2000);
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
      if (!vv || (persist && (epoch !== revision || !granted)) || !accept(vv, receivedAt)) return;
      if (persist && granted)
        try {
          // Anchor expiry before body parsing so a slow response cannot extend proof lifetime.
          win.sessionStorage?.setItem(KEY, JSON.stringify({ at: receivedAt, vv }));
        } catch {
          /* Optional memory. */
        }
      publish(vv);
    } catch {
      /* Invalid JSON, streams and schemas are silently ignored. */
    }
  };
  receive.consent = (value: boolean, revoke = false) => {
    if (granted !== value || revoke) revision++;
    granted = value;
    if (revoke) {
      direct = undefined;
      try {
        win.sessionStorage?.removeItem(KEY);
      } catch {
        /* Optional memory. */
      }
    }
  };
  return receive;
}
