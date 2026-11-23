import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { withLabels } from "../src/server/labels.js";
import { validateParams } from "../src/server/mp-validation.js";

const serverLabels = {
  verification: "signature_valid" as const,
  agent_purpose: "user_directed" as const,
  verified: { operator: "openai", method: "signature" as const },
  claimed: { uaTokens: [], signatureAgents: ["https://chatgpt.com"] },
  signatures: [],
  reason: "valid",
};
const custom = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`custom_${i}`, i]));
const purchase = {
  transaction_id: "ORDER-1",
  value: 123,
  currency: "CZK",
  items: [{ item_id: "SKU-1", price: 123, quantity: 1 }],
  coupon: "SAVE",
  shipping: 10,
  tax: 20,
};

it("preserves automatic and standard conversion fields before optional labels and site params", () => {
  const result = validateParams(
    withLabels(
      {
        ...custom,
        ...purchase,
        session_id: 1,
        page_location: "https://shop.example/",
        engagement_time_msec: 10,
        traffic_class: "human",
        traffic_phase: "final",
      },
      serverLabels,
    ),
    () => {},
  );
  expect(Object.keys(result)).toHaveLength(25);
  expect(result).toMatchObject(purchase);
  expect(Object.keys(result).slice(0, 12)).toEqual([
    "session_id",
    "engagement_time_msec",
    "page_location",
    "transaction_id",
    "value",
    "currency",
    "items",
    "coupon",
    "shipping",
    "tax",
    "vv_type",
    "vv_detail",
  ]);
});

it("labels precede other recommended site params after ecommerce fields, with reserved client names removed", () => {
  const standard = Object.fromEntries(
    [
      "transaction_id",
      "value",
      "currency",
      "items",
      "coupon",
      "shipping",
      "tax",
      "affiliation",
      "payment_type",
      "shipping_tier",
      "item_list_id",
      "item_list_name",
      "promotion_id",
      "promotion_name",
      "creative_name",
      "creative_slot",
      "search_term",
      "method",
      "content_type",
      "item_id",
      "group_id",
      "level",
      "level_name",
      "character",
      "virtual_currency_name",
      "achievement_id",
      "score",
      "success",
    ].map((name) => [name, name === "items" ? [] : 1]),
  );
  for (const labels of [undefined, serverLabels]) {
    const result = validateParams(
      withLabels(
        {
          ...standard,
          agent_operator: "spoofed",
          agent_purpose: "crawler",
          agent_verification: "signature_valid",
          agent_claim: "spoofed",
          session_id: 1,
        },
        labels,
      ),
      () => {},
    );
    expect(Object.keys(result)).toHaveLength(25);
    expect(result.vv_type).toBe(labels ? "agent_verified" : "pending");
    expect(result).toHaveProperty("vv_detail");
    expect(result).not.toHaveProperty("agent_operator");
    expect(result).toMatchObject({ transaction_id: 1, value: 1, currency: 1, items: [] });
  }
});

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
for (const enabled of [false, true])
  for (const browserLabels of [false, true])
    it(`purchase revenue/items survive 20 site params and optional labels: agent=${enabled}, browser=${browserLabels}`, async () => {
      const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
      const app = createApp(
        {
          cookieSecret: "s".repeat(64),
          measurementId: "G-TEST",
          siteOrigin: "https://shop.example",
          trackerHost: "tracker.example",
          agentVerification: enabled,
          allowedEvents: ["purchase"],
        },
        google,
        {
          fetcher: async () => {
            throw Error("offline");
          },
        },
      );
      apps.push(app);
      const site = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`custom_${i}`, i]));
      for (const route of ["/e", "/d"]) {
        const now = Date.now();
        const common = {
          name: "purchase",
          client_id: "123.456",
          session_id: 123,
          page_id: "123",
          hit_index: 1,
          params: {
            ...site,
            ...purchase,
            ...(browserLabels ? { traffic_class: "declared_agent", traffic_phase: "final" } : {}),
            agent_verification: "signature_valid",
            agent_operator: "spoofed",
            agent_purpose: "crawler",
            agent_claim: "spoofed",
          },
          consent: { analytics_storage: route === "/d" ? "denied" : "granted" },
        };
        const response = await app.inject({
          method: "POST",
          url: route,
          headers: {
            origin: "https://shop.example",
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0",
          },
          payload:
            route === "/d"
              ? common
              : {
                  ...common,
                  event_id: crypto.randomUUID(),
                  session_started_ms: now,
                  session_expires_ms: now + 1800000,
                  timestamp_ms: now,
                },
        });
        expect(response.statusCode).toBe(204);
        const [url, init] = google.mock.calls.at(-1)!;
        const hit = new URLSearchParams(new URL(String(url)).search + "&" + (init?.body ?? ""));
        expect(hit.get("ep.transaction_id")).toBe(route === "/d" ? null : purchase.transaction_id);
        expect(hit.get("cu")).toBe(purchase.currency);
        expect(hit.get("epn.value")).toBe(String(purchase.value));
        if (route === "/e") {
          expect(hit.get("pr1")).toContain("idSKU-1");
          expect(hit.get("ep.coupon")).toBe(purchase.coupon);
          expect(hit.get("epn.shipping")).toBe(String(purchase.shipping));
          expect(hit.get("epn.tax")).toBe(String(purchase.tax));
        } else {
          for (const key of ["pr1", "ep.coupon", "epn.shipping", "epn.tax", "epn.custom_0"])
            expect(hit.has(key)).toBe(false);
        }
        expect(hit.has("ep.agent_verification")).toBe(false);
        expect(hit.has("ep.agent_operator")).toBe(false);
        expect(hit.has("ep.agent_claim")).toBe(false);
        expect(hit.has("ep.agent_purpose")).toBe(false);
      }
    });
