import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { formatCurrency } from "#shared/currency.ts";
import { account } from "#shared/ledger/account.ts";
import {
  adminModifierDeletePage,
  adminModifierEditPage,
  adminModifierNewPage,
  adminModifiersPage,
} from "#templates/admin/modifiers/pages.tsx";
import { setTestEnv, setupTestEncryptionKey } from "#test-utils/env.ts";
import { testModifier } from "#test-utils/factories.ts";

const SESSION = { adminLevel: "owner" as const };
const mod = testModifier;

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminModifiersPage", () => {
  test("renders a rule summary and edit link for each modifier", () => {
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
    expect(html).toContain('href="/admin/modifiers/new"');
    expect(html).toContain("/admin/modifiers/1/edit");
    expect(html).toContain("/admin/guide#modifiers");
  });

  test("shows the trigger-maintained usage figures", () => {
    const html = adminModifiersPage(
      [mod({ id: 1, total_revenue: 2500, total_uses: 7, usage_count: 3 })],
      SESSION,
    );
    expect(html).toContain("Uses");
    expect(html).toContain("Orders");
    expect(html).toContain("Revenue");
    // Each count/money column carries its own alignment class on the cell:
    // uses and orders are quantity columns, revenue is an amount column.
    expect(html).toContain('<td class="col-quantity">7</td>');
    expect(html).toContain('<td class="col-quantity">3</td>');
    expect(html).toContain(
      `<td class="col-amount">${formatCurrency(2500)}</td>`,
    );
  });

  test("shows an empty state when there are no modifiers", () => {
    const html = adminModifiersPage([], SESSION);
    expect(html).toContain("No modifiers configured");
  });

  test("hides create and edit actions in read-only mode", () => {
    const restore = setTestEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    try {
      const html = adminModifiersPage([mod()], SESSION);
      expect(html).not.toContain("Add Modifier");
      expect(html).not.toContain("/admin/modifiers/1/edit");
      expect(html).toContain("Modifier");
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
    expect(html).toContain("/admin/guide#modifiers");
    expect(html).toContain('action="/admin/modifiers"');
    expect(html).toContain("/icons.svg#plus");
    // The create page marks the Modifiers section active in the admin nav.
    expect(html).toContain('<a class="active" href="/admin/modifiers">');
  });
});

describe("adminModifierEditPage", () => {
  test("renders the edit form pre-filled with the modifier and its actions", () => {
    const html = adminModifierEditPage(
      mod({
        min_visits: 2,
        name: "Loyalty",
        total_revenue: 2500,
        total_uses: 7,
        usage_count: 3,
      }),
      SESSION,
    );
    expect(html).toContain("Edit Modifier");
    expect(html).toContain("Loyalty");
    expect(html).toContain('value="10"');
    expect(html).toContain("Running totals");
    expect(html).toContain("/admin/modifiers/recalculate/1");
    expect(html).toContain('name="min_visits"');
    expect(html).toContain('value="2"');
    expect(html).toContain("Delete Modifier");
    // The delete action is a danger link inside the page's actions row.
    expect(html).toContain(
      '<p class="actions"><a class="danger" href="/admin/modifiers/1/delete">',
    );
    expect(html).toContain("/admin/guide#modifiers");
    expect(html).toContain('<a class="active" href="/admin/modifiers">');
  });

  test("renders the separate revenue-correction form", () => {
    const html = adminModifierEditPage(
      mod({ name: "Loyalty", total_revenue: 2500 }),
      SESSION,
    );
    expect(html).toContain("<h2>Adjust revenue</h2>");
    expect(html).toContain('action="/admin/modifiers/1/revenue"');
    expect(html).toContain('name="total_revenue"');
    expect(html).toContain("This adds a correction to Money.");
  });

  test("shows a modifier ledger add-entry action only when a ledger is passed", () => {
    const withLedger = adminModifierEditPage(
      mod({ id: 1, name: "Helmet hire" }),
      SESSION,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        account: account("modifier", 1),
        lines: [],
        names: {
          attendees: new Map(),
          listings: new Map(),
          modifiers: new Map([[1, "Helmet hire"]]),
        },
      },
    );
    expect(withLedger).toContain("Add money change");
    expect(withLedger).toContain(
      'href="/admin/ledger/modifier/1/add?return_url=%2Fadmin%2Fmodifiers%2F1%2Fedit"',
    );
    // No ledger passed → no embedded statement section.
    expect(adminModifierEditPage(mod({ id: 1 }), SESSION)).not.toContain(
      "Add money change",
    );
  });

  test("renders the trigger 'code' option and labelled promo-code field", () => {
    const html = adminModifierEditPage(mod(), SESSION);
    expect(html).toContain('<option value="code">Promo code</option>');
    expect(html).toContain('<label>Promo code<input name="code"');
  });

  test("wires in the scope editor only when scope links are passed", () => {
    const scoped = adminModifierEditPage(
      mod({ scope: "listings" }),
      SESSION,
      undefined,
      {
        kind: "listings",
        options: [{ active: true, id: 7, name: "VIP Pass" }],
        selected: [7],
      },
    );
    expect(scoped).toContain("Linked listings");
    expect(scoped).toContain("VIP Pass");
    // A whole-order modifier passes no links → no scope editor.
    const unscoped = adminModifierEditPage(mod(), SESSION);
    expect(unscoped).not.toContain("Linked listings");
    expect(unscoped).not.toContain("Linked groups");
  });

  test("wires in the answer editor only when answer links are passed", () => {
    const answered = adminModifierEditPage(
      mod({ trigger: "answer" }),
      SESSION,
      undefined,
      null,
      undefined,
      { options: [{ id: 10, name: "Size — Large" }], selected: [10] },
    );
    expect(answered).toContain("Linked answers");
    expect(answered).toContain("Size — Large");
    // No answer links → no answer editor.
    expect(adminModifierEditPage(mod(), SESSION)).not.toContain(
      "Linked answers",
    );
  });
});

describe("adminModifierDeletePage", () => {
  test("renders a confirmation form keyed on the modifier name", () => {
    const html = adminModifierDeletePage(mod({ name: "Loyalty" }), SESSION);
    expect(html).toContain("Delete Modifier");
    expect(html).toContain("Loyalty");
    expect(html).toContain('name="confirm_identifier"');
    expect(html).toContain('<a class="active" href="/admin/modifiers">');
    // Removing a modifier is not a data-loss action, so the confirm button is
    // not danger-styled (danger: false) — unlike the image/listing deletes.
    expect(html).not.toContain('class="danger"');
  });
});
