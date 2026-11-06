/** Google Ads click IDs from the landing URL. They leave the browser only with ad consent. */
export function clickIds(href: string): Record<string, string> | undefined {
  const params = new URL(href).searchParams;
  const found: Record<string, string> = {};
  for (const key of ["gclid", "gbraid", "wbraid"]) {
    const value = params.get(key);
    if (value && /^[\w-]{1,256}$/.test(value)) found[key] = value;
  }
  return Object.keys(found).length ? found : undefined;
}
