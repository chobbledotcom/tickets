/**
 * The field rows of each documented write come from the field list or the
 * body schema that the server reads. These check the rows against those
 * sources and against the example bodies beside them.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { QUESTION_DISPLAY_TYPES } from "#db/question-types.ts";
import type { EndpointDoc } from "#shared/admin-api-example/endpoint-doc.ts";
import {
  type FieldDocRow,
  schemaForm,
  schemaRows,
  specFieldDocs,
} from "#shared/admin-api-example/field-docs.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { MAX_DURATION_DAYS } from "#types";
import { ADMIN_API_ENDPOINTS, documented } from "./helpers.ts";

/** The field rows of one documented write. */
const rowsOf = (method: string, path: string): readonly FieldDocRow[] => {
  const { fields } = documented(ADMIN_API_ENDPOINTS, method, path);
  if (fields === undefined) throw new Error(`${method} ${path} has no fields`);
  return fields;
};

const keysOf = (rows: readonly FieldDocRow[]): string[] =>
  rows.map((row) => row.key);

/** The row of one key, or a loud failure that names the missing key. */
const rowOf = (rows: readonly FieldDocRow[], key: string): FieldDocRow => {
  const row = rows.find((each) => each.key === key);
  if (row === undefined) throw new Error(`No documented field ${key}`);
  return row;
};

const listingCreate = () => rowsOf("POST", "/api/admin/listings");
const listingUpdate = () => rowsOf("PUT", "/api/admin/listings/:listingId");

const sorted = (keys: readonly string[]): string[] =>
  [...keys].sort((a, b) => a.localeCompare(b));

const fieldKeys = (fields: readonly { key: string }[]): string[] =>
  fields.map((field) => field.key);

/** The update route of each record. A child write is not one of them: it
 *  carries the whole child, so it requires what its create does. */
const RECORD_UPDATE_PATHS = [
  "/api/admin/attendee-statuses/:statusId",
  "/api/admin/attributes/:attributeId",
  "/api/admin/external-sources/:sourceId",
  "/api/admin/groups/:groupId",
  "/api/admin/holidays/:holidayId",
  "/api/admin/images/:imageId",
  "/api/admin/listings/:listingId",
  "/api/admin/questions/:questionId",
  "/api/admin/site-pages/:pageId",
];

/** The documented writes that carry a body. */
const writesWithBody = (): EndpointDoc[] =>
  ADMIN_API_ENDPOINTS.filter(
    (endpoint) =>
      ["POST", "PUT"].includes(endpoint.method) &&
      endpoint.request !== undefined,
  );

describe("documented request fields", () => {
  test("a listing create names every listing field and every linked id list", () => {
    expect(keysOf(listingCreate())).toEqual(
      sorted([
        ...fieldKeys(LISTING_FIELDS),
        "attribute_option_ids",
        "child_listing_ids",
        "group_ids",
      ]),
    );
  });

  test("a listing update also takes the slug", () => {
    expect(keysOf(listingUpdate())).toEqual(
      sorted([...keysOf(listingCreate()), "slug"]),
    );
  });

  test("a listing create takes the registration closing time", () => {
    expect(rowOf(listingCreate(), "closes_at")).toEqual({
      defaultJson: null,
      key: "closes_at",
      required: false,
      value: { form: "or_null", of: { form: "time" } },
    });
  });

  test("a create requires the fields its body read refuses to go without", () => {
    const required = (path: string): string[] =>
      keysOf(rowsOf("POST", path).filter((row) => row.required));

    expect(required("/api/admin/listings")).toEqual(["max_attendees", "name"]);
    expect(required("/api/admin/groups")).toEqual(["name"]);
    expect(required("/api/admin/holidays")).toEqual([
      "end_date",
      "name",
      "start_date",
    ]);
    expect(required("/api/admin/attendee-statuses")).toEqual(["name"]);
    expect(required("/api/admin/attributes")).toEqual(["name"]);
  });

  test("a record update requires no field and shows no default", () => {
    const updates = RECORD_UPDATE_PATHS.flatMap((path) => rowsOf("PUT", path));

    expect(updates.filter((row) => row.required)).toEqual([]);
    expect(updates.filter((row) => row.defaultJson !== null)).toEqual([]);
  });

  test("a create shows the value it stores for a field the body leaves out", () => {
    const defaults = Object.fromEntries(
      listingCreate().map((row) => [row.key, row.defaultJson]),
    );

    expect(defaults).toMatchObject({
      active: "true",
      bookable_days: JSON.stringify(VALID_DAY_NAMES),
      closes_at: null,
      description: null,
      fields: '"email"',
      hidden: "false",
      max_attendees: null,
      max_price: "0",
      maximum_days_after: "90",
      name: null,
    });
  });

  test("a create shows no default for a field it stores as empty text", () => {
    const status = rowsOf("POST", "/api/admin/attendee-statuses");

    expect(rowOf(status, "reservation_amount").defaultJson).toBeNull();
    expect(rowOf(status, "is_reservation").defaultJson).toBe("false");
  });

  test("each kind of field shows the form of its value", () => {
    const form = (key: string) => rowOf(listingCreate(), key).value;

    expect(form("max_attendees")).toEqual({ form: "whole_number", min: 1 });
    expect(form("date")).toEqual({ form: "or_empty", of: { form: "time" } });
    expect(form("duration_days")).toEqual({
      form: "whole_number_range",
      max: MAX_DURATION_DAYS,
      min: 1,
    });
    expect(form("listing_type")).toEqual({
      form: "one_of",
      names: ["standard", "daily"],
    });
    expect(form("bookable_days")).toEqual({
      form: "list_of",
      of: { form: "one_of", names: VALID_DAY_NAMES },
    });
    expect(form("group_ids")).toEqual({
      form: "list_of",
      of: { form: "whole_number", min: 1 },
    });
    expect(
      ["day_prices", "fields", "unit_price", "hidden", "location"].map(
        (key) => form(key).form,
      ),
    ).toEqual(["day_prices", "contact_fields", "price", "switch", "text"]);
    expect(
      rowOf(rowsOf("POST", "/api/admin/holidays"), "start_date").value,
    ).toEqual({ form: "date" });
  });

  test("a count with no smallest value of its own starts at zero", () => {
    const { create } = specFieldDocs(
      [{ key: "seats", kind: "count" }],
      {},
      new Set(),
    );

    expect(create).toEqual([
      {
        defaultJson: null,
        key: "seats",
        required: false,
        value: { form: "whole_number", min: 0 },
      },
    ]);
  });

  test("a group write names its package members by their keys", () => {
    const { create, update } = specFieldDocs(GROUP_FIELDS, {}, new Set());
    const groupCreate = rowsOf("POST", "/api/admin/groups");

    expect(keysOf(groupCreate)).toEqual(
      sorted([...keysOf(create), "package_members"]),
    );
    expect(keysOf(rowsOf("PUT", "/api/admin/groups/:groupId"))).toEqual(
      sorted([...keysOf(update), "package_members", "slug"]),
    );
    expect(rowOf(groupCreate, "package_members").value).toEqual({
      form: "list_of",
      of: {
        form: "object",
        names: ["day_prices", "listing_id", "price", "quantity"],
      },
    });
  });

  test("a question create reads its rows from the body schema", () => {
    expect(rowsOf("POST", "/api/admin/questions")).toEqual([
      {
        defaultJson: null,
        key: "assign_all",
        required: false,
        value: { form: "switch" },
      },
      {
        defaultJson: null,
        key: "display_type",
        required: true,
        value: {
          form: "one_of",
          names: QUESTION_DISPLAY_TYPES,
        },
      },
      {
        defaultJson: null,
        key: "text",
        required: true,
        value: { form: "text" },
      },
    ]);
  });

  test("an image create takes the file, and an update takes the linked records", () => {
    const create = rowsOf("POST", "/api/admin/images");
    const update = rowsOf("PUT", "/api/admin/images/:imageId");

    expect(keysOf(create.filter((row) => row.required))).toEqual([
      "content_type",
      "file",
      "name",
    ]);
    expect(keysOf(update)).toEqual(["alt_text", "items", "name"]);
    expect(rowOf(update, "items").value).toEqual({
      form: "list_of",
      of: { form: "object", names: ["item_id", "item_type"] },
    });
  });

  test("a site page update takes a parent page id or null", () => {
    const update = rowsOf("PUT", "/api/admin/site-pages/:pageId");

    expect(rowOf(update, "parent").value).toEqual({
      form: "or_null",
      of: { form: "number" },
    });
    expect(keysOf(rowsOf("POST", "/api/admin/site-pages"))).not.toContain(
      "parent",
    );
  });

  test("a link write requires the record it names", () => {
    const link = rowsOf("POST", "/api/admin/external-sources/:sourceId/links");

    expect(link.map((row) => [row.key, row.required])).toEqual([
      ["external_id", false],
      ["link_id", true],
      ["link_type", true],
    ]);
  });

  test("every documented write with a body names its fields, except the two the server reads by hand", () => {
    const withoutFields = writesWithBody()
      .filter((endpoint) => endpoint.fields === undefined)
      .map((endpoint) => `${endpoint.method} ${endpoint.path}`);

    expect(withoutFields).toEqual([
      "POST /api/admin/attendees",
      "PUT /api/admin/site-pages/home",
      "PUT /api/admin/site-pages/contact",
      "PUT /api/admin/site-pages/terms",
    ]);
  });

  test("every key of an example body is a documented field", () => {
    const strays = writesWithBody().flatMap((endpoint) => {
      const keys = keysOf(endpoint.fields ?? []);
      const sent = Object.keys(JSON.parse(endpoint.request ?? "{}"));
      return endpoint.fields === undefined
        ? []
        : sent
            .filter((key) => !keys.includes(key))
            .map((key) => `${endpoint.method} ${endpoint.path}: ${key}`);
    });

    expect(strays).toEqual([]);
  });

  test("every example body holds the fields its write requires", () => {
    const missing = writesWithBody().flatMap((endpoint) => {
      const sent = Object.keys(JSON.parse(endpoint.request ?? "{}"));
      return (endpoint.fields ?? [])
        .filter((row) => row.required && !sent.includes(row.key))
        .map((row) => `${endpoint.method} ${endpoint.path}: ${row.key}`);
    });

    expect(missing).toEqual([]);
  });

  test("a body schema of an unknown type stops the docs", () => {
    expect(() => schemaForm(v.date())).toThrow(
      "No documented value form for a date schema",
    );
  });

  test("a body that is not an object stops the docs", () => {
    expect(() => schemaRows(v.string())).toThrow(
      "A documented body must be an object, not string",
    );
  });
});
