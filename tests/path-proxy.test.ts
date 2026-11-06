import { expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { runInNewContext } from "node:vm";
import { cookieHeader } from "../src/server/identity.js";

const listen = (server: Server) =>
  new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("Missing proxy address"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
it("same-origin path proxy strips the prefix and serves working tracker, collect and consent endpoints", async () => {
  // Exercise the built server's actual script route as well as real HTTP forwarding.
  const { createApp } = await import(new URL("../dist/server/app.js", import.meta.url).href);
  const google = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const paths: string[] = [];
  let upstream = "";
  const proxy = createServer((incoming, outgoing) => {
    paths.push(incoming.url ?? "");
    if (!incoming.url?.startsWith("/kx7qpa/")) {
      outgoing.writeHead(404).end();
      return;
    }
    const target = new URL(incoming.url.slice("/kx7qpa".length), upstream);
    const forwarded = request(
      target,
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    forwarded.on("error", () => outgoing.writeHead(502).end());
    incoming.pipe(forwarded);
  });
  const origin = await listen(proxy);
  const app = createApp(
    {
      siteOrigin: origin,
      cookieDomain: "127.0.0.1",
      cookieSecret: "s".repeat(64),
      measurementId: "G-TEST",
      apiSecret: "test",
    },
    google,
  );
  let cookie = "";
  // Node has no browser cookie jar: replay the returned cookie explicitly.
  const replies: Response[] = [];
  const pending = new Set<Promise<Response>>();
  const transport: typeof fetch = (url, options) => {
    expect(new URL(String(url)).origin).toBe(origin);
    expect(options?.credentials).toBe("include");
    const work = fetch(url, {
      ...options,
      headers: {
        ...options?.headers,
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }).then((response) => {
      replies.push(response);
      const set = response.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0]!;
      return response;
    });
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  try {
    upstream = await app.listen({ host: "127.0.0.1", port: 0 });
    const scriptSrc = new URL("/kx7qpa/s.js", origin).href;
    const response = await fetch(scriptSrc);
    expect(response.status).toBe(200);
    const source = await response.text();
    const host = Object.assign(new EventTarget(), {
      dataLayer: [["consent", "default", { analytics_storage: "denied" }]],
      fetch: transport,
      setInterval: vi.fn(),
      setTimeout: vi.fn(),
      navigator: { language: "en", userAgent: "Chrome/130.0" },
      screen: { width: 1280, height: 720 },
      location: { href: origin + "/" },
    });
    const doc = Object.assign(new EventTarget(), {
      // HTMLScriptElement.src resolves a relative attribute against the page URL.
      currentScript: { src: scriptSrc, dataset: {} },
      title: "Proxy test",
      referrer: "",
      visibilityState: "visible",
    });
    runInNewContext(source, {
      window: host,
      document: doc,
      location: host.location,
      console,
      Date,
      crypto,
      URL,
      TextEncoder,
      AbortController,
      AbortSignal,
    });
    expect(paths).toEqual(["/kx7qpa/s.js"]);
    host.dataLayer.push(["consent", "update", { analytics_storage: "granted" }]);
    await Promise.all([...pending]);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(paths).toContain("/kx7qpa/e");
    expect(google).toHaveBeenCalledTimes(1);
    expect(replies[0]!.status).toBe(204);
    expect(replies[0]!.headers.get("access-control-allow-origin")).toBe(origin);
    expect(replies[0]!.headers.get("set-cookie")).toContain(
      "Domain=127.0.0.1; HttpOnly; Secure; SameSite=Lax",
    );
    const firstId = new URL(String(google.mock.calls[0]![0])).searchParams.get("cid");
    host.dataLayer.push(["event", "generate_lead"] as string[]);
    await vi.waitFor(() => expect(google).toHaveBeenCalledTimes(2));
    await Promise.all([...pending]);
    expect(JSON.parse(String(google.mock.calls[1]![1]?.body)).client_id).toBe(firstId);
    host.dataLayer.push(["consent", "update", { analytics_storage: "denied" }]);
    await Promise.all([...pending]);
    expect(paths.at(-1)).toBe("/kx7qpa/p");
    expect(replies.at(-1)!.status).toBe(204);
    expect(replies.at(-1)!.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(paths.every((path) => path.startsWith("/kx7qpa/"))).toBe(true);
    const denied = await fetch(origin + "/kx7qpa/p", {
      method: "POST",
      headers: { Origin: "https://other.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(403);
    expect((await fetch(origin + "/kx7qpa/health")).status).toBe(200);
    for (const [path, method] of [
      ["tracker.js", "GET"],
      ["collect", "POST"],
      ["consent", "POST"],
    ]) {
      const removed = await fetch(origin + "/kx7qpa/" + path, {
        method,
        headers: { Origin: origin, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(removed.status).toBe(404);
    }
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 20000);

it("same-origin HTTPS cookie domain defaults and explicit override remain valid", () => {
  const config = { siteOrigin: "https://www.example.com" };
  expect(cookieHeader(config, "test")).toContain("Domain=example.com;");
  expect(cookieHeader({ ...config, cookieDomain: "www.example.com" }, "test")).toContain(
    "Domain=www.example.com;",
  );
  expect(cookieHeader({ ...config, cookieDomain: "www.example.com" }, "", true)).toContain(
    "Max-Age=0",
  );
});
