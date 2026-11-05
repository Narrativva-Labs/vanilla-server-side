import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  effectiveConsent,
  nextConsent,
  noConsent,
  type ConsentSignal,
} from "../src/client/consent.js";

/**
 * Each row is one rule: its wording, the signals, oldest first, and the outcome.
 * docs/technical-overview.md repeats these rows, and the last test keeps the two equal.
 * A value is `analytics_storage`, or `analytics_storage/ad_storage`; `-` leaves a purpose out.
 */
// prettier-ignore
const priority = [
  ["With no signal a purpose is unknown", "", "unknown"],
  ["A Google default sets the starting value", "default denied", "denied"],
  ["A newer default replaces an older one", "default denied, default granted", "granted"],
  ["A regional default stays unknown, whatever it says", "regional granted", "unknown"],
  ["A regional default beats an older general default", "default granted, regional denied", "unknown"],
  ["A regional default beats a newer general default", "regional denied, default granted", "unknown"],
  ["An undecided banner adds nothing", "default denied, banner undecided", "denied"],
  ["A decided banner beats a Google default", "default denied, banner granted", "granted"],
  ["A decided banner beats a regional default", "regional denied, banner granted", "granted"],
  ["A Google update beats a Google default", "default denied, update granted", "granted"],
  ["A Google update beats a regional default", "regional denied, update granted", "granted"],
  ["A Google update beats the first banner read", "update denied, banner granted", "denied"],
  ["A Google update beats a banner decided earlier", "banner granted, update denied", "denied"],
  ["A banner that repeats itself is no new decision", "banner granted, update denied, banner granted", "denied"],
  ["A later banner change beats an older update", "banner undecided, update denied, banner granted", "granted"],
  ["A later update beats an older banner change", "banner undecided, banner granted, update denied", "denied"],
  ["The newest decision wins, however often it changes", "banner granted, update granted, banner denied, update granted, banner granted, banner denied", "denied"],
  ["A banner change replaces only the purposes it changes", "banner granted/denied, update denied/denied, banner granted/granted", "denied/granted"],
  ["A banner turning undecided keeps the update", "banner granted, update denied, banner undecided", "denied"],
  ["A banner that disappears stops counting", "default denied, banner granted, banner gone", "denied"],
  ["A banner that returns unchanged is no new decision", "banner granted, update denied, banner gone, banner granted", "denied"],
  ["A banner that returns changed is a new decision", "banner denied, update denied, banner gone, banner granted", "granted"],
  ["A partial update changes only the purposes it names", "update granted/denied, update -/granted", "granted/granted"],
  ["A value that is not a decision counts as unknown", "default granted, update maybe", "unknown"],
] as const;

/** Whether the tracker must ask the server to delete the cookie. */
// prettier-ignore
const refusal = [
  ["A Google default is not a refusal", "default denied", false],
  ["A grant is not a refusal", "update granted, banner granted", false],
  ["An update denied is a refusal", "update denied", true],
  ["An undecided banner cancels an update denied", "update denied, banner undecided", false],
  ["A decided banner keeps an update denied", "update denied, banner granted", true],
  ["A disappearing banner keeps an update denied", "update denied, banner gone", true],
  ["A banner reporting denied is a refusal", "banner undecided, banner denied", true],
  ["A banner refusal counts once", "banner denied, handled, banner denied", false],
  ["A banner refusal counts again after a grant", "banner denied, handled, banner granted, banner denied", true],
  ["An update denied counts every time", "update denied, handled, update denied", true],
] as const;

const parts = (value = "") => {
  const [analytics, ads] = value.split("/");
  return {
    ...(analytics !== "-" ? { analytics_storage: analytics } : {}),
    ...(ads ? { ad_storage: ads } : {}),
  };
};
function parse(text: string): ConsentSignal {
  const [kind, value] = text.split(" ");
  if (kind === "handled") return { kind: "refusal-handled" };
  if (kind === "banner")
    return { kind: "banner", read: value === "gone" ? undefined : parts(value) };
  if (kind === "regional")
    return { kind: "default", settings: { ...parts(value), region: ["CZ"] } };
  return { kind: kind as "default" | "update", settings: parts(value) };
}
const apply = (signals: string) =>
  signals.split(", ").filter(Boolean).map(parse).reduce(nextConsent, noConsent);

describe("priority", () => {
  it.each(priority)("%s", (_rule, signals, outcome) => {
    const consent = effectiveConsent(apply(signals));
    const [analytics, ads] = outcome.split("/");
    expect(consent.analytics_storage).toBe(analytics);
    if (ads) expect(consent.ad_storage).toBe(ads);
  });
});

describe("refusal", () => {
  it.each(refusal)("%s", (_rule, signals, outcome) => {
    expect(apply(signals).refusal).toBe(outcome);
  });
});

it("the core reads no clock and changes no state it was given", () => {
  const clock = vi.spyOn(Date, "now");
  const before = apply("default denied, banner granted, update denied");
  const copy = structuredClone(before);
  for (const text of ["banner denied", "update granted", "regional denied", "handled"])
    nextConsent(before, parse(text));
  expect(before).toEqual(copy);
  expect(clock).not.toHaveBeenCalled();
  clock.mockRestore();
});

it("the technical overview lists exactly these rules", () => {
  const docs = readFileSync("docs/technical-overview.md", "utf8");
  const row = (rule: string, signals: string, outcome: string | boolean) =>
    `| ${rule} | ${signals ? `\`${signals}\`` : "none"} | \`${outcome}\` |`;
  const rows = [...priority, ...refusal].map(([rule, signals, outcome]) =>
    row(rule, signals, outcome),
  );
  expect(rows.filter((line) => !docs.includes(line))).toEqual([]);
  expect(new Set(rows.map((line) => line.split(" | ")[0])).size).toBe(rows.length);
});
