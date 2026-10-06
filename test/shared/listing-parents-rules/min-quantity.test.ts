/** The minimum-quantity edge rule (the last EDGE_ERROR_RULES entry): a child
 *  listing always sells at least one per purchase, because its quantity
 *  follows the parent it is booked under. Split from the main edge-rule file
 *  to keep both under the ~400-line target. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { edgeFieldError } from "#shared/listing-parents-rules.ts";
import { edgeListing as listing } from "./helpers.ts";

/** The i18n message a broken edge rule reports for the named listing — the
 *  same key production formats, so tests assert WHICH rule won without
 *  re-typing the English copy. */
const ruleError = (messageKey: string, name: string): string =>
  t(`listings_table.children_err_${messageKey}`, { name });

describe("edgeFieldError minimum quantity", () => {
  test("the child-minimum error resolves to real copy naming the child, not a raw key", () => {
    const message = edgeFieldError(
      listing(),
      listing({ min_quantity: 2, name: "Bundled" }),
    );
    expect(message).toContain("'Bundled'");
    expect(message).not.toContain("children_err");
  });

  test("refuses a child whose minimum is above one", () => {
    expect(
      edgeFieldError(listing(), listing({ min_quantity: 2, name: "Bundled" })),
    ).toBe(ruleError("child_min_quantity", "Bundled"));
  });

  test("a child with the default minimum of one passes", () => {
    expect(
      edgeFieldError(listing(), listing({ min_quantity: 1, name: "Child" })),
    ).toBeNull();
  });

  test("a parent may carry a minimum", () => {
    expect(
      edgeFieldError(
        listing({ min_quantity: 5, name: "Parent" }),
        listing({ name: "Child" }),
      ),
    ).toBeNull();
  });

  test("the duration rule still wins on a pairing that breaks both", () => {
    // The minimum rule sits last, so the more fundamental span clash is
    // reported first.
    const parent = listing({
      duration_days: 3,
      listing_type: "daily",
      name: "Parent",
    });
    const child = listing({
      duration_days: 5,
      listing_type: "daily",
      min_quantity: 2,
      name: "Cabin",
    });
    expect(edgeFieldError(parent, child)).toBe(
      t("listings_table.children_err_child_duration", {
        name: "Cabin",
        offered: "3 days",
        priced: "5 days",
      }),
    );
  });
});
