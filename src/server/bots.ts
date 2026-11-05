/**
 * Obvious automated clients only. A self-declared User-Agent is the whole signal, so anything
 * that presents itself as a browser passes. The lookbehind keeps Cubot phones out of the match.
 */
const obvious = /(?<!cu)bot\b|crawl|spider|slurp|headless|lighthouse|pagespeed|gtmetrix|pingdom|phantomjs|prerender|mediapartners-google|facebookexternalhit|\b(?:curl|wget|python-requests|go-http-client|axios|node-fetch)\b/i;
export function isObviousBot(userAgent: string | undefined) {
  return obvious.test(userAgent ?? "");
}
