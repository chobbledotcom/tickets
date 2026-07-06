import { getAllModifiers } from "#shared/db/modifiers.ts";
import type { Modifier } from "#shared/types.ts";

/** Default valid create payload; override per test. */
export const createData = (overrides: Record<string, string> = {}) => ({
  active: "1",
  calc_kind: "percent",
  calc_value: "10",
  direction: "discount",
  name: "Early bird",
  ...overrides,
});

export const lastModifier = async (): Promise<Modifier> => {
  const all = await getAllModifiers();
  return all[all.length - 1]!;
};
