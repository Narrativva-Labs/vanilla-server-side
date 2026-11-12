/** Process-local protection. Addresses are never logged and are removed within two minutes. */
// Sized for shared addresses (office, mobile carrier): 28 visitors at once from one address
// hold about 84 deliveries, which the earlier 30 refused.
const PER_MINUTE = 1200;
const ACTIVE_PER_ADDRESS = 100;
const ACTIVE_TOTAL = 300;

export function createRateLimit() {
  const visitors = new Map<string, { count: number; active: number; expires: number }>();
  let active = 0;
  const sweep = () => {
    const now = Date.now();
    for (const [key, item] of visitors) {
      if (item.expires <= now && item.active === 0) visitors.delete(key);
    }
  };
  return {
    sweep,
    claim(ip: string) {
      const now = Date.now();
      sweep();
      let visitor = visitors.get(ip);
      if (!visitor) {
        if (visitors.size >= 10000) {
          const idle = [...visitors].find(([, item]) => item.active === 0);
          if (idle) visitors.delete(idle[0]);
          else return undefined;
        }
        visitor = { count: 0, active: 0, expires: now + 60000 };
        visitors.set(ip, visitor);
      } else if (visitor.expires <= now) {
        // A new minute starts even while a request is in flight: shared addresses are rarely idle.
        visitor.count = 0;
        visitor.expires = now + 60000;
      }
      if (
        visitor.count >= PER_MINUTE ||
        visitor.active >= ACTIVE_PER_ADDRESS ||
        active >= ACTIVE_TOTAL
      )
        return undefined;
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
