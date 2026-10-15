import { assert, assertStringIncludes } from "@std/assert";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import { formatCurrency } from "#shared/currency.ts";
import {
  adminModifierDeletePage,
  adminModifierNewPage,
  adminModifiersPage,
} from "#templates/admin/modifiers/pages.tsx";
import {
  resetFeaturePageTest,
  setupFeaturePageTest,
} from "#test/ui/templates/admin/feature-page-test.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";
import { testModifier } from "#test-utils/factories.ts";

const mod = testModifier;

const setupModifierPageTest = setupFeaturePageTest("modifiers");

describe("adminModifiersPage", () => {
  beforeAll(setupModifierPageTest);
  afterAll(resetFeaturePageTest);

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
      OWNER_SESSION,
    );
    assertStringIncludes(html, "Discount · 10%");
    assertStringIncludes(html, "Charge · 500");
    assertStringIncludes(html, "Multiply · ×1.5");
    assertStringIncludes(html, 'href="/admin/modifiers/new"');
    assertStringIncludes(html, "/admin/modifiers/1/edit");
    assertStringIncludes(html, "/admin/guide#modifiers");
  });

  test("shows the trigger-maintained usage figures", () => {
    const html = adminModifiersPage(
      [mod({ id: 1, total_revenue: 2500, total_uses: 7, usage_count: 3 })],
      OWNER_SESSION,
    );
    assertStringIncludes(html, "Uses");
    assertStringIncludes(html, "Orders");
    assertStringIncludes(html, "Revenue");
    // Each count/money column carries its own alignment class on the cell:
    // uses and orders are quantity columns, revenue is an amount column.
    assertStringIncludes(html, '<td class="col-quantity">7</td>');
    assertStringIncludes(html, '<td class="col-quantity">3</td>');
    assertStringIncludes(
      html,
      `<td class="col-amount">${formatCurrency(2500)}</td>`,
    );
  });

  test("shows an empty state when there are no modifiers", () => {
    const html = adminModifiersPage([], OWNER_SESSION);
    assertStringIncludes(html, "<p>No modifiers configured.</p>");
  });

  test("hides create and edit actions in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminModifiersPage([mod()], OWNER_SESSION);
    assert(
      !html.includes("Add Modifier"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("/admin/modifiers/1/edit"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "Modifier");
  });
});

describe("adminModifierNewPage", () => {
  beforeAll(setupModifierPageTest);
  afterAll(resetFeaturePageTest);

  test("renders the create form", () => {
    const html = adminModifierNewPage(OWNER_SESSION);
    assertStringIncludes(html, "Add Modifier");
    assertStringIncludes(html, "Create Modifier");
    assertStringIncludes(html, "Name");
    assertStringIncludes(html, "Type");
    assertStringIncludes(html, "Direction");
    assertStringIncludes(html, "/admin/guide#modifiers");
    assertStringIncludes(html, 'action="/admin/modifiers"');
    assertStringIncludes(html, "/icons.svg#plus");
    // The create page marks the Modifiers section active in the admin nav.
    assertStringIncludes(html, '<a class="active" href="/admin/modifiers">');
  });
});

describe("adminModifierDeletePage", () => {
  beforeAll(setupModifierPageTest);
  afterAll(resetFeaturePageTest);

  test("renders a confirmation form keyed on the modifier name", () => {
    const html = adminModifierDeletePage(
      mod({ name: "Loyalty" }),
      OWNER_SESSION,
    );
    assertStringIncludes(html, "Delete Modifier");
    assertStringIncludes(html, "Loyalty");
    assertStringIncludes(html, 'name="confirm_identifier"');
    assertStringIncludes(html, '<a class="active" href="/admin/modifiers">');
    // Removing a modifier is not a data-loss action, so the confirm button is
    // not danger-styled (danger: false) — unlike the image/listing deletes.
    assert(
      !html.includes('class="danger"'),
      "the value should not contain the searched item",
    );
  });
});
