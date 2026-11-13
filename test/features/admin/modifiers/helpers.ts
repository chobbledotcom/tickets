import { getAllModifiers } from "#db/modifiers.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { adminFormPost } from "#test-utils/session.ts";
import type { Modifier } from "#types";

/** Default valid create payload; override per test. */
export const createData = (
  overrides: Record<string, string> = {},
): Record<string, string> => ({
  active: "1",
  calc_kind: "percent",
  calc_value: "10",
  direction: "discount",
  name: "Early bird",
  ...overrides,
});

/** POST a modifier create and assert the create page flashes `message`. */
export const expectCreateRefused = async (
  data: Record<string, string>,
  message: string,
): Promise<void> => {
  const { response } = await adminFormPost("/admin/modifiers", data);
  await expectFlashRedirect("/admin/modifiers/new", message, false)(response);
};

export const lastModifier = async (): Promise<Modifier> => {
  const all = await getAllModifiers();
  return all[all.length - 1]!;
};

/** Create a modifier and return the stored row. */
export const createModifier = async (
  data: Record<string, string> = {},
): Promise<Modifier> => {
  await adminFormPost("/admin/modifiers", createData(data));
  return lastModifier();
};
