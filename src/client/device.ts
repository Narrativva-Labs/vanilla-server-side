/** Best available model from browser information, without sending the raw user agent. */
export function deviceModel(agent: string) {
  if (/iPad/i.test(agent)) return "iPad";
  if (/iPhone/i.test(agent)) return "iPhone";
  const android = agent.match(/Android[^;)]*;\s*(?:[a-z]{2}(?:[-_][A-Z]{2})?;\s*)?([^;)]+?)(?:\s+Build\/[^;)]*|\))/i)?.[1]?.trim();
  if (android) return Array.from(android).slice(0, 100).join("");
  if (/Macintosh|Mac OS/i.test(agent)) return "Mac";
  if (/Windows/i.test(agent)) return "Windows PC";
  if (/Linux/i.test(agent)) return "Linux PC";
  return /Mobi|Android/i.test(agent) ? "Mobile" : "Desktop";
}

/** Browser family only; never transmit the raw user agent. Match variants before their engines. */
export function deviceBrowser(agent: string) {
  if (/Edg(?:e|A|iOS)?\//i.test(agent)) return "Edge";
  if (/(?:OPR|Opera|OPiOS)\//i.test(agent)) return "Opera";
  if (/SamsungBrowser\//i.test(agent)) return "Samsung Internet";
  if (/(?:Firefox|FxiOS)\//i.test(agent)) return "Firefox";
  if (/(?:Chrome|CriOS)\//i.test(agent)) return "Chrome";
  if (/Safari\//i.test(agent)) return "Safari";
  if (/MSIE\s|Trident\//i.test(agent)) return "Internet Explorer";
  return "Unknown";
}
