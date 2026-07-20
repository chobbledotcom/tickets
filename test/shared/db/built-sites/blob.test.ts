import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  blobToSiteFields,
  buildSiteDataBlobFromInput,
  parseSiteDataBlob,
} from "#shared/db/built-sites/blob.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

test("builds and parses every current site-data field", () => {
  expect(
    parseSiteDataBlob(
      buildSiteDataBlobFromInput({
        dbProvider: "turso",
        dbToken: "database-token",
        dbUrl: "libsql://database.example",
        hostingId: "app-42",
        hostingProvider: "deno",
        name: "Child site",
        renewalToken: "renewal-token",
        scheduledTaskKey: TEST_SCHEDULED_KEY,
        siteUrl: "child.example",
      }),
    ),
  ).toEqual({
    d: "libsql://database.example",
    dp: "turso",
    hp: "deno",
    n: "Child site",
    rt: "renewal-token",
    s: "app-42",
    sk: TEST_SCHEDULED_KEY,
    t: "database-token",
    u: "child.example",
    v: 2,
  });
});

test("omits empty optional fields and supplies required defaults", () => {
  expect(parseSiteDataBlob(buildSiteDataBlobFromInput({}))).toEqual({
    dp: "bunny",
    hp: "bunny",
    n: "",
    u: "",
    v: 2,
  });
});

test("parses legacy blobs without current optional fields", () => {
  expect(
    parseSiteDataBlob(
      JSON.stringify({ n: "Legacy", u: "legacy.example", v: 1 }),
    ),
  ).toEqual({ n: "Legacy", u: "legacy.example", v: 1 });
});

test("turns a legacy blob into every site field default", () => {
  expect(
    blobToSiteFields({
      n: "Legacy",
      rt: "",
      u: "legacy.example",
      v: 1,
    }),
  ).toEqual({
    dbProvider: "bunny",
    dbToken: "",
    dbUrl: "",
    hostingId: "",
    hostingProvider: "bunny",
    name: "Legacy",
    renewalToken: "",
    scheduledTaskKey: null,
    siteUrl: "legacy.example",
  });
});

test("rejects invalid scheduled keys while building the blob", () => {
  expect(() =>
    buildSiteDataBlobFromInput({ scheduledTaskKey: "invalid" }),
  ).toThrow("Invalid value for stored JSON in built_sites.site_data");
});

test("rejects malformed and unknown stored fields", () => {
  expect(() => parseSiteDataBlob("{")).toThrow(
    "Invalid stored JSON in built_sites.site_data",
  );
  expect(() =>
    parseSiteDataBlob(
      JSON.stringify({ hp: "unknown", n: "Site", u: "site.test", v: 1 }),
    ),
  ).toThrow("Invalid stored JSON in built_sites.site_data");
  expect(() =>
    parseSiteDataBlob(
      JSON.stringify({ extra: true, n: "Site", u: "site.test", v: 1 }),
    ),
  ).toThrow("Invalid stored JSON in built_sites.site_data");
});

test("rejects invalid site data before serialization", () => {
  expect(() =>
    buildSiteDataBlobFromInput({ hostingProvider: "invalid" as never }),
  ).toThrow("Invalid value for stored JSON in built_sites.site_data");
});
