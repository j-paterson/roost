/** Move `source` to be immediately after `target` in `list`. Returns a new array. */
export function moveInList(list: string[], source: string, target: string): string[] {
  const without = list.filter((n) => n !== source);
  const targetIdx = without.indexOf(target);
  if (targetIdx === -1) return [...list];
  const insertAt = targetIdx + 1;
  return [...without.slice(0, insertAt), source, ...without.slice(insertAt)];
}
