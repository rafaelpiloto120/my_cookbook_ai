export function formatEconomyUnits(
  t: (key: string, options?: any) => string,
  count: number
) {
  const rounded = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  return t("economy.currency", {
    count: rounded,
    defaultValue: rounded === 1 ? "{{count}} Egg" : "{{count}} Eggs",
  });
}
