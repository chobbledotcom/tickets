import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { Modifier } from "#shared/types.ts";
import {
  adminModifierDeletePage,
  adminModifierEditPage,
  adminModifierNewPage,
  adminModifiersPage,
} from "#templates/admin/modifiers.tsx";
import { setTestEnv, setupTestEncryptionKey } from "#test-utils";

const SESSION = { adminLevel: "owner" as const };

const mod = (overrides: Partial<Modifier> = {}): Modifier => ({
  calc_kind: "percent",
  calc_value: 10,
  direction: "discount",
  id: 1,
  name: "Early bird",
  ...overrides,
});

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminModifiersPage", () => {
  test("renders a rule summary for each modifier kind", () => {
    const html = adminModifiersPage(
      [
        mod({ calc_kind: "percent", direction: "discount", id: 1 }),
        mod({
          calc_kind: "fixed",
          calc_value: 500,
          direction: "charge",
          id: 2,
        }),
        mod({ calc_kind: "multiply", calc_value: 1.5, id: 3 }),
      ],
      SESSION,
    );
    expect(html).toContain("Discount · 10%");
    expect(html).toContain("Charge · 500");
    expect(html).toContain("Multiply · ×1.5");
    expect(html).toContain("Add Modifier");
    // The name links to the edit page; there is no separate actions column.
    expect(html).toContain("/admin/modifiers/1/edit");
  });

  test("shows an empty state when there are no modifiers", () => {
    const html = adminModifiersPage([], SESSION);
    expect(html).toContain("No modifiers configured");
  });

  test("hides edit actions in read-only mode", () => {
    const restore = setTestEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    try {
      const html = adminModifiersPage([mod()], SESSION);
      expect(html).not.toContain("Add Modifier");
      // The name still links to the edit page for navigation.
      expect(html).toContain("/admin/modifiers/1/edit");
    } finally {
      restore();
    }
  });
});

describe("adminModifierNewPage", () => {
  test("renders the create form", () => {
    const html = adminModifierNewPage(SESSION);
    expect(html).toContain("Add Modifier");
    expect(html).toContain("Create Modifier");
    expect(html).toContain("Name");
    expect(html).toContain("Type");
    expect(html).toContain("Direction");
  });
});

describe("adminModifierEditPage", () => {
  test("renders the edit form pre-filled with the modifier", () => {
    const html = adminModifierEditPage(mod({ name: "Loyalty" }), SESSION);
    expect(html).toContain("Edit Modifier");
    expect(html).toContain("Loyalty");
    expect(html).toContain('value="10"');
    // The delete action lives on the edit page.
    expect(html).toContain("Delete Modifier");
    expect(html).toContain("/admin/modifiers/1/delete");
  });
});

describe("adminModifierDeletePage", () => {
  test("renders a confirmation form keyed on the modifier name", () => {
    const html = adminModifierDeletePage(mod({ name: "Loyalty" }), SESSION);
    expect(html).toContain("Delete Modifier");
    expect(html).toContain("Loyalty");
    expect(html).toContain('name="confirm_identifier"');
  });
});
