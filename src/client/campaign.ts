/** Deliberately small attribution model; click identifiers never leave the browser. */
export function campaignDetails(
  href: string,
  referrer: string,
  allowClick = true,
): Record<string, string> {
  const url = new URL(href);
  const campaign: Record<string, string> = {};
  for (const [utm, field] of Object.entries({
    source: "source",
    medium: "medium",
    campaign: "campaign",
    id: "campaign_id",
    term: "term",
    content: "content",
  })) {
    const value = url.searchParams.get("utm_" + utm);
    if (value) campaign[field] = value.slice(0, 100);
  }
  if (Object.keys(campaign).length) return campaign;
  if (allowClick && url.searchParams.has("gclid")) return { source: "google", medium: "cpc" };
  try {
    const ref = new URL(referrer);
    if (ref.hostname === url.hostname) return { source: "(direct)", medium: "(none)" };
    const host = ref.hostname.replace(/^www\./, "");
    const search =
      /^(google\.[a-z.]+|bing\.com|search\.yahoo\.com|duckduckgo\.com|search\.seznam\.cz|seznam\.cz|baidu\.com|yandex\.[a-z.]+)$/.exec(
        host,
      );
    return {
      source: search
        ? host.split(".")[0]!.replace("search", host.includes("seznam") ? "seznam" : "yahoo")
        : host,
      medium: search ? "organic" : "referral",
    };
  } catch {
    return { source: "(direct)", medium: "(none)" };
  }
}
