/** The stored column each field kind gives, read through the listing, group,
 *  and status field lists. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { fieldColumns, fieldColumnsWithId } from "#db/field-columns.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";

/** A visible stand-in for the env-key pair, so a test reads what each
 *  column hands to it. */
const encrypt = (value: string): Promise<EnvKeyEncrypted> =>
  Promise.resolve(`sealed:${value}` as EnvKeyEncrypted);
const decrypt = (value: EnvKeyEncrypted): Promise<string> =>
  Promise.resolve(value.replace(/^sealed:/, ""));

interface DefaultColumn {
  default?: (() => unknown) | undefined;
}

const defaultsOf = (columns: Record<string, DefaultColumn>) =>
  Object.fromEntries(
    Object.entries(columns).flatMap(([name, column]) =>
      column.default ? [[name, column.default()]] : [],
    ),
  );

const listingColumns = fieldColumns("listings", LISTING_FIELDS)(
  encrypt,
  decrypt,
);

describe("field columns", () => {
  test("declares every listing storage default", () => {
    expect(defaultsOf(listingColumns)).toEqual({
      active: true,
      assign_built_site: false,
      bookable_alone: false,
      bookable_days: VALID_DAY_NAMES,
      can_pay_more: false,
      customisable_days: false,
      date: "",
      description: "",
      duration_days: 1,
      fields: "email",
      hidden: false,
      initial_site_months: 0,
      listing_type: "standard",
      location: "",
      max_price: 0,
      max_quantity: 1,
      maximum_days_after: 90,
      min_quantity: 1,
      minimum_days_before: 1,
      months_per_unit: 0,
      non_transferable: false,
      purchase_only: false,
      recurring_interval: "",
      recurring_price: 0,
      thank_you_url: "",
      unit_price: 0,
      use_defaults: false,
      uses_logistics: false,
      webhook_url: "",
    });
  });

  test("declares every group storage default", () => {
    expect(
      defaultsOf(fieldColumns("groups", GROUP_FIELDS)(encrypt, decrypt)),
    ).toEqual({
      description: "",
      hidden: false,
      hide_package_listings: false,
      is_package: false,
      max_attendees: 0,
      scan_checks_in_all_listings: false,
      show_hidden_listings: true,
      terms_and_conditions: "",
    });
  });

  test("gives each weekday default its own copy", () => {
    const first = listingColumns.bookable_days.default?.();
    first?.push("Funday");
    expect(listingColumns.bookable_days.default?.()).toEqual(VALID_DAY_NAMES);
  });

  test("names each stored JSON field by its table when its value is invalid", () => {
    expect(() =>
      listingColumns.bookable_days.read?.("bad json" as never),
    ).toThrow("listings.bookable_days");
    expect(() => listingColumns.day_prices.read?.("bad json" as never)).toThrow(
      "listings.day_prices",
    );
  });

  test("gives a switch field a column that defaults to off, with an id", () => {
    const columns = fieldColumnsWithId("attendee_statuses", STATUS_FIELDS)(
      encrypt,
      decrypt,
    );
    expect([columns.is_reservation.default?.(), columns.id.generated]).toEqual([
      false,
      true,
    ]);
  });

  test("stores a listing date as sealed UTC text, and reads it back", async () => {
    const date = listingColumns.date;
    const written = await date.write?.("2026-06-01T10:00+01:00");

    expect([written, await date.read?.(written as string)]).toEqual([
      "sealed:2026-06-01T09:00:00.000Z",
      "2026-06-01T09:00:00.000Z",
    ]);
    expect(() => date.write?.("not a time")).toThrow(
      "date has invalid datetime: not a time",
    );
  });

  test("names a stored datetime it cannot read", async () => {
    await expect(
      listingColumns.date.read?.("sealed:not a time" as string),
    ).rejects.toThrow("stored datetime has invalid datetime: not a time");
  });

  test("reads a stored date without an offset as UTC", async () => {
    expect(
      await listingColumns.date.read?.("sealed:2026-06-01T10:00" as string),
    ).toBe("2026-06-01T10:00:00.000Z");
  });

  test("reads an empty closing time as no closing time", async () => {
    const closesAt = listingColumns.closes_at;
    expect([
      await closesAt.read?.("sealed:" as string),
      await closesAt.read?.("sealed:2026-06-01T10:00Z" as string),
      await closesAt.write?.("2026-06-01T10:00Z"),
    ]).toEqual([
      null,
      "2026-06-01T10:00:00.000Z",
      "sealed:2026-06-01T10:00:00.000Z",
    ]);
  });

  test("seals private text and keeps the contact-field tokens tidy", async () => {
    expect([
      await listingColumns.location.write?.("Hall"),
      await listingColumns.location.write?.(""),
      await listingColumns.fields.write?.(" email , phone "),
      await listingColumns.duration_days.write?.(9999),
    ]).toEqual(["sealed:Hall", "", "email,phone", 90]);
  });
});
