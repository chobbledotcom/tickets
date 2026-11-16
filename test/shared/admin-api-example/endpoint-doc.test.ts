import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  childDocBase,
  childWriteDocs,
  choiceWriteDocs,
  crudDocs,
  type EndpointDoc,
  json,
} from "#shared/admin-api-example/endpoint-doc.ts";
import type { FieldDocRow } from "#shared/admin-api-example/field-docs.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
} from "#shared/admin-api-resources.ts";

/** A resource with one child surface, as the resource table declares one. */
const TOUR = {
  children: {
    stops: {
      bodySchema: v.object({ text: v.string() }),
      idParam: "stopId",
      path: "stops",
      responseSchema: v.unknown(),
    },
  },
  createBodySchema: v.object({
    name: v.string(),
    notes: v.optional(v.string()),
  }),
  label: "Tour",
  path: "tours",
  singleSchema: v.unknown(),
  updateBodySchema: v.partial(v.object({ name: v.string() })),
};

const TOURS = "/api/admin/tours";
const ONE_TOUR = `${TOURS}/:tourId`;
const STOPS = `${ONE_TOUR}/stops`;
const ONE_STOP = `${STOPS}/:stopId`;

/** A required text row of the given key. */
const textRow = (key: string, required = true): FieldDocRow => ({
  defaultJson: null,
  key,
  limits: [],
  required,
  value: { form: "text" },
});

/** One expected doc entry. A request body and an answer are written out the
 *  way the docs write them. */
const doc = (
  [method, path, description]: [string, string, string],
  answer: unknown,
  body?: unknown,
  fields?: FieldDocRow[],
): EndpointDoc => ({
  description,
  method,
  path,
  response: json(answer),
  ...(body === undefined ? {} : { request: json(body) }),
  ...(fields === undefined ? {} : { fields }),
});

/** The three expected write entries of the stops: the add and the change as
 *  [answer, body], then the text the delete confirms. */
const stopWrites = (
  [add, change, remove]: [string, string, string],
  added: [unknown, unknown],
  changed: [unknown, unknown],
  confirmed: string,
): EndpointDoc[] => [
  doc(["POST", STOPS, add], ...added, [textRow("text")]),
  doc(["PUT", ONE_STOP, change], ...changed, [textRow("text")]),
  doc(
    ["DELETE", ONE_STOP, remove],
    { status: "ok" },
    {
      confirm_identifier: confirmed,
    },
  ),
];

/** The docs of one resource, with empty bodies where a test names none. */
const docsOf = (
  entry: AdminApiResource,
  bodies: {
    createBody?: unknown;
    example?: unknown;
    updateBody?: unknown;
  } = {},
): EndpointDoc[] =>
  crudDocs({
    createBody: {},
    deleteBody: { confirm_identifier: "Old town" },
    desc: ["List", "Get", "Create", "Update", "Delete"],
    entry,
    example: {},
    updateBody: {},
    ...bodies,
  });

const fieldKeys = (endpoint: EndpointDoc | undefined): string[] | undefined =>
  endpoint?.fields?.map((row) => row.key);

const TOWN_STOPS = [
  { id: 1, text: "Harbour" },
  { id: 2, text: "Castle" },
];

describe("endpoint docs", () => {
  test("an example body is written with two-space indents", () => {
    expect(json({ name: "Tour" })).toBe('{\n  "name": "Tour"\n}');
  });

  test("a child route sits under its parent's id", () => {
    expect(childDocBase(TOUR, "stops")).toBe(STOPS);
  });

  test("a child surface documents its add, its change, and its delete", () => {
    const docs = childWriteDocs([TOUR, "stops"], {
      createBody: { text: "Harbour" },
      created: { stop: { id: 1 } },
      deleteBody: { confirm_identifier: "Harbour" },
      desc: ["Add a stop", "Change a stop", "Delete a stop"],
      updateBody: { text: "Castle" },
      updated: { stop: { id: 2 } },
    });

    expect(docs).toEqual(
      stopWrites(
        ["Add a stop", "Change a stop", "Delete a stop"],
        [{ stop: { id: 1 } }, { text: "Harbour" }],
        [{ stop: { id: 2 } }, { text: "Castle" }],
        "Harbour",
      ),
    );
  });

  test("a list of choices adds one last, renames one, and deletes by the old text", () => {
    const town = { id: 9, name: "Old town" };
    const docs = choiceWriteDocs([TOUR, "stops"], {
      added: { id: 3, text: "Market" },
      desc: ["Add", "Rename", "Delete"],
      record: { ...town, stops: TOWN_STOPS },
      rename: ["Castle", "Keep"],
    });
    const answer = (stops: unknown[]) => ({ tour: { ...town, stops } });

    expect(docs).toEqual(
      stopWrites(
        ["Add", "Rename", "Delete"],
        [
          answer([...TOWN_STOPS, { id: 3, text: "Market" }]),
          { text: "Market" },
        ],
        [answer([TOWN_STOPS[0], { id: 2, text: "Keep" }]), { text: "Keep" }],
        "Castle",
      ),
    );
  });

  test("a resource documents its five routes with the fields of its body schemas", () => {
    const example = { id: 9, name: "Harbour walk" };
    const docs = docsOf(TOUR, {
      createBody: { name: "Old town" },
      example,
      updateBody: { name: "New town" },
    });

    expect(docs).toEqual([
      doc(["GET", TOURS, "List"], { tours: [example] }),
      doc(["GET", ONE_TOUR, "Get"], { tour: example }),
      doc(
        ["POST", TOURS, "Create"],
        { tour: { id: 9, name: "Old town" } },
        { name: "Old town" },
        [textRow("name"), textRow("notes", false)],
      ),
      doc(
        ["PUT", ONE_TOUR, "Update"],
        { tour: { id: 9, name: "New town" } },
        { name: "New town" },
        [textRow("name", false)],
      ),
      doc(
        ["DELETE", ONE_TOUR, "Delete"],
        { status: "ok" },
        { confirm_identifier: "Old town" },
      ),
    ]);
  });

  test("a resource with a field list documents the list, with any extra body keys of its path", () => {
    const fields = [{ key: "name", kind: "name" }] as const;
    const [, , plainCreate] = docsOf({ ...TOUR, fields });
    const [, , create, update] = docsOf({ ...TOUR, fields, path: "groups" });

    expect(plainCreate?.fields).toEqual([textRow("name")]);
    expect(fieldKeys(create)).toEqual(["name", "package_members"]);
    expect(fieldKeys(update)).toEqual(["name", "package_members", "slug"]);
  });

  test("a resource with no field list and no pair of body schemas stops the docs", () => {
    const { attendees } = ADMIN_API_RESOURCES;
    const oneSchema = v.object({});
    const refusal =
      "The resource table gives Attendee no field list and no body schemas";

    for (const entry of [
      attendees,
      { ...attendees, createBodySchema: oneSchema },
      { ...attendees, updateBodySchema: oneSchema },
    ]) {
      expect(() => docsOf(entry)).toThrow(refusal);
    }
  });
});
