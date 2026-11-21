import { isIP } from "node:net";

export interface DeniedPingPrivacy {
  deniedPingIp?: "full" | "truncated" | "off";
  deniedPingUserAgent?: boolean;
}

/** Only changes the outbound address; callers retain the real IP for internal use. */
export function deniedPingAddress(ip?: string, mode = "full"): string | undefined {
  if (mode === "off") return undefined;
  if (mode !== "truncated" || !ip) return ip;
  if (isIP(ip) === 4) return ip.split(".").slice(0, 3).join(".") + ".0";
  if (isIP(ip) !== 6) return undefined;
  // URL canonicalizes compressed and dotted-tail IPv6 into hexadecimal groups.
  const canonical = new URL(`http://[${ip.split("%")[0]}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const groups =
    right === undefined
      ? head
      : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  const words = groups.map((part) => parseInt(part, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
    return `${words[6]! >>> 8}.${words[6]! & 255}.${words[7]! >>> 8}.0`;
  return new URL(
    `http://[${words
      .slice(0, 3)
      .map((word) => word.toString(16))
      .join(":")}:0:0:0:0:0]/`,
  ).hostname.slice(1, -1);
}
