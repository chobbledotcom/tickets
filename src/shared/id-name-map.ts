import { mapById } from "#fp";

/**
 * Build a lookup from each item's id to its name. Used wherever a list of
 * records (listings, agents, pages, …) needs a quick id → name map for
 * rendering, run sheets, or CSV exports.
 */
export const idNameMap = <T extends { id: number; name: string }>(
  items: readonly T[],
): Map<number, string> => mapById((item: T) => item.name)(items);
