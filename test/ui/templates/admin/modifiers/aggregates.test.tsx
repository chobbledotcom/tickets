import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { settings } from "#shared/db/settings.ts";
import {
  adminModifierRecalculatePage,
  ModifierRunningTotalsSection,
} from "#templates/admin/modifiers/aggregates.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testModifier } from "#test-utils/factories.ts";
import { featureSetting } from "#test-utils/settings.ts";

const SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
  settings.setForTest(featureSetting("modifiers"));
});

afterAll(() => settings.clearTestOverride("enabled_features"));

describe("ModifierRunningTotalsSection", () => {
  test("renders the two count aggregates and a recalculate link", () => {
    const html = String(
      ModifierRunningTotalsSection({
        modifier: testModifier({ id: 1, total_uses: 7, usage_count: 3 }),
      }),
    );
    expect(html).toContain("Running totals");
    expect(html).toContain('name="total_uses"');
    expect(html).toContain('value="7"');
    expect(html).toContain('name="usage_count"');
    expect(html).toContain('value="3"');
    expect(html).toContain("/admin/modifiers/recalculate/1");
    // The money total is projected from the ledger, not a running-totals field.
    expect(html).not.toContain('name="total_revenue"');
  });
});

describe("adminModifierRecalculatePage", () => {
  test("shows current and attendee-derived totals for the count aggregates", () => {
    const html = adminModifierRecalculatePage(
      testModifier({ name: "Loyalty" }),
      {
        total_uses: { current: 9, recalculated: 4 },
        usage_count: { current: 5, recalculated: 2 },
      },
      SESSION,
    );
    expect(html).toContain("Recalculate: Loyalty");
    expect(html).toContain("Current");
    expect(html).toContain("From attendee data");
    expect(html).toContain('name="recalculate_fields"');
    expect(html).toContain('value="total_uses"');
    expect(html).toContain(">9<");
    expect(html).toContain(">4<");
    expect(html).toContain(">5<");
    expect(html).toContain(">2<");
    // The page marks the Modifiers section active in the admin nav.
    expect(html).toContain('<a class="active" href="/admin/modifiers">');
    // total_revenue projects from the ledger, so it is not recalculable here.
    expect(html).not.toContain('value="total_revenue"');
  });

  test("passes an error message through to the recalculate page", () => {
    const html = adminModifierRecalculatePage(
      testModifier({ name: "Loyalty" }),
      {
        total_uses: { current: 1, recalculated: 1 },
        usage_count: { current: 1, recalculated: 1 },
      },
      SESSION,
      "Something went wrong",
    );
    expect(html).toContain("Something went wrong");
  });
});
