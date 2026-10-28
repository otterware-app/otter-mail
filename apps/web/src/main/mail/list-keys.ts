/** Keys follow values; repeated values keep their occurrence identity. */
export function withOccurrenceKeys<T>(items: T[], keyOf: (item: T) => string) {
  const counts = new Map<string, number>();
  return items.map((item, index) => {
    const value = keyOf(item);
    const occurrence = counts.get(value) ?? 0;
    counts.set(value, occurrence + 1);
    return { item, index, key: `${value}:${occurrence}` };
  });
}
