import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { validateSpecSources } from "#scripts/specs/profile.ts";
import {
  registry,
  source,
  validFeature,
} from "#test/scripts/specs/profile-fixture.ts";

describe("Cucumber catalog descriptions", () => {
  test("preserves Markdown blocks in Feature descriptions", () => {
    const markdown = validFeature.replace(
      "  Customers get a clear result when the last place is taken during payment.",
      "  Customers get a clear result.\n\n  - Payment is confirmed.\n  - The result is shown.",
    );

    expect(validateSpecSources([source(markdown)], registry).stories).toEqual([
      expect.objectContaining({
        description:
          "Customers get a clear result.\n\n- Payment is confirmed.\n- The result is shown.",
      }),
    ]);
  });
});
