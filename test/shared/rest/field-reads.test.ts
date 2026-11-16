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
  readOpenBody,
  shownFieldKeys,
  transferClosedErrorOrNull,
  transferValues,
  unshownFieldOrNull,
} from "#shared/rest/field-reads.ts";
import type { ClosedFields } from "#shared/rest/field-specs.ts";
import type { DateString } from "#shared/validation/date-string.ts";

/** No field is closed to this writer. */
const NONE: ClosedFields = new Map();

/** A listing create body read with its required fields filled in. */
const listingCreate = (body: Record<string, unknown>) =>
  readBody(
    LISTING_FIELDS,
    { max_attendees: 5, name: "Listing", ...body },
    null,
    NONE,
  );

/** A stored listing row, for the update reads. */
const storedListing = { closesAt: null, maxAttendees: 5, name: "Listing" };

const storedGroup = {
  description: "About",
  hidden: false,
  hidePackageListings: false,
  isPackage: true,
  maxAttendees: 40,
  scanChecksInAllListings: false,
  showHiddenListings: true,
  termsAndConditions: "Terms",
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
  endDate: "2026-08-31",
  id: 1,
  name: "Summer Break",
  startDate: "2026-07-01",
};

describe("field reads", () => {
  test("the row and the input follow the field list", () => {
    const shapes: [
      Same<
        Holiday,
        { endDate: string; id: number; name: string; startDate: string }
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
      isPaidDefault: false,
      isPublicDefault: true,
      isReservation: true,
      name: "Reserved",
      reservationAmount: "10",
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
    const read = readOpenBody(
      GROUP_FIELDS,
      { hidden: true, name: "Package" },
      null,
    );
    expect(read).toEqual({
      ok: true,
      value: {
        hidden: true,
        hidePackageListings: false,
        isPackage: false,
        name: "Package",
        scanChecksInAllListings: false,
        showHiddenListings: true,
      },
    });
  });

  test("an API create refuses a required field it leaves out or sends as null", () => {
    expect([
      readBody(LISTING_FIELDS, { name: "Listing" }, null, NONE),
      readBody(LISTING_FIELDS, { max_attendees: 5, name: null }, null, NONE),
      readOpenBody(GROUP_FIELDS, {}, null),
    ]).toEqual([
      { error: "max_attendees is required", ok: false },
      { error: "name is required", ok: false },
      { error: "name is required", ok: false },
    ]);
  });

  test("an API read refuses a name that is not text, and an update without one keeps it", () => {
    const storedNamed = { ...storedGroup, name: "Stored" };
    const kept = readOpenBody(GROUP_FIELDS, {}, storedNamed);
    expect([
      readOpenBody(GROUP_FIELDS, { name: 5 }, storedNamed),
      kept.ok && kept.value.name,
    ]).toEqual([{ error: "name must be a string", ok: false }, "Stored"]);
  });

  test("an API read refuses a field the writer cannot set, before any value check", () => {
    const closed: ClosedFields = new Map([["webhook_url", "editor"]]);
    expect([
      readBody(
        LISTING_FIELDS,
        { max_attendees: -1, webhook_url: "https://example.com" },
        storedListing,
        closed,
      ),
      readBody(LISTING_FIELDS, { max_attendees: 9 }, storedListing, closed).ok,
    ]).toEqual([{ error: "editors cannot set webhook_url", ok: false }, true]);
  });

  test("an API null clears a text field and keeps any other field", () => {
    const read = readOpenBody(
      GROUP_FIELDS,
      { description: null, is_package: null, max_attendees: null },
      { ...storedGroup, name: "Stored" },
    );
    expect(read).toEqual({
      ok: true,
      value: { ...storedGroupInput, description: "", name: "Stored" },
    });
  });

  test("an API read refuses the first value its kind does not take", () => {
    expect([
      readOpenBody(
        GROUP_FIELDS,
        { hidden: "yes", max_attendees: -1, name: "Group" },
        null,
      ),
      readOpenBody(GROUP_FIELDS, { max_attendees: 1.5 }, storedGroup),
      listingCreate({ date: "2026-06-01T10:00" }),
      listingCreate({ closes_at: "" }),
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
    const read = listingCreate({
      closes_at: null,
      date: null,
      day_prices: null,
      listing_type: "daily",
    });
    expect(read.ok && read.value).toMatchObject({
      closesAt: "",
      date: "",
      dayPrices: {},
      listingType: "daily",
    });
  });

  test("an API null empties a contact list, a listing type, and a plain text", () => {
    const listing = listingCreate({ fields: null, listing_type: null });
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
      readOpenBody(
        GROUP_FIELDS,
        {},
        { ...storedGroup, name: "Stored", showHiddenListings: false },
      ),
    ).toEqual({
      ok: true,
      value: { ...storedGroupInput, name: "Stored", showHiddenListings: false },
    });
  });

  test("an API update leaves an unset closing time out of the write", () => {
    const read = readBody(LISTING_FIELDS, {}, storedListing, NONE);
    expect(read.ok && Object.hasOwn(read.value, "closesAt")).toBe(false);
  });

  test("a form reads each shown switch box and gives each empty box its default", () => {
    expect(
      formFieldsInput(
        GROUP_FIELDS,
        {
          description: "Description",
          hidden: "1",
          hide_package_listings: "0",
          is_package: "",
          max_attendees: null,
          name: "Package",
          scan_checks_in_all_listings: "1",
          show_hidden_listings: "1",
          terms_and_conditions: "Terms",
        },
        new Set(GROUP_FIELDS.map((field) => field.key)),
      ),
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

  test("a form keeps a zero and reads only the fields its page shows", () => {
    const input = formFieldsInput(
      LISTING_FIELDS,
      { active: "1", maximum_days_after: 0, name: "Listing" },
      new Set(["maximum_days_after", "minimum_days_before", "name"]),
    );
    expect(input).toEqual({
      maximumDaysAfter: 0,
      minimumDaysBefore: 1,
      name: "Listing",
    });
  });

  test("a form reads a price in major units, a local time as UTC, and a weekday list", () => {
    const input = formFieldsInput(
      LISTING_FIELDS,
      {
        bookable_days: "Monday,Friday",
        closes_at: "",
        date: "2026-01-10T10:00",
        unit_price: "12.50",
      },
      new Set(["bookable_days", "closes_at", "date", "unit_price"]),
    );
    expect(input).toEqual({
      bookableDays: ["Monday", "Friday"],
      closesAt: null,
      date: "2026-01-10T10:00:00.000Z",
      unitPrice: 1250,
    });
  });

  test("a blank form price box takes the default that its field declares", () => {
    expect(
      formFieldsInput(
        LISTING_FIELDS,
        { recurring_price: "", unit_price: "12.50" },
        new Set(["recurring_price", "unit_price"]),
      ),
    ).toEqual({ recurringPrice: 0, unitPrice: 1250 });
  });

  test("a form price box that holds no price and has no default throws", () => {
    const noDefault = LISTING_FIELDS.map((field) =>
      field.key === "unit_price" ? { key: field.key, kind: field.kind } : field,
    );
    for (const value of ["", "abc"]) {
      expect(() =>
        formFieldsInput(
          value === "" ? noDefault : LISTING_FIELDS,
          { unit_price: value },
          new Set(["unit_price"]),
        ),
      ).toThrow("The unit_price form box holds no price");
    }
  });

  test("the shown fields are the visible declared boxes and the named extras", () => {
    const shown = shownFieldKeys(
      LISTING_FIELDS,
      [
        { name: "name" },
        { name: "webhook_url", visible: false },
        { name: "slug" },
        { name: "hidden", visible: true },
      ],
      ["use_defaults"],
    );
    expect([...shown]).toEqual(["hidden", "name", "use_defaults"]);
  });

  test("a form that sends a declared box its page did not show names that field", () => {
    const shown = new Set(["name"]);
    expect([
      unshownFieldOrNull(LISTING_FIELDS, ["name", "csrf_token"], shown),
      unshownFieldOrNull(LISTING_FIELDS, ["webhook_url", "name"], shown),
    ]).toEqual([null, "webhook_url"]);
  });

  test("a transfer leaves out withheld columns and empty day prices", () => {
    const row = {
      attachmentName: "private.pdf",
      dayPrices: {},
      name: "Listing",
      webhookUrl: "secret",
    };
    expect([
      transferValues(LISTING_FIELDS, row, new Map([["webhook_url", "editor"]])),
      transferValues(LISTING_FIELDS, { dayPrices: { 1: 500 } }),
    ]).toEqual([{ name: "Listing" }, { dayPrices: { 1: 500 } }]);
  });

  test("a transfer that supplies a closed field is refused by its transfer key", () => {
    const closed: ClosedFields = new Map([["uses_logistics", "logistics"]]);
    expect([
      transferClosedErrorOrNull(closed, {
        name: "Listing",
        usesLogistics: false,
      }),
      transferClosedErrorOrNull(closed, { name: "Listing" }),
    ]).toEqual(["usesLogistics needs logistics turned on", null]);
  });
});
