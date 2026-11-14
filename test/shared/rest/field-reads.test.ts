/** The body, form, and transfer reads one field list declares, shown on the
 *  holiday, status, group, and listing fields. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Holiday, HolidayInput } from "#db/holidays.ts";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { HOLIDAY_FIELDS } from "#shared/records/holiday-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import {
  bodyMappers,
  formFieldsInput,
  formInput,
  readBody,
  transferValues,
} from "#shared/rest/field-reads.ts";
import { fieldsOnDoor } from "#shared/rest/field-specs.ts";
import type { DateString } from "#shared/validation/date-string.ts";

const GROUP_API_FIELDS = fieldsOnDoor(GROUP_FIELDS, "api");
const LISTING_API_FIELDS = fieldsOnDoor(LISTING_FIELDS, "api");

const storedGroup = {
  description: "About",
  hidden: false,
  hide_package_listings: false,
  is_package: true,
  max_attendees: 40,
  scan_checks_in_all_listings: false,
  show_hidden_listings: true,
  terms_and_conditions: "Terms",
};

const storedGroupInput = {
  description: "About",
  hidden: false,
  hidePackageListings: false,
  isPackage: true,
  maxAttendees: 40,
  scanChecksInAllListings: false,
  showHiddenListings: true,
  termsAndConditions: "Terms",
};

/** True when the two types are the same type. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const { toCreateInput, toUpdateInput } = bodyMappers(HOLIDAY_FIELDS);

const stored = {
  end_date: "2026-08-31",
  id: 1,
  name: "Summer Break",
  start_date: "2026-07-01",
};

describe("field reads", () => {
  test("the row and the input follow the field list", () => {
    const shapes: [
      Same<
        Holiday,
        { end_date: string; id: number; name: string; start_date: string }
      >,
      Same<
        HolidayInput,
        { endDate: DateString; name: string; startDate: DateString }
      >,
    ] = [true, true];
    expect(shapes).toEqual([true, true]);
  });

  test("a create reads every field as required, in declaration order", () => {
    const refusals: readonly [Record<string, string>, string][] = [
      [{ end_date: "2026-08-31" }, "name cannot be empty"],
      [{ end_date: "2026-08-31", name: "Summer" }, "start_date is required"],
      [
        { end_date: "2026-08-31", name: "Summer", start_date: "2026-7-1" },
        "start_date has an invalid value",
      ],
      [
        { end_date: "31-08-2026", name: "Summer", start_date: "2026-07-01" },
        "end_date has an invalid value",
      ],
    ];
    for (const [body, error] of refusals) {
      expect(toCreateInput(body)).toEqual({ error, ok: false });
    }
  });

  test("a create keys the cleaned values by their input names", () => {
    expect(
      toCreateInput({
        end_date: " 2026-08-31 ",
        name: " Summer Break ",
        start_date: " 2026-07-01 ",
      }),
    ).toEqual({
      ok: true,
      value: {
        endDate: "2026-08-31",
        name: "Summer Break",
        startDate: "2026-07-01",
      },
    });
  });

  test("an update keeps each stored value it does not supply", () => {
    expect(toUpdateInput({}, stored)).toEqual({
      ok: true,
      value: {
        endDate: "2026-08-31",
        name: "Summer Break",
        startDate: "2026-07-01",
      },
    });
    expect(
      toUpdateInput(
        { end_date: "2026-09-30", name: "Autumn", start_date: "2026-09-01" },
        stored,
      ),
    ).toEqual({
      ok: true,
      value: {
        endDate: "2026-09-30",
        name: "Autumn",
        startDate: "2026-09-01",
      },
    });
  });

  test("an update refuses an unusable value it supplies", () => {
    expect(toUpdateInput({ start_date: "2027-02-30" }, stored)).toEqual({
      error: "start_date has an invalid value",
      ok: false,
    });
    expect(toUpdateInput({ name: "  " }, stored)).toEqual({
      error: "name cannot be empty",
      ok: false,
    });
  });

  test("a switch and a text default on create and keep on update", () => {
    const status = bodyMappers(STATUS_FIELDS);
    const storedStatus = {
      id: 1,
      is_paid_default: false,
      is_public_default: true,
      is_reservation: true,
      name: "Reserved",
      reservation_amount: "10",
    };

    expect(status.toCreateInput({ is_reservation: true, name: "New" })).toEqual(
      {
        ok: true,
        value: {
          isPaidDefault: false,
          isPublicDefault: false,
          isReservation: true,
          name: "New",
          reservationAmount: "",
        },
      },
    );
    expect(
      status.toUpdateInput(
        { is_public_default: false, reservation_amount: "25" },
        storedStatus,
      ),
    ).toEqual({
      ok: true,
      value: {
        isPaidDefault: false,
        isPublicDefault: false,
        isReservation: true,
        name: "Reserved",
        reservationAmount: "25",
      },
    });
    expect(status.toUpdateInput({}, storedStatus)).toEqual({
      ok: true,
      value: {
        isPaidDefault: false,
        isPublicDefault: true,
        isReservation: true,
        name: "Reserved",
        reservationAmount: "10",
      },
    });
  });

  test("a checked form becomes the input the fields declare", () => {
    expect(
      formInput(HOLIDAY_FIELDS)({
        end_date: "2026-12-26",
        name: "Christmas",
        start_date: "2026-12-24",
      }),
    ).toEqual({
      endDate: "2026-12-26",
      name: "Christmas",
      startDate: "2026-12-24",
    });
  });

  test("an API create gives each switch it leaves out its default, and leaves the rest to the column", () => {
    const read = readBody(GROUP_API_FIELDS, { hidden: true }, null);
    expect(read).toEqual({
      ok: true,
      value: {
        hidden: true,
        hidePackageListings: false,
        isPackage: false,
        scanChecksInAllListings: false,
        showHiddenListings: true,
      },
    });
    expect(read.ok && Object.keys(read.value).length).toBe(5);
  });

  test("an API null clears a text field and keeps any other field", () => {
    const read = readBody(
      GROUP_API_FIELDS,
      { description: null, is_package: null, max_attendees: null },
      storedGroup,
    );
    expect(read).toEqual({
      ok: true,
      value: { ...storedGroupInput, description: "" },
    });
  });

  test("an API read refuses the first value its kind does not take", () => {
    expect([
      readBody(GROUP_API_FIELDS, { hidden: "yes", max_attendees: -1 }, null),
      readBody(GROUP_API_FIELDS, { max_attendees: 1.5 }, storedGroup),
      readBody(LISTING_API_FIELDS, { date: "2026-06-01T10:00" }, null),
      readBody(LISTING_API_FIELDS, { closes_at: "" }, null),
    ]).toEqual([
      { error: "hidden has an invalid value", ok: false },
      { error: "max_attendees has an invalid value", ok: false },
      {
        error: "date must be a UTC instant of a real calendar day",
        ok: false,
      },
      {
        error: "closes_at must be a UTC instant of a real calendar day",
        ok: false,
      },
    ]);
  });

  test("an API null empties a listing's times and day prices", () => {
    const read = readBody(
      LISTING_API_FIELDS,
      { closes_at: null, date: null, day_prices: null, listing_type: "daily" },
      null,
    );
    expect(read.ok && read.value).toMatchObject({
      closesAt: "",
      date: "",
      dayPrices: {},
      listingType: "daily",
    });
  });

  test("an API null empties a contact list, a listing type, and a plain text", () => {
    const listing = readBody(
      LISTING_API_FIELDS,
      { fields: null, listing_type: null },
      null,
    );
    const status = bodyMappers(STATUS_FIELDS).toCreateInput({
      name: "New",
      reservation_amount: null,
    });
    expect([
      listing.ok && [listing.value.fields, listing.value.listingType],
      status.ok && status.value.reservationAmount,
    ]).toEqual([["", ""], ""]);
  });

  test("an API update keeps a stored switch that is off when its default is on", () => {
    expect(
      readBody(
        GROUP_API_FIELDS,
        {},
        { ...storedGroup, show_hidden_listings: false },
      ),
    ).toEqual({
      ok: true,
      value: { ...storedGroupInput, showHiddenListings: false },
    });
  });

  test("an API update leaves an unset closing time out of the write", () => {
    const read = readBody(LISTING_API_FIELDS, {}, { closes_at: null });
    expect(read.ok && Object.hasOwn(read.value, "closesAt")).toBe(false);
  });

  test("the form door reads switch boxes and gives each empty box its default", () => {
    expect(
      formFieldsInput(GROUP_FIELDS, {
        description: "Description",
        hidden: "1",
        hide_package_listings: "0",
        is_package: "",
        max_attendees: null,
        name: "Package",
        scan_checks_in_all_listings: "1",
        show_hidden_listings: "1",
        terms_and_conditions: "Terms",
      }),
    ).toEqual({
      description: "Description",
      hidden: true,
      hidePackageListings: false,
      isPackage: false,
      maxAttendees: 0,
      name: "Package",
      scanChecksInAllListings: true,
      showHiddenListings: true,
      termsAndConditions: "Terms",
    });
  });

  test("the form door keeps a zero and reads only the fields on the form", () => {
    const input = formFieldsInput(LISTING_FIELDS, {
      active: false,
      maximum_days_after: 0,
      name: "Listing",
    });
    expect([
      input.maximumDaysAfter,
      input.minimumDaysBefore,
      input.name,
      Object.hasOwn(input, "active"),
    ]).toEqual([0, 1, "Listing", false]);
  });

  test("a transfer leaves out withheld columns and empty day prices", () => {
    const row = {
      attachment_name: "private.pdf",
      day_prices: {},
      name: "Listing",
      webhook_url: "secret",
    };
    expect([
      transferValues(LISTING_FIELDS, row, ["webhook_url"]),
      transferValues(LISTING_FIELDS, { day_prices: { 1: 500 } }),
    ]).toEqual([{ name: "Listing" }, { dayPrices: { 1: 500 } }]);
  });
});
