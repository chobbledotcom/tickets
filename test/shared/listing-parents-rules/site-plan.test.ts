/** The built-site plan endpoint rules on a parent→child edge: a listing that
 *  assigns a site on booking can be neither the parent nor the child. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { edgeFieldError } from "#shared/listing-parents-rules.ts";
import { edgeListing as listing } from "./helpers.ts";

describe("edgeFieldError > built-site plans", () => {
  test("allows an edge where neither endpoint assigns a site", () => {
    expect(edgeFieldError(listing(), listing())).toBeNull();
  });

  test("refuses a parent that assigns a site", () => {
    expect(
      edgeFieldError(
        listing({ assign_built_site: true, name: "Website Plan" }),
        listing({ name: "Child" }),
      ),
    ).toBe(
      t("listings_table.children_err_parent_site_plan", {
        name: "Website Plan",
      }),
    );
  });

  test("refuses a child that assigns a site", () => {
    expect(
      edgeFieldError(
        listing({ name: "Parent" }),
        listing({ assign_built_site: true, name: "Website Plan" }),
      ),
    ).toBe(
      t("listings_table.children_err_child_site_plan", {
        name: "Website Plan",
      }),
    );
  });

  test("the parent rule wins when both endpoints assign a site", () => {
    expect(
      edgeFieldError(
        listing({ assign_built_site: true, name: "Plan Parent" }),
        listing({ assign_built_site: true, name: "Plan Child" }),
      ),
    ).toBe(
      t("listings_table.children_err_parent_site_plan", {
        name: "Plan Parent",
      }),
    );
  });

  test("the site-plan rules win over the daily and duration rules", () => {
    // The child is daily under a standard parent — a daily mismatch too — but
    // the site-plan rule is more fundamental, so its message is reported.
    expect(
      edgeFieldError(
        listing({ name: "Parent" }),
        listing({
          assign_built_site: true,
          duration_days: 5,
          listing_type: "daily",
          name: "Plan Child",
        }),
      ),
    ).toBe(
      t("listings_table.children_err_child_site_plan", {
        name: "Plan Child",
      }),
    );
  });
});
