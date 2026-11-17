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
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { testModifier } from "#test-utils/factories.ts";

const setupModifierPageTest = setupFeaturePageTest("modifiers");

describe("ModifierRunningTotalsSection", () => {
  beforeAll(setupModifierPageTest);
  afterAll(resetFeaturePageTest);

  test("renders the two count aggregates and a recalculate link", () => {
    const html = String(
      ModifierRunningTotalsSection({
        modifier: testModifier({ id: 1, totalUses: 7, usageCount: 3 }),
      }),
    );
    expectIncludesAll(html, [
      "Running totals",
      'name="totalUses"',
      'value="7"',
      'name="usageCount"',
      'value="3"',
      "/admin/modifiers/recalculate/1",
    ]);
    // The money total is projected from the ledger, not a running-totals field.
    assert(!html.includes('name="totalRevenue"'));
  });
});

describe("adminModifierRecalculatePage", () => {
  beforeAll(setupModifierPageTest);
  afterAll(resetFeaturePageTest);

  test("shows current and attendee-derived totals for the count aggregates", () => {
    const html = adminModifierRecalculatePage(
      testModifier({ name: "Loyalty" }),
      {
        totalUses: { current: 9, recalculated: 4 },
        usageCount: { current: 5, recalculated: 2 },
      },
      OWNER_SESSION,
    );
    expectIncludesAll(html, [
      "Recalculate: Loyalty",
      "Current",
      "From attendee data",
      'name="recalculateFields"',
      'value="totalUses"',
      ">9<",
      ">4<",
      ">5<",
      ">2<",
      // The page marks the Modifiers section active in the admin nav.
      '<a class="active" href="/admin/modifiers">',
    ]);
    // total_revenue projects from the ledger, so it is not recalculable here.
    assert(!html.includes('value="total_revenue"'));
  });

  test("passes an error message through to the recalculate page", () => {
    const html = adminModifierRecalculatePage(
      testModifier({ name: "Loyalty" }),
      {
        totalUses: { current: 1, recalculated: 1 },
        usageCount: { current: 1, recalculated: 1 },
      },
      OWNER_SESSION,
      "Something went wrong",
    );
    assertStringIncludes(html, "Something went wrong");
  });
});
