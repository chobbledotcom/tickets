import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
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

/** POST a modifier create and assert the list page flashes its success. */
export const expectCreated = async (
  data: Record<string, string>,
  message = "Modifier created",
): Promise<void> => {
  const { response } = await adminFormPost("/admin/modifiers", data);
  await expectFlashRedirect("/admin/modifiers", message, true)(response);
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

/** Register one table of accepted creates: each names its test, sends its
 *  overrides, and names the stored fields the row must carry. */
export const createAcceptanceTests = (
  cases: readonly (readonly [
    string,
    Record<string, string>,
    Partial<Modifier>,
  ])[],
): void => {
  for (const [name, data, stored] of cases) {
    test(name, async () => {
      expect(await createModifier(data)).toMatchObject(stored);
    });
  }
};

/** Register one table of refused creates: each names its test, sends its
 *  overrides, and names the message the page flashes back. */
export const createRefusalTests = (
  cases: readonly (readonly [string, Record<string, string>, string])[],
): void => {
  for (const [name, data, message] of cases) {
    test(name, async () => {
      await expectCreateRefused(createData(data), message);
    });
  }
};
