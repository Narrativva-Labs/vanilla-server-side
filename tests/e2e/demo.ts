import { expect, test as base, type Cookie } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
      .once("error", reject)
      .listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
  });

interface Demo {
  /** Opens the demo page, consent undecided. */
  open(): Promise<void>;
  /** How many times the demo printed this event as going to Google. */
  toGoogle(name: string): number;
  /** How many anonymous denied pings the demo printed as going to Google. */
  pings(): number;
  /** Paths and event names of the tracker's requests, as the browser sent them. */
  sent(): { path: string; name?: string }[];
  /** Waits for the demo to report this event as blocked, for up to six seconds. */
  blocked(name: string, reason: string): Promise<void>;
  session(): Promise<Cookie | undefined>;
}

/** A fresh scripts/demo.mjs for each test, so no test sees the state of another. */
export const test = base.extend<{ demo: Demo }>({
  demo: async ({ context, page }, use) => {
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/demo.mjs"], {
      env: { ...process.env, PORT: String(port) },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    await expect.poll(() => output).toContain("Open http://localhost");

    const origin = `http://localhost:${port}`;
    const sent: { path: string; name?: string }[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === "POST" && (pathname === "/e" || pathname === "/p"))
        sent.push({ path: pathname, name: request.postDataJSON()?.name });
    });
    await use({
      open: async () => void (await page.goto(origin)),
      toGoogle: (name) => output.split(`TO GOOGLE  ${name}  `).length - 1,
      pings: () => output.split("gcs=G100").length - 1,
      sent: () => sent,
      blocked: (name, reason) =>
        expect.poll(() => output, { timeout: 6000 }).toContain(`BLOCKED    ${name}: ${reason}`),
      session: async () =>
        (await context.cookies(origin)).find((cookie) => cookie.name === "vanilla_session"),
    });
    child.kill();
  },
});
