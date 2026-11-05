/** Process-local protection. Addresses expire after one minute and are never logged. */
export function createRateLimit() {
  const visitors = new Map<string, { count: number; active: number; expires: number }>();
  let active = 0;
  return {
    claim(ip: string) {
      const now = Date.now();
      for (const [key, item] of visitors) {
        if (item.expires <= now && item.active === 0) visitors.delete(key);
      }
      let visitor = visitors.get(ip);
      if (!visitor) {
        if (visitors.size >= 10000) {
          const idle = [...visitors].find(([, item]) => item.active === 0);
          if (idle) visitors.delete(idle[0]);
          else return undefined;
        }
        visitor = { count: 0, active: 0, expires: now + 60000 };
        visitors.set(ip, visitor);
      }
      if (visitor.count >= 300 || visitor.active >= 10 || active >= 100) return undefined;
      visitor.count++;
      visitor.active++;
      active++;
      return () => {
        visitor.active--;
        active--;
      };
    },
    clear() {
      visitors.clear();
    },
  };
}
