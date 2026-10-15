import { assert } from "@std/assert";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminModifierRecalculatePage,
  ModifierRunningTotalsSection,
} from "#templates/admin/modifiers/aggregates.tsx";
import {
  resetFeaturePageTest,
  setupFeaturePageTest,
} from "#test/ui/templates/admin/feature-page-test.ts";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { testModifier } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

const setupModifierPageTest = setupFeaturePageTest("modifiers");

describe("ModifierRunningTotalsSection", () => {
  beforeAll(setupModifierPageTest);
  afterAll(resetFeaturePageTest);

  test("renders the two count aggregates and a recalculate link", () => {
    const html = String(
      ModifierRunningTotalsSection({
        modifier: testModifier({ id: 1, total_uses: 7, usage_count: 3 }),
      }),
    );
    says(html, "Running totals");
    says(html, 'name="total_uses"');
    says(html, 'value="7"');
    says(html, 'name="usage_count"');
    says(html, 'value="3"');
    says(html, "/admin/modifiers/recalculate/1");
    // The money total is projected from the ledger, not a running-totals field.
    assert(!html.includes('name="total_revenue"'));
  });
});

describe("adminModifierRecalculatePage", () => {
  beforeAll(setupModifierPageTest);
  afterAll(resetFeaturePageTest);

  test("shows current and attendee-derived totals for the count aggregates", () => {
    const html = adminModifierRecalculatePage(
      testModifier({ name: "Loyalty" }),
      {
        total_uses: { current: 9, recalculated: 4 },
        usage_count: { current: 5, recalculated: 2 },
      },
      OWNER_SESSION,
    );
    says(html, "Recalculate: Loyalty");
    says(html, "Current");
    says(html, "From attendee data");
    says(html, 'name="recalculate_fields"');
    says(html, 'value="total_uses"');
    says(html, ">9<");
    says(html, ">4<");
    says(html, ">5<");
    says(html, ">2<");
    // The page marks the Modifiers section active in the admin nav.
    says(html, '<a class="active" href="/admin/modifiers">');
    // total_revenue projects from the ledger, so it is not recalculable here.
    assert(!html.includes('value="total_revenue"'));
  });

  test("passes an error message through to the recalculate page", () => {
    const html = adminModifierRecalculatePage(
      testModifier({ name: "Loyalty" }),
      {
        total_uses: { current: 1, recalculated: 1 },
        usage_count: { current: 1, recalculated: 1 },
      },
      OWNER_SESSION,
      "Something went wrong",
    );
    says(html, "Something went wrong");
  });
});
