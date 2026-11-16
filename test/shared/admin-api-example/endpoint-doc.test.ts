import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  childDocBase,
  childWriteDocs,
  choiceWriteDocs,
  crudDocs,
  crudDocsFor,
  docKeysOf,
  type EndpointDoc,
  json,
  shownFor,
} from "#shared/admin-api-example/endpoint-doc.ts";
import type { FieldDocRow } from "#shared/admin-api-example/field-docs.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
} from "#shared/admin-api-resources.ts";
import { everyFeature, OPEN_ACCESS } from "./helpers.ts";

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
    createBody?: object;
    example?: object;
    updateBody?: object;
  } = {},
): EndpointDoc[] =>
  crudDocsFor(OPEN_ACCESS)({
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

  test("a resource with a declared field list documents the list and its extra body keys", () => {
    const [, , create, update] = docsOf({ ...TOUR, path: "holidays" });
    const [, , groupCreate, groupUpdate] = docsOf({ ...TOUR, path: "groups" });

    expect(fieldKeys(create)).toEqual(["end_date", "name", "start_date"]);
    expect(fieldKeys(update)).toEqual(["end_date", "name", "start_date"]);
    expect(fieldKeys(groupCreate)).toContain("package_members");
    expect(fieldKeys(groupCreate)).not.toContain("slug");
    expect(fieldKeys(groupUpdate)).toContain("slug");
  });

  test("a resource with no field list and no pair of body schemas stops the docs", () => {
    const { attendees } = ADMIN_API_RESOURCES;
    const oneSchema = v.object({});
    const refusal = "Attendee has no declared field list and no body schemas";

    for (const entry of [
      attendees,
      { ...attendees, createBodySchema: oneSchema },
      { ...attendees, updateBodySchema: oneSchema },
    ]) {
      expect(() => docsOf(entry)).toThrow(refusal);
    }
  });

  test("a resource with a declared field list stops docs that name no viewer", () => {
    const withoutViewer = () =>
      crudDocs({
        createBody: {},
        deleteBody: {},
        desc: ["List", "Get", "Create", "Update", "Delete"],
        entry: ADMIN_API_RESOURCES.groups,
        example: {},
        updateBody: {},
      });

    expect(withoutViewer).toThrow(
      "Group declares its fields, so its docs need the access of the viewer",
    );
  });

  test("a resource with no declared field list closes and hides no key", () => {
    const keys = docKeysOf(TOUR, undefined);

    expect([[...keys.closed], [...keys.hidden]]).toEqual([[], []]);
  });

  test("the doc keys of a listing follow the access of the viewer", () => {
    const keysFor = (access: typeof OPEN_ACCESS) => {
      const keys = docKeysOf(ADMIN_API_RESOURCES.listings, access);
      return { closed: [...keys.closed], hidden: [...keys.hidden] };
    };

    expect(keysFor(OPEN_ACCESS)).toEqual({ closed: [], hidden: [] });
    expect(
      keysFor({
        features: { ...OPEN_ACCESS.features, logistics: false },
        locks: { ...OPEN_ACCESS.locks, demo: true, nonOwner: true },
      }),
    ).toEqual({
      closed: ["uses_logistics", "webhook_url", "attribute_option_ids"],
      hidden: ["uses_logistics"],
    });
  });

  test("a closed key leaves the table and both bodies, and a hidden key leaves the answers", () => {
    const docs = crudDocsFor({
      features: { ...OPEN_ACCESS.features, logistics: false },
      locks: OPEN_ACCESS.locks,
    })({
      createBody: { name: "Walk", uses_logistics: true },
      deleteBody: {},
      desc: ["List", "Get", "Create", "Update", "Delete"],
      entry: ADMIN_API_RESOURCES.listings,
      example: { id: 4, name: "Tour", uses_logistics: false },
      listExtras: { admin_level: "owner" },
      updateBody: { uses_logistics: true },
    });
    const [list, get, create, update] = docs.map((endpoint) => ({
      request: endpoint.request,
      response: endpoint.response,
    }));

    expect([list, get, create, update]).toEqual([
      {
        request: undefined,
        response: json({
          admin_level: "owner",
          listings: [{ id: 4, name: "Tour" }],
        }),
      },
      {
        request: undefined,
        response: json({ listing: { id: 4, name: "Tour" } }),
      },
      {
        request: json({ name: "Walk" }),
        response: json({ listing: { id: 4, name: "Walk" } }),
      },
      {
        request: json({}),
        response: json({ listing: { id: 4, name: "Tour" } }),
      },
    ]);
    expect(fieldKeys(docs[2])).not.toContain("uses_logistics");
    expect(fieldKeys(docs[3])).not.toContain("uses_logistics");
    expect(fieldKeys(docs[2])).toContain("name");
  });

  test("the docs of a resource stay while its feature is on, and go while it is off", () => {
    const docs = docsOf(TOUR);
    const shownWith = (on: boolean, entry: { path: string }) =>
      shownFor({ access: OPEN_ACCESS, features: everyFeature(on) })(
        { ...TOUR, path: entry.path },
        docs,
      );

    expect(shownWith(true, ADMIN_API_RESOURCES.questions)).toBe(docs);
    expect(shownWith(false, ADMIN_API_RESOURCES.questions)).toEqual([]);
    expect(shownWith(false, ADMIN_API_RESOURCES.holidays)).toBe(docs);
  });
});
