// The CLI describe document for the group and listing write bodies. The
// schemas in the admin API table produce these field lists, so a body shape
// change in the shared record modules must show up here.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { describeEntries } from "#cli/describe.ts";
import { fieldsBody, testTable } from "#test-utils/cli-table.ts";

describe("CLI describe body fields", () => {
  test("describes the group and listing write bodies from their field lists", () => {
    const doc = describeEntries(Object.entries(testTable));

    const groupFields = [
      ["description", "string", false],
      ["hidden", "boolean", false],
      ["hide_package_listings", "boolean", false],
      ["is_package", "boolean", false],
      ["max_attendees", "number", false],
    ] as const;
    const groupTail = [
      ["scan_checks_in_all_listings", "boolean", false],
      ["show_hidden_listings", "boolean", false],
      ["terms_and_conditions", "string", false],
      ["package_members", "array", false, "object"],
    ] as const;

    expect(doc.resources.groups!.verbs.create).toEqual(
      fieldsBody(...groupFields, ["name", "string", true], ...groupTail),
    );
    expect(doc.resources.groups!.verbs.update).toEqual(
      fieldsBody(...groupFields, ["name", "string", false], ...groupTail, [
        "slug",
        "string",
        false,
      ]),
    );

    const listingFields = [
      ["active", "boolean", false],
      ["assign_built_site", "boolean", false],
      ["bookable_alone", "boolean", false],
      ["bookable_days", "array", false, "unknown"],
      ["can_pay_more", "boolean", false],
      ["closes_at", "string", false],
      ["customisable_days", "boolean", false],
      ["date", "string", false],
      ["day_prices", "unknown", false],
      ["description", "string", false],
      ["duration_days", "number", false],
      ["fields", "string", false],
      ["hidden", "boolean", false],
      ["initial_site_months", "number", false],
      ["listing_type", "unknown", false],
      ["location", "string", false],
      ["max_attendees", "number", false],
      ["maximum_days_after", "number", false],
      ["max_price", "number", false],
      ["max_quantity", "number", false],
      ["minimum_days_before", "number", false],
      ["min_quantity", "number", false],
      ["months_per_unit", "number", false],
    ] as const;
    const listingTail = [
      ["non_transferable", "boolean", false],
      ["purchase_only", "boolean", false],
      ["recurring_interval", "unknown", false],
      ["recurring_price", "number", false],
      ["thank_you_url", "string", false],
      ["unit_price", "number", false],
      ["use_defaults", "boolean", false],
      ["uses_logistics", "boolean", false],
      ["webhook_url", "string", false],
      ["attribute_option_ids", "array", false, "number"],
      ["child_listing_ids", "array", false, "number"],
      ["group_ids", "array", false, "number"],
    ] as const;

    expect(doc.resources.listings!.verbs.create).toEqual(
      fieldsBody(...listingFields, ["name", "string", true], ...listingTail),
    );
    expect(doc.resources.listings!.verbs.update).toEqual(
      fieldsBody(...listingFields, ["name", "string", false], ...listingTail, [
        "slug",
        "string",
        false,
      ]),
    );
  });
});
