import { assert, assertStringIncludes } from "@std/assert";
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
    assertStringIncludes(html, "Running totals");
    assertStringIncludes(html, 'name="total_uses"');
    assertStringIncludes(html, 'value="7"');
    assertStringIncludes(html, 'name="usage_count"');
    assertStringIncludes(html, 'value="3"');
    assertStringIncludes(html, "/admin/modifiers/recalculate/1");
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
    assertStringIncludes(html, "Recalculate: Loyalty");
    assertStringIncludes(html, "Current");
    assertStringIncludes(html, "From attendee data");
    assertStringIncludes(html, 'name="recalculate_fields"');
    assertStringIncludes(html, 'value="total_uses"');
    assertStringIncludes(html, ">9<");
    assertStringIncludes(html, ">4<");
    assertStringIncludes(html, ">5<");
    assertStringIncludes(html, ">2<");
    // The page marks the Modifiers section active in the admin nav.
    assertStringIncludes(html, '<a class="active" href="/admin/modifiers">');
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
    assertStringIncludes(html, "Something went wrong");
  });
});
