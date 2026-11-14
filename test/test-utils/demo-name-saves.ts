/** The demo-mode name rule for a record form: with demo mode on, the create
 * and edit saves store a sample name in place of the typed one. */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Saves a record through its form with `name` and returns the stored name. */
type NameSave = (name: string) => Promise<string | undefined>;

export type DemoNameSaves = {
  label: string;
  samples: readonly string[];
  realName: string;
  typedName: string;
  /** The create form's path and its fields for a record called `name`. */
  createPath: string;
  fields: (name: string) => TestFormValues;
  /** The table the create form writes. The test starts it empty. */
  table: { read: { many: () => Promise<{ name: string }[]> } };
  edit: NameSave;
};

export const describeDemoNameSaves = (spec: DemoNameSaves): void => {
  const { label, samples, realName, typedName, edit } = spec;
  const create: NameSave = async (name) => {
    await adminFormPost(spec.createPath, spec.fields(name));
    const [created] = await spec.table.read.many();
    return created?.name;
  };
  describeWithEnv(label, { db: true }, () => {
    afterEach(() => {
      setDemoModeForTest(false);
    });

    for (const [action, save] of [
      ["create", create],
      ["edit", edit],
    ] as const) {
      test(`stores a sample name in place of the typed one on ${action}`, async () => {
        setDemoModeForTest(true);
        expect(samples).toContain(await save(realName));
      });
    }

    test("stores the typed name on create and edit while demo mode is off", async () => {
      expect(await create(realName)).toBe(realName);
      expect(await edit(typedName)).toBe(typedName);
    });
  });
};
