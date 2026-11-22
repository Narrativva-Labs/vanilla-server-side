import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { defaultRegistry, visitorLabels } from "visitor-verdict-server";
import { createAgentLabeller } from "../src/server/agent-verification.js";

for (const name of ["kernel", "cloudflare_browser_run", "shopify_cloudsurf"]) {
  it(`${name}: collector verifies signing infrastructure with intermediary purpose and detects replay`, async () => {
    const operator = defaultRegistry.find((entry) => entry.operator === name)!;
    expect(operator.intermediary).toBe(true);
    expect(operator.verifiedByCapture).toBe(false);
    const pair = generateKeyPairSync("ed25519");
    const jwk = pair.publicKey.export({ format: "jwk" });
    const keyid = createHash("sha256")
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
      .digest("base64url");
    const clock = 1800000000;
    const identity = JSON.stringify(operator.signatureAgent);
    const params = `("@authority" "@method" "signature-agent");created=${clock};expires=${clock + 60};keyid="${keyid}";alg="ed25519";nonce="${name}";tag="web-bot-auth"`;
    const base = `"@authority": tracker.example\n"@method": GET\n"signature-agent": ${identity}\n"@signature-params": ${params}`;
    const signature = sign(null, Buffer.from(base, "ascii"), pair.privateKey).toString("base64");
    const fetcher = vi.fn(async (_url: string) => Response.json({ keys: [jwk] }));
    const labeller = createAgentLabeller("tracker.example", { fetcher, now: () => clock });
    try {
      await vi.waitFor(() => expect(labeller.status().directoriesLoaded).toBe("9/9"));
      expect(fetcher.mock.calls.some(([url]) => url === operator.directoryUrl)).toBe(true);
      const request = {
        method: "GET",
        url: "/",
        ip: "127.0.0.1",
        raw: {
          rawHeaders: [
            "Signature-Agent",
            identity,
            "Signature-Input",
            `sig1=${params}`,
            "Signature",
            `sig1=:${signature}:`,
          ],
        },
      } as unknown as FastifyRequest;
      const proof = await labeller.label(request);
      expect(proof?.verification).toBe("signature_valid");
      expect(proof?.verified?.operator).toBe(name);
      expect(proof?.agent_purpose).toBe("intermediary");
      expect(
        visitorLabels({ verdict: proof, browserClass: "declared_agent", browserAgent: "openai" }),
      ).toEqual({
        vv_type: "agent_verified",
        vv_detail: `${name}|signature_valid|intermediary|signature_agent|declared_agent|-`,
      });
      const replay = await labeller.label(request);
      expect(replay?.reason).toBe("replay");
      expect(visitorLabels({ verdict: replay }).vv_type).toBe("bot_spoofed");
      expect(visitorLabels({ verdict: replay }).vv_detail.split("|")[0]).toBe("none");
    } finally {
      labeller.close();
    }
  });
}
