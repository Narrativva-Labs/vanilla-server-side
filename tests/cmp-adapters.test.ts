import { it, expect, vi } from "vitest";
import { page } from "./browser-fixture.js";
import { cookieyes } from "../src/client/cmp/cookieyes.js";
import { shoptet } from "../src/client/cmp/shoptet.js";
import { normalizeEventItem } from "../src/client/data-layer.js";

type Page = ReturnType<typeof page>;
type Choice = "undecided" | "granted" | "denied";
const allGranted = {
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
};
const allDenied = {
  analytics_storage: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const poll = (p: Page) => (p.host.setInterval.mock.calls[0]![0] as () => void)();
const paths = (p: Page) => p.fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);
const bodies = (p: Page) =>
  p.fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));

// Each banner as captured live; `state.choice` changes when the visitor decides.
const banners = {
  CookieYes(p: Page, state: { choice: Choice }) {
    Object.assign(p.host, {
      getCkyConsent: () => ({
        activeLaw: "gdpr",
        categories: {
          necessary: true,
          analytics: state.choice === "granted",
          advertisement: state.choice === "granted",
        },
        isUserActionCompleted: state.choice !== "undecided",
        consentID: "id",
        languageCode: "en",
      }),
    });
    return () => p.doc.dispatchEvent(new Event("cookieyes_consent_update"));
  },
  Shoptet(p: Page, state: { choice: Choice }) {
    Object.assign(p.host, {
      shoptet: {
        consent: {
          isSet: () => state.choice !== "undecided",
          isAccepted: () => state.choice === "granted",
          onAccept() {},
        },
      },
    });
    return () => poll(p);
  },
};

for (const kind of ["CookieYes", "Shoptet"] as const) {
  const install = banners[kind];
  it(`${kind}: a decided banner beats a Google default denied`, async () => {
    const p = page("cookie", [["consent", "default", { analytics_storage: "denied" }]]);
    install(p, { choice: "granted" })();
    poll(p);
    await settle();
    expect(paths(p)).toEqual(["/e"]);
  });
  it(`${kind}: the first banner read does not beat a Google update denied`, async () => {
    const p = page("cookie", [["consent", "update", { analytics_storage: "denied" }]]);
    install(p, { choice: "granted" })();
    poll(p);
    await settle();
    expect(paths(p).filter((path) => path === "/e")).toEqual([]);
  });
  it(`${kind}: a later banner grant beats an older Google update denied`, async () => {
    const p = page("cookie");
    const state: { choice: Choice } = { choice: "undecided" };
    const notify = install(p, state);
    notify();
    p.command("consent", "default", allDenied);
    p.command("consent", "update", allDenied);
    await settle();
    expect(p.fetcher).not.toHaveBeenCalled();
    state.choice = "granted";
    notify();
    await settle();
    expect(paths(p)).toEqual(["/e"]);
    expect(bodies(p)[0].consent).toEqual(allGranted);
  });
  it(`${kind}: an adapter grant alone sends with the banner's advertising choice`, async () => {
    const p = page("cookie");
    install(p, { choice: "granted" })();
    await settle();
    expect(paths(p)).toEqual(["/e"]);
    expect(bodies(p)[0].consent).toEqual(allGranted);
  });
  it(`${kind}: a refusal stops collection and deletes the cookie once`, async () => {
    const p = page("cookie");
    const state: { choice: Choice } = { choice: "undecided" };
    const notify = install(p, state);
    notify();
    state.choice = "denied";
    notify();
    poll(p);
    p.host.dataLayer.push({ event: "generate_lead" });
    await settle();
    expect(paths(p)).toEqual(["/p"]);
    expect(p.cookieReads()).toBe(0);
  });
  it(`${kind}: withdrawal after a grant deletes the cookie`, async () => {
    const p = page("cookie");
    const state: { choice: Choice } = { choice: "granted" };
    const notify = install(p, state);
    notify();
    await settle();
    state.choice = "denied";
    notify();
    await settle();
    expect(paths(p)).toEqual(["/e", "/p"]);
  });
  it(`${kind}: an undecided visitor is unknown, not denied`, async () => {
    const p = page("cookie");
    install(p, { choice: "undecided" })();
    poll(p);
    await settle();
    expect(p.fetcher).not.toHaveBeenCalled();
    const adapter =
      kind === "CookieYes" ? cookieyes(p.host as never, p.doc) : shoptet(p.host as never);
    expect(adapter.read()?.analytics_storage).toBe("unknown");
  });
  it(`${kind}: cookieless still sends for an undecided visitor after the wait`, async () => {
    vi.useFakeTimers();
    try {
      const p = page("cookieless");
      install(p, { choice: "undecided" })();
      poll(p);
      await settle();
      expect(p.fetcher).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2100);
      poll(p);
      await settle();
      expect(paths(p)).toEqual(["/e"]);
      expect(bodies(p)[0].consent.analytics_storage).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });
  it(`${kind}: the first read of a stored refusal does not override an explicit Google grant`, async () => {
    const p = page("cookie", [["consent", "update", { analytics_storage: "granted" }]]);
    await settle();
    install(p, { choice: "denied" })();
    poll(p);
    await settle();
    expect(paths(p)).toEqual(["/e"]);
  });
  it(`${kind}: withdrawing in the banner overrides an older Google grant and deletes the cookie`, async () => {
    const p = page("cookie", [["consent", "update", allGranted]]);
    const state: { choice: Choice } = { choice: "granted" };
    const notify = install(p, state);
    notify();
    await settle();
    state.choice = "denied";
    notify();
    await settle();
    p.host.dataLayer.push({ event: "generate_lead" });
    poll(p);
    await settle();
    expect(paths(p)).toEqual(["/e", "/p"]);
  });
  it(`${kind}: refusing in the banner beats a Google default granted`, async () => {
    const p = page("cookie", [["consent", "default", allGranted]]);
    const state: { choice: Choice } = { choice: "undecided" };
    const notify = install(p, state);
    notify();
    await settle();
    state.choice = "denied";
    notify();
    await settle();
    p.host.dataLayer.push({ event: "generate_lead" });
    await settle();
    expect(paths(p)).toEqual(["/e", "/p"]);
  });
  it(`${kind}: the newest decision wins, in both directions`, async () => {
    const p = page("cookie", [["consent", "update", allGranted]]);
    const state: { choice: Choice } = { choice: "granted" };
    const notify = install(p, state);
    notify();
    await settle();
    state.choice = "denied";
    notify();
    await settle();
    p.command("consent", "update", allGranted);
    await settle();
    expect(paths(p)).toEqual(["/e", "/p", "/e"]);
    p.command("consent", "update", allDenied);
    await settle();
    state.choice = "granted";
    p.command("consent", "update", allDenied);
    await settle();
    // The banner changed first, so the Google command after it is the newest decision.
    expect(paths(p).filter((path) => path === "/e")).toHaveLength(2);
  });
  it(`${kind}: an undecided banner changes nothing`, async () => {
    const denied = page("cookie", [["consent", "default", allDenied]]);
    install(denied, { choice: "undecided" })();
    poll(denied);
    await settle();
    expect(denied.fetcher).not.toHaveBeenCalled();
    for (const google of ["default", "update"]) {
      const granted = page("cookie", [["consent", google, allGranted]]);
      install(granted, { choice: "undecided" })();
      poll(granted);
      await settle();
      expect(paths(granted)).toEqual(["/e"]);
    }
  });
  it(`${kind}: a denied update before the choice sends nothing, then a refusal deletes`, async () => {
    const p = page("cookie");
    const state: { choice: Choice } = { choice: "undecided" };
    const notify = install(p, state);
    p.command("consent", "update", allDenied);
    notify();
    poll(p);
    await settle();
    expect(p.fetcher).not.toHaveBeenCalled();
    state.choice = "denied";
    notify();
    await settle();
    expect(paths(p)).toEqual(["/p"]);
  });
}

it("CookieYes: categories map to Google purposes separately", () => {
  const host = Object.assign(new EventTarget(), {
    getCkyConsent: () => ({
      isUserActionCompleted: true,
      categories: { analytics: false, advertisement: true },
    }),
  });
  expect(cookieyes(host, new EventTarget()).read()).toEqual({
    analytics_storage: "denied",
    ad_storage: "granted",
    ad_user_data: "granted",
    ad_personalization: "granted",
  });
});
it("CookieYes: no script or no data gives no answer", () => {
  expect(cookieyes(new EventTarget(), new EventTarget()).read()).toBeUndefined();
  const empty = Object.assign(new EventTarget(), { getCkyConsent: () => undefined });
  expect(cookieyes(empty, new EventTarget()).read()).toBeUndefined();
});
it("CookieYes: the on-load update event listing rejected categories is not a refusal", async () => {
  const p = page("cookie");
  banners.CookieYes(p, { choice: "undecided" });
  p.doc.dispatchEvent(
    new CustomEvent("cookieyes_consent_update", {
      detail: { accepted: ["necessary"], rejected: ["analytics", "advertisement"] },
    }),
  );
  await settle();
  expect(p.fetcher).not.toHaveBeenCalled();
});
it("CookieYes: an accepting update after the on-load denial sends", async () => {
  const p = page("cookie");
  banners.CookieYes(p, { choice: "undecided" });
  p.command("consent", "update", allDenied);
  p.command("consent", "update", allGranted);
  await settle();
  expect(paths(p)).toEqual(["/e"]);
});

it("Shoptet: analytics and personalisation map separately", () => {
  const host = Object.assign(new EventTarget(), {
    shoptet: { consent: { isSet: () => true, isAccepted: (name: string) => name === "analytics" } },
  });
  expect(shoptet(host).read()).toEqual({
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
});
it("Shoptet: documented dataLayer works without shoptet.consent", () => {
  const read = (dataLayer: unknown[]) =>
    shoptet(Object.assign(new EventTarget(), { dataLayer })).read();
  const denied = { analytics: "denied", marketing: "denied" };
  // Default state before any choice is not a refusal.
  expect(read([{ cookie_consent: denied }])).toBeUndefined();
  expect(read([{ event: "gtm.js" }])).toBeUndefined();
  expect(
    read([{ cookie_consent: denied }, { cookie_consent: denied, event: "cookie_consent" }]),
  ).toEqual({
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  expect(read([{ cookie_consent: { analytics: "granted", marketing: "denied" } }])).toEqual({
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  expect(
    read([
      { cookie_consent: denied },
      { cookie_consent: { analytics: "granted", marketing: "granted" }, event: "cookie_consent" },
    ]),
  ).toEqual({
    analytics_storage: "granted",
    ad_storage: "granted",
    ad_user_data: "granted",
    ad_personalization: "granted",
  });
});
it("Shoptet: a changed or failing interface gives no answer and deletes nothing", async () => {
  const broken = [
    {},
    { consent: {} },
    {
      consent: {
        isSet: () => {
          throw Error("Malformed cookie");
        },
      },
    },
    { consent: { isSet: () => true } },
    { consent: { isSet: () => true, isAccepted: () => undefined } },
    {
      consent: {
        isSet: () => true,
        isAccepted: () => {
          throw Error("Malformed cookie");
        },
      },
    },
  ];
  for (const api of broken) {
    expect(shoptet(Object.assign(new EventTarget(), { shoptet: api })).read()).toBeUndefined();
    const p = page("cookie");
    Object.assign(p.host, { shoptet: api });
    poll(p);
    await settle();
    expect(p.fetcher).not.toHaveBeenCalled();
  }
  const change = vi.fn();
  const throwing = {
    shoptet: {
      consent: {
        onAccept() {
          throw Error("Changed");
        },
      },
    },
  };
  expect(() => shoptet(Object.assign(new EventTarget(), throwing)).subscribe(change)).not.toThrow();
});
it("Shoptet: onAccept notifies immediately when present", () => {
  const change = vi.fn();
  let listener: () => void = () => {};
  const host = Object.assign(new EventTarget(), {
    shoptet: {
      consent: {
        onAccept(fn: () => void) {
          listener = fn;
        },
      },
    },
  });
  shoptet(host).subscribe(change);
  listener();
  expect(change).toHaveBeenCalledTimes(1);
});
it("Shoptet: cookie_consent objects are never events, not even when allowlisted", async () => {
  const pending = { cookie_consent: { marketing: "denied", analytics: "denied" } };
  const decided = {
    cookie_consent: { marketing: "granted", analytics: "granted" },
    event: "cookie_consent",
  };
  expect(normalizeEventItem(pending)).toBeUndefined();
  expect(normalizeEventItem(decided)).toBeUndefined();
  const p = page("cookie", [["consent", "update", { analytics_storage: "granted" }], pending]);
  p.host.dataLayer.push(decided);
  await settle();
  expect(bodies(p).map((body) => body.name)).toEqual(["page_view"]);
  expect(p.host.dataLayer).toHaveLength(3);
});
it("Shoptet: pre-choice dataLayer state alone neither sends nor deletes", async () => {
  const p = page("cookie", [{ cookie_consent: { marketing: "denied", analytics: "denied" } }]);
  banners.Shoptet(p, { choice: "undecided" });
  poll(p);
  await settle();
  expect(p.fetcher).not.toHaveBeenCalled();
});

it("creates dataLayer when absent and keeps it for later scripts", async () => {
  const p = page("cookie", null as unknown as unknown[]);
  const layer = p.host.dataLayer;
  expect(Array.isArray(layer)).toBe(true);
  const host = p.host as { dataLayer: unknown[] };
  host.dataLayer = host.dataLayer || [];
  expect(p.host.dataLayer).toBe(layer);
  p.command("consent", "update", { analytics_storage: "granted" });
  p.host.dataLayer.push({ event: "generate_lead" });
  await settle();
  expect(bodies(p).map((body) => body.name)).toEqual(["page_view", "generate_lead"]);
});

it("traffic shape: an update without any default resolves consent", async () => {
  const p = page("cookie", [["consent", "update", allGranted]]);
  await settle();
  expect(bodies(p)[0].consent).toEqual(allGranted);
});
it("traffic shape: a returning visitor with only a granted default sends", async () => {
  const p = page("cookie", [["consent", "default", allGranted], { event: "default_consent" }]);
  await settle();
  expect(paths(p)).toEqual(["/e"]);
  expect(bodies(p)[0].consent).toEqual(allGranted);
});
it("traffic shape: per-key updates merge into one state", async () => {
  const p = page("cookie", [["consent", "default", { ...allDenied, wait_for_update: 500 }]]);
  p.command("consent", "update", { analytics_storage: "granted" });
  await settle();
  p.command("consent", "update", {
    ad_storage: "granted",
    ad_user_data: "granted",
    ad_personalization: "granted",
  });
  p.host.dataLayer.push({ event: "generate_lead" });
  await settle();
  const [view, lead] = bodies(p);
  expect(view.consent).toEqual({ ...allDenied, analytics_storage: "granted" });
  expect(lead.consent).toEqual(allGranted);
});
it("traffic shape: a regional default stays unresolved until an update", async () => {
  const p = page("cookie", [["consent", "default", { ...allDenied, region: ["CZ", "DE"] }]]);
  banners.CookieYes(p, { choice: "undecided" })();
  poll(p);
  await settle();
  expect(p.fetcher).not.toHaveBeenCalled();
  p.command("consent", "update", allGranted);
  await settle();
  expect(paths(p)).toEqual(["/e"]);
});
for (const [shape, region] of [
  ["default", {}],
  ["regional default", { region: ["CZ", "DE"] }],
] as const) {
  it(`traffic shape: CookieYes on WordPress, accepting over a ${shape} sends with no Google update`, async () => {
    vi.useFakeTimers();
    try {
      const p = page("cookie", [
        ["consent", "default", { ...allDenied, ...region, wait_for_update: 500 }],
      ]);
      const state: { choice: Choice } = { choice: "undecided" };
      const notify = banners.CookieYes(p, state);
      notify();
      vi.advanceTimersByTime(600);
      poll(p);
      await settle();
      expect(p.fetcher).not.toHaveBeenCalled();
      state.choice = "granted";
      notify();
      await settle();
      expect(paths(p)).toEqual(["/e"]);
      expect(bodies(p)[0].consent).toEqual(allGranted);
    } finally {
      vi.useRealTimers();
    }
  });
}
it("traffic shape: CookieYes on WordPress, a return visit repeats the stored grant as an update", async () => {
  const p = page("cookie", [
    ["consent", "default", { ...allDenied, region: ["CZ"], wait_for_update: 500 }],
    ["consent", "update", allGranted],
  ]);
  banners.CookieYes(p, { choice: "granted" })();
  await settle();
  expect(paths(p)).toEqual(["/e"]);
});
it("a banner change noticed only when a Google command arrives still counts as older", async () => {
  const p = page("cookie");
  const state: { choice: Choice } = { choice: "denied" };
  banners.CookieYes(p, state)();
  await settle();
  state.choice = "granted";
  p.command("consent", "update", allDenied);
  poll(p);
  await settle();
  expect(paths(p).filter((path) => path === "/e")).toEqual([]);
});
for (const [name, history] of [
  ["default denied", [["consent", "default", allDenied]]],
  [
    "default and update denied at load",
    [
      ["consent", "default", allDenied],
      ["consent", "update", allDenied],
    ],
  ],
  ["update denied alone", [["consent", "update", allDenied]]],
] as const) {
  it(`traffic shape: cookieless sends nothing with ${name}`, async () => {
    vi.useFakeTimers();
    try {
      const p = page("cookieless", [...history]);
      vi.advanceTimersByTime(2100);
      poll(p);
      await settle();
      expect(p.fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
}
for (const [name, history] of [
  ["no consent command, as OneTrust before a choice", []],
  ["only a regional default", [["consent", "default", { ...allDenied, region: ["CZ"] }]]],
] as const) {
  it(`traffic shape: cookieless sends after the wait with ${name}, device included`, async () => {
    vi.useFakeTimers();
    try {
      const p = page("cookieless", [...history]);
      await settle();
      expect(p.fetcher).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2100);
      poll(p);
      await settle();
      expect(paths(p)).toEqual(["/e"]);
      const [view] = bodies(p);
      expect(view.consent.analytics_storage).toBe("unknown");
      expect(view.consent.ad_user_data).toBe("denied");
      expect(view.device.screen_resolution).toBe("1920x1080");
    } finally {
      vi.useRealTimers();
    }
  });
}
it("traffic shape: a denied update on load without an adapter still requests deletion", async () => {
  const p = page("cookie");
  p.command("consent", "update", allDenied);
  await settle();
  expect(paths(p)).toEqual(["/p"]);
});
it("traffic shape: a stored refusal repeats its denied update and sends no events", async () => {
  const p = page("cookie");
  banners.CookieYes(p, { choice: "denied" });
  p.command("consent", "update", allDenied);
  p.host.dataLayer.push({ event: "generate_lead" });
  await settle();
  expect(paths(p)).toEqual(["/p"]);
});

const consentWarning = expect.stringContaining("No resolved analytics consent");
const warningTimer = (p: Page) => (p.host.setTimeout.mock.calls[0]![0] as () => void)();
const undecided: Record<string, (p: Page) => void> = {
  CookieYes: (p) => {
    banners.CookieYes(p, { choice: "undecided" });
  },
  Shoptet: (p) => {
    banners.Shoptet(p, { choice: "undecided" });
  },
  Cookiebot: (p) => {
    Object.assign(p.host, { Cookiebot: { hasResponse: false } });
  },
  CookieConsent: (p) => {
    Object.assign(p.host, {
      CookieConsent: { validConsent: () => false, acceptedCategory: () => false },
    });
  },
};
for (const [kind, install] of Object.entries(undecided)) {
  it(`${kind}: an undecided visitor on a recognized banner raises no consent warning`, () => {
    const p = page("cookie");
    install(p);
    warningTimer(p);
    expect(p.warnings).not.toHaveBeenCalled();
  });
}
it("CookieYes: a regional default with an undecided banner raises no consent warning", () => {
  const p = page("cookie", [
    ["consent", "default", { analytics_storage: "denied", region: ["CZ"] }],
  ]);
  banners.CookieYes(p, { choice: "undecided" });
  warningTimer(p);
  expect(p.warnings).not.toHaveBeenCalled();
});
it("CookieYes: its denied update on load raises no warning, keeps collection off and deletes nothing", async () => {
  for (const mode of ["cookie", "cookieless"] as const) {
    vi.useFakeTimers();
    try {
      const p = page(mode);
      banners.CookieYes(p, { choice: "undecided" });
      p.command("consent", "update", { analytics_storage: "denied" });
      vi.advanceTimersByTime(2100);
      poll(p);
      warningTimer(p);
      await settle();
      expect(p.warnings).not.toHaveBeenCalled();
      expect(p.fetcher).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }
});
it("the consent warning stays when no banner or Google command can be read", () => {
  const p = page("cookie");
  warningTimer(p);
  expect(p.warnings).toHaveBeenCalledWith(consentWarning);
});
it("the consent warning stays for an unresolved regional default without a recognized banner", () => {
  const p = page("cookie", [
    ["consent", "default", { analytics_storage: "denied", region: ["CZ"] }],
  ]);
  warningTimer(p);
  expect(p.warnings).toHaveBeenCalledWith(consentWarning);
});
