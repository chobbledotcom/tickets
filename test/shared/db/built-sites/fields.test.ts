import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  builtSiteBlobColumns,
  builtSiteFormMappings,
  builtSiteInputKeyMap,
  builtSitePlainColumns,
  builtSitePlainSchema,
  emptyBuiltSiteFormInput,
  mapPlainFields,
  plainSiteInput,
} from "#shared/db/built-sites/fields.ts";

const plainFields = {
  assignable: true,
  assignedAttendeeId: 42,
  assignedListingId: 7,
  readOnlyFrom: "2027-01-01T00:00:00Z",
  renewalTokenIndex: "renewal-index",
  siteDataRevision: 3,
  updates: "beta",
} as const;

test("maps every plain site field to table input", () => {
  expect(plainSiteInput(plainFields)).toEqual({
    assignable: 1,
    assignedAttendeeId: 42,
    assignedListingId: 7,
    readOnlyFrom: "2027-01-01T00:00:00Z",
    renewalTokenIndex: "renewal-index",
    siteDataRevision: 3,
    updates: "beta",
  });
  expect(mapPlainFields(plainFields, "dbKey")).toEqual({
    assignable: 1,
    assigned_attendee_id: 42,
    assigned_listing_id: 7,
    read_only_from: "2027-01-01T00:00:00Z",
    renewal_token_index: "renewal-index",
    site_data_revision: 3,
    updates: "beta",
  });
});

test("maps false and null plain values without dropping them", () => {
  expect(
    plainSiteInput({
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
    plainSiteInput({
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

test("defines exact form names and defaults", () => {
  expect(builtSiteInputKeyMap).toEqual({
    assignable: "assignable",
    db_provider: "dbProvider",
    db_token: "dbToken",
    db_url: "dbUrl",
    hosting_id: "hostingId",
    hosting_provider: "hostingProvider",
    name: "name",
    site_url: "siteUrl",
    updates: "updates",
  });
  expect(emptyBuiltSiteFormInput()).toEqual({
    assignable: false,
    dbProvider: "bunny",
    dbToken: "",
    dbUrl: "",
    hostingId: "",
    hostingProvider: "bunny",
    name: "",
    siteUrl: "",
    updates: "release",
  });
  expect(builtSiteFormMappings).toHaveLength(9);
});

test("converts plain database values back to site fields", () => {
  const row = {
    assignable: 1,
    assigned_attendee_id: 42,
    assigned_listing_id: 7,
    assignment_effect: "renewed",
    read_only_from: "date",
    renewal_token_index: "index",
    site_data_revision: 3,
    updates: "alpha",
  } as const;
  const fields = Object.fromEntries(
    builtSitePlainColumns.map((column) => [
      column.siteKey,
      column.fromRow(row[column.dbKey] as never),
    ]),
  );
  expect(fields).toEqual({
    assignable: true,
    assignedAttendeeId: 42,
    assignedListingId: 7,
    assignmentEffect: "renewed",
    readOnlyFrom: "date",
    renewalTokenIndex: "index",
    siteDataRevision: 3,
    updates: "alpha",
  });
  expect(builtSitePlainColumns[0].fromRow(0)).toBe(false);
});

test("defines exact plain defaults and blob mappings", () => {
  expect({
    assignedAttendeeId: builtSitePlainSchema.assigned_attendee_id.default?.(),
    assignedListingId: builtSitePlainSchema.assigned_listing_id.default?.(),
    readOnlyFrom: builtSitePlainSchema.read_only_from.default?.(),
    renewalTokenIndex: builtSitePlainSchema.renewal_token_index.default?.(),
    siteDataRevision: builtSitePlainSchema.site_data_revision.default?.(),
    updates: builtSitePlainSchema.updates.default?.(),
  }).toEqual({
    assignedAttendeeId: null,
    assignedListingId: null,
    readOnlyFrom: "",
    renewalTokenIndex: null,
    siteDataRevision: 0,
    updates: "release",
  });
  expect(builtSiteBlobColumns).toEqual([
    {
      blobKey: "n",
      defaultValue: "",
      formDbKey: "name",
      required: true,
      siteKey: "name",
    },
    {
      blobKey: "u",
      defaultValue: "",
      formDbKey: "site_url",
      required: true,
      siteKey: "siteUrl",
    },
    {
      blobKey: "d",
      defaultValue: "",
      formDbKey: "db_url",
      required: false,
      siteKey: "dbUrl",
    },
    {
      blobKey: "t",
      defaultValue: "",
      formDbKey: "db_token",
      required: false,
      siteKey: "dbToken",
    },
    {
      blobKey: "s",
      defaultValue: "",
      formDbKey: "hosting_id",
      required: false,
      siteKey: "hostingId",
    },
    {
      blobKey: "hp",
      defaultValue: "bunny",
      formDbKey: "hosting_provider",
      required: false,
      siteKey: "hostingProvider",
    },
    {
      blobKey: "dp",
      defaultValue: "bunny",
      formDbKey: "db_provider",
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
