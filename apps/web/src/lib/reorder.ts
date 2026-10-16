/** Returns a new array with the item at `from` moved to `to` (both clamped). Pure; used by drag-drop and the keyboard buttons. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  if (target === from) return out;
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item as T);
  return out;
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
