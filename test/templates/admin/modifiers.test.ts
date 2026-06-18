import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { formatCurrency } from "#shared/currency.ts";
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
  active: true,
  calc_kind: "percent",
  calc_value: 10,
  code: "",
  code_index: null,
  direction: "discount",
  id: 1,
  min_subtotal: 0,
  min_visits: 0,
  name: "Early bird",
  scope: "all",
  stock: null,
  total_revenue: 0,
  total_uses: 0,
  trigger: "automatic",
  usage_count: 0,
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

  test("shows the trigger-maintained usage figures", () => {
    const html = adminModifiersPage(
      [mod({ id: 1, total_revenue: 2500, total_uses: 7, usage_count: 3 })],
      SESSION,
    );
    expect(html).toContain("Uses");
    expect(html).toContain("Orders");
    expect(html).toContain("Revenue");
    expect(html).toContain(">7<");
    expect(html).toContain(">3<");
    // total_revenue is in minor units, formatted in the configured currency.
    expect(html).toContain(`>${formatCurrency(2500)}<`);
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
    const html = adminModifierEditPage(
      mod({ min_visits: 2, name: "Loyalty" }),
      SESSION,
    );
    expect(html).toContain("Edit Modifier");
    expect(html).toContain("Loyalty");
    expect(html).toContain('value="10"');
    expect(html).toContain('name="min_visits"');
    expect(html).toContain('value="2"');
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

describe("adminModifierEditPage scope editor", () => {
  test("renders listing checkboxes (with current links checked)", () => {
    const html = adminModifierEditPage(
      mod({ scope: "listings" }),
      SESSION,
      undefined,
      {
        kind: "listings",
        options: [{ id: 7, name: "VIP Pass" }],
        selected: [7],
      },
    );
    expect(html).toContain("Linked listings");
    expect(html).toContain("VIP Pass");
    expect(html).toContain('name="listing_ids"');
    expect(html).toContain("checked");
  });

  test("renders group checkboxes for a groups-scoped modifier", () => {
    const html = adminModifierEditPage(
      mod({ scope: "groups" }),
      SESSION,
      undefined,
      { kind: "groups", options: [{ id: 3, name: "Weekend" }], selected: [] },
    );
    expect(html).toContain("Linked groups");
    expect(html).toContain("Weekend");
    expect(html).toContain('name="group_ids"');
  });

  test("shows an empty note when nothing is linkable", () => {
    const html = adminModifierEditPage(
      mod({ scope: "listings" }),
      SESSION,
      undefined,
      { kind: "listings", options: [], selected: [] },
    );
    expect(html).toContain("Nothing available to link yet");
  });

  test("omits the scope editor for a whole-order modifier", () => {
    const html = adminModifierEditPage(mod(), SESSION);
    expect(html).not.toContain("Linked listings");
    expect(html).not.toContain("Linked groups");
  });
});
