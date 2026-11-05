export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function toCommandArray(item: unknown): unknown[] | undefined {
  if (Array.isArray(item)) return item;
  if (
    !isObject(item) ||
    typeof item.length !== "number" ||
    !Number.isInteger(item.length) ||
    item.length < 1 ||
    item.length > 10
  )
    return;
  return Array.from(item as unknown as ArrayLike<unknown>);
}
export function normalizeEventItem(item: unknown) {
  const command = toCommandArray(item);
  const raw =
    command?.[0] === "event" && typeof command[1] === "string"
      ? { ...(isObject(command[2]) ? command[2] : {}), event: command[1] }
      : item;
  if (!isObject(raw) || typeof raw.event !== "string") return;
  const { event, ecommerce, ...params } = raw;
  // Flatten the standard ecommerce envelope; preserve values and items without guessing aliases.
  const {
    send_to: _destination,
    event_callback: _callback,
    event_timeout: _timeout,
    ...clean
  } = {
    ...params,
    ...(isObject(ecommerce) ? ecommerce : {}),
  };
  return { name: event, params: clean };
}
