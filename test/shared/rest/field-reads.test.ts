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
  formInput,
  readBody,
  readOpenBody,
  shownFieldKeys,
  transferValues,
  unshownFieldOrNull,
} from "#shared/rest/field-reads.ts";
import {
  type ClosedFields,
  closedFieldErrorOrNull,
} from "#shared/rest/field-specs.ts";
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
        endDate: "2026-12-26",
        name: "Christmas",
        startDate: "2026-12-24",
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
    const closed: ClosedFields = new Map([["webhookUrl", "editor"]]);
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

  test("the shown fields are the visible declared boxes and the named extras", () => {
    const shown = shownFieldKeys(
      LISTING_FIELDS,
      [
        { name: "name" },
        { name: "webhookUrl", visible: false },
        { name: "slug" },
        { name: "hidden", visible: true },
      ],
      ["useDefaults"],
    );
    expect([...shown]).toEqual(["hidden", "name", "useDefaults"]);
  });

  test("a form that sends a declared box its page did not show names that field", () => {
    const shown = new Set(["name"]);
    expect([
      unshownFieldOrNull(LISTING_FIELDS, ["name", "csrfToken"], shown),
      unshownFieldOrNull(LISTING_FIELDS, ["webhookUrl", "name"], shown),
    ]).toEqual([null, "webhookUrl"]);
  });

  test("a transfer leaves out withheld columns and empty day prices", () => {
    const row = {
      attachmentName: "private.pdf",
      dayPrices: {},
      name: "Listing",
      webhookUrl: "secret",
    };
    expect([
      transferValues(LISTING_FIELDS, row, new Map([["webhookUrl", "editor"]])),
      transferValues(LISTING_FIELDS, { dayPrices: { 1: 500 } }),
    ]).toEqual([{ name: "Listing" }, { dayPrices: { 1: 500 } }]);
  });

  test("a transfer that supplies a closed field is refused by its transfer key", () => {
    const closed: ClosedFields = new Map([["usesLogistics", "logistics"]]);
    expect([
      closedFieldErrorOrNull(closed, ["name", "usesLogistics"]),
      closedFieldErrorOrNull(closed, ["name"]),
    ]).toEqual(["usesLogistics needs logistics turned on", null]);
  });
});
