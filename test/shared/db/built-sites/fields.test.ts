import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  builtSiteBlobColumns,
  builtSitePlainColumns,
  plainColumnValues,
} from "#db/built-sites/fields.ts";

const plainFields = {
  assignable: true,
  assignedAttendeeId: 42,
  assignedListingId: 7,
  readOnlyFrom: "2027-01-01T00:00:00Z",
  renewalTokenIndex: "renewal-index",
  siteDataRevision: 3,
  updates: "beta",
} as const;

test("maps every plain site field to its column", () => {
  expect(plainColumnValues(plainFields)).toEqual({
    assignable: 1,
    assignedAttendeeId: 42,
    assignedListingId: 7,
    readOnlyFrom: "2027-01-01T00:00:00Z",
    renewalTokenIndex: "renewal-index",
    siteDataRevision: 3,
    updates: "beta",
  });
});

test("maps false and null plain values without dropping them", () => {
  expect(
    plainColumnValues({
      assignable: false,
      assignedAttendeeId: null,
      assignedListingId: null,
      renewalTokenIndex: null,
    }),
  ).toEqual({
    assignable: 0,
    assignedAttendeeId: null,
    assignedListingId: null,
    renewalTokenIndex: null,
  });
  expect(
    plainColumnValues({
      assignedAttendeeId: 0,
      readOnlyFrom: "",
      renewalTokenIndex: "",
    }),
  ).toEqual({
    assignedAttendeeId: 0,
    readOnlyFrom: "",
    renewalTokenIndex: "",
  });
});

test("converts plain database values back to site fields", () => {
  const row = {
    assignable: 1,
    assignedAttendeeId: 42,
    assignedListingId: 7,
    databaseKeyRotationStarted: 1,
    readOnlyFrom: "date",
    renewalTokenIndex: "index",
    siteDataRevision: 3,
    updates: "alpha",
  } as const;
  const fields = Object.fromEntries(
    builtSitePlainColumns.map((column) => [
      column.siteKey,
      column.fromRow(row[column.siteKey] as never),
    ]),
  );
  expect(fields).toEqual({
    assignable: true,
    assignedAttendeeId: 42,
    assignedListingId: 7,
    databaseKeyRotationStarted: 1,
    readOnlyFrom: "date",
    renewalTokenIndex: "index",
    siteDataRevision: 3,
    updates: "alpha",
  });
  expect(builtSitePlainColumns[0].fromRow(0)).toBe(false);
});

test("defines exact blob mappings", () => {
  expect(builtSiteBlobColumns).toEqual([
    {
      blobKey: "n",
      defaultValue: "",
      required: true,
      siteKey: "name",
    },
    {
      blobKey: "u",
      defaultValue: "",
      required: true,
      siteKey: "siteUrl",
    },
    {
      blobKey: "d",
      defaultValue: "",
      required: false,
      siteKey: "dbUrl",
    },
    {
      blobKey: "t",
      defaultValue: "",
      required: false,
      siteKey: "dbToken",
    },
    {
      blobKey: "s",
      defaultValue: "",
      required: false,
      siteKey: "hostingId",
    },
    {
      blobKey: "hp",
      defaultValue: "bunny",
      required: false,
      siteKey: "hostingProvider",
    },
    {
      blobKey: "dp",
      defaultValue: "bunny",
      required: false,
      siteKey: "dbProvider",
    },
    {
      blobKey: "rt",
      defaultValue: null,
      required: false,
      siteKey: "renewalToken",
    },
    {
      blobKey: "sk",
      defaultValue: null,
      required: false,
      siteKey: "scheduledTaskKey",
    },
  ]);
});
