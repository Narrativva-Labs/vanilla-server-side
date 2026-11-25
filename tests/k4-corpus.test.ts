import { test } from "vitest";
// The same real verifier as the collector imports, including its vendor lock.
test("K4 collector vendor and shipped sandbox share the full differential corpus", async () => {
  // @ts-expect-error shared Node test harness is intentionally plain ESM
  const { runCorpus } = await import("./vectors/runner.mjs");
  await runCorpus({ packageUrl: import.meta.resolve("visitor-verdict-server") });
});

test("K4 actual collector labeller accepts the shared corpus direct-ingress slice", async () => {
  const { createAgentLabeller } = await import("../src/server/agent-verification.js");
  const { defaultRegistry, visitorLabels } = await import("visitor-verdict-server");
  // @ts-expect-error shared plain ESM fixture
  const { corpus } = await import("./vectors/runner.mjs");
  const urls = new Set(defaultRegistry.flatMap((o) => o.ipLists.map((l) => l.url)));
  const makeLabeller = () =>
    createAgentLabeller("example.com", {
      now: () => corpus.start / 1000,
      flagSpoofedClaims: true,
      fetcher: async (url) =>
        urls.has(String(url))
          ? Response.json({ prefixes: [{ ipv4Prefix: "192.0.2.0/24" }] })
          : Response.json({
              keys: [
                corpus.owners.find(
                  (o: { signatureAgent: string }) =>
                    o.signatureAgent ===
                    defaultRegistry.find((r) => r.directoryUrl === String(url))?.signatureAgent,
                )?.jwk ?? corpus.owners[0].jwk,
              ],
            }),
    });
  const labeller = makeLabeller();
  const warm = async (labeller: ReturnType<typeof makeLabeller>) => {
    for (let i = 0; i < 100; i++) {
      const probe = await labeller.label({
        method: "GET",
        url: "/g/collect",
        ip: "192.0.2.9",
        raw: { rawHeaders: ["user-agent", "GPTBot"] },
      } as never);
      if (probe?.verification === "ip_match") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  try {
    await warm(labeller);
    let count = 0;
    for (const v of corpus.vectors) {
      if (
        v.axes.context !== "valid" ||
        v.axes.response !== "200" ||
        v.axes.lists !== "fresh" ||
        v.axes.shared ||
        v.axes.proxy !== "none" ||
        v.axes.path ||
        !["bare", "dictionary"].includes(v.axes.agent) ||
        v.axes.schema !== 2 ||
        !v.axes.flagSpoofed ||
        v.axes.crypto !== "valid" ||
        v.axes.ua !== "token"
      )
        continue;
      // Long dictionary and taxonomy signed variants intentionally reuse the signed keyed member.
      // Compare them with independent replay histories, as the shared runner does.
      const isolated =
        v.boundary?.kind === "k7_long_agent" ||
        v.boundary?.kind === "taxonomy_wba_browser_agent_with_fetcher_ua"
          ? makeLabeller()
          : undefined;
      if (isolated) await warm(isolated);
      const verdict = await (isolated ?? labeller).label({
        method: v.method,
        url: v.path,
        ip: v.ip,
        raw: { rawHeaders: Object.entries(v.headers).flat() },
      } as never);
      isolated?.close();
      const actual = visitorLabels({
        verdict,
        browserClass: v.event.traffic_class,
        browserPhase: v.event.traffic_phase,
        browserAgent: v.event.traffic_agent,
        browserAgentClaim: v.event.traffic_agent_claim,
      });
      const { expect } = await import("vitest");
      expect(actual, v.id).toEqual(v.expected);
      count++;
    }
    const { expect } = await import("vitest");
    expect(count).toBeGreaterThanOrEqual(60);
    console.log("K5 actual labeller slice", count);
  } finally {
    labeller.close();
  }
});
