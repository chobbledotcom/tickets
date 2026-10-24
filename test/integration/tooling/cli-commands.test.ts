import { assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { bodySchemaFor, parseCommand } from "#cli/commands.ts";
import { describeEntries } from "#cli/describe.ts";
import { CliError, EXIT_CODES } from "#cli/errors.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
} from "#shared/admin-api-resources.ts";
import { gadgetEntry, testTable } from "#test-utils/cli-table.ts";

/** Parse one command, or answer the usage error's exit code and message. */
const parseOrUsage = (args: string[]): { code: number; message: string } => {
  try {
    parseCommand(testTable, args);
    throw new Error(`expected a usage error for ${args.join(" ")}`);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { code: EXIT_CODES[error.kind], message: error.message };
  }
};

const writeCommand = (args: string[]) =>
  parseCommand(testTable, args) as Extract<
    ReturnType<typeof parseCommand>,
    { kind: "write" }
  >;

describe("CLI describe", () => {
  test("answers one JSON-shaped document with every resource, verb, child, and route", () => {
    const doc = describeEntries(Object.entries(ADMIN_API_RESOURCES));
    expect(Object.keys(doc.resources).sort()).toEqual([
      "attributes",
      "groups",
      "holidays",
      "listings",
      "site-pages",
    ]);
    const attributes = doc.resources.attributes!;
    expect(attributes.label).toBe("Attribute");
    expect(attributes.verbs.create).toEqual({
      body: {
        fields: [{ name: "name", required: true, type: "string" }],
        kind: "fields",
      },
    });
    expect(attributes.verbs.delete).toEqual({
      body: {
        fields: [
          { name: "confirm_identifier", required: true, type: "string" },
        ],
        kind: "fields",
      },
    });
    expect(attributes.children.options).toEqual({
      idParam: "optionId",
      path: "options",
      verbs: {
        create: {
          body: {
            fields: [{ name: "text", required: true, type: "string" }],
            kind: "fields",
          },
        },
        delete: {
          body: {
            fields: [
              { name: "confirm_identifier", required: true, type: "string" },
            ],
            kind: "fields",
          },
        },
        update: {
          body: {
            fields: [{ name: "text", required: true, type: "string" }],
            kind: "fields",
          },
        },
      },
    });
    expect(doc.resources.listings!.verbs.create).toEqual({
      body: { kind: "server" },
    });
    expect(doc.resources.listings!.customRoutes).toEqual({
      attendees: { method: "GET", subpath: ":listingId/attendees" },
      deactivate: { method: "POST", subpath: ":listingId/deactivate" },
      delete: { method: "DELETE", subpath: ":listingId" },
      reactivate: { method: "POST", subpath: ":listingId/reactivate" },
    });
  });

  test("derives requiredness from the schema the table declares", () => {
    const doc = describeEntries(Object.entries(ADMIN_API_RESOURCES));
    expect(doc.resources.holidays!.verbs.update).toEqual({
      body: {
        fields: [
          { name: "end_date", required: false, type: "string" },
          { name: "name", required: false, type: "string" },
          { name: "start_date", required: false, type: "string" },
        ],
        kind: "fields",
      },
    });
    // The server defaults a silent site-page create to empty text and a
    // visible page, so describe names only the name and the slug required.
    expect(doc.resources["site-pages"]!.verbs.create).toEqual({
      body: {
        fields: [
          { name: "content", required: false, type: "string" },
          { name: "hidden", required: false, type: "boolean" },
          { name: "meta_description", required: false, type: "string" },
          { name: "meta_title", required: false, type: "string" },
          { name: "name", required: true, type: "string" },
          { name: "slug", required: true, type: "string" },
        ],
        kind: "fields",
      },
    });
  });

  test("answers the resources of the table it is handed", () => {
    const doc = describeEntries(Object.entries(testTable));
    assertArrayIncludes(Object.keys(doc.resources), ["gadgets"]);
    expect(doc.resources.gadgets!.children.parts).toBeDefined();
    expect(doc.resources.gadgets!.customRoutes.recalibrate).toEqual({
      method: "POST",
      subpath: ":gadgetId/recalibrate",
    });
  });

  test("reads array, nullable, and unnamed field shapes off a schema", () => {
    const shapes: AdminApiResource = {
      createBodySchema: v.object({
        days: v.array(v.string()),
        flag: v.boolean(),
        meta: v.object({ tone: v.string() }),
        note: v.nullable(v.string()),
        when: v.literal("now"),
      }),
      label: "Shape",
      listSchema: v.looseObject({ shapes: v.array(v.unknown()) }),
      path: "shapes",
      singleSchema: v.looseObject({ shape: v.unknown() }),
    };
    const doc = describeEntries([["shapes", shapes]]);
    expect(doc.resources.shapes!.verbs.create).toEqual({
      body: {
        fields: [
          {
            items: { type: "string" },
            name: "days",
            required: true,
            type: "array",
          },
          { name: "flag", required: true, type: "boolean" },
          {
            fields: [{ name: "tone", required: true, type: "string" }],
            name: "meta",
            required: true,
            type: "object",
          },
          { name: "note", required: true, type: "string" },
          { name: "when", required: true, type: "unknown" },
        ],
        kind: "fields",
      },
    });
  });

  test("refuses a body schema the walker cannot read as fields", () => {
    const broken: AdminApiResource = {
      createBodySchema: v.string(),
      label: "Broken",
      listSchema: v.looseObject({ broken: v.array(v.unknown()) }),
      path: "broken",
      singleSchema: v.looseObject({ broken: v.unknown() }),
    };
    expect(() => describeEntries([["broken", broken]])).toThrow(
      "a body schema in the admin api table must be an object schema",
    );
  });
});

describe("CLI parser", () => {
  test("parses the read verbs over a resource", () => {
    expect(parseCommand(testTable, ["list", "gadgets"])).toEqual({
      entry: gadgetEntry,
      kind: "list",
      resource: "gadgets",
    });
    expect(parseCommand(testTable, ["get", "gadgets", "5"])).toEqual({
      entry: gadgetEntry,
      id: 5,
      kind: "read",
      resource: "gadgets",
    });
  });

  test("parses root and child writes with their bodies", () => {
    expect(writeCommand(["create", "gadgets", '{"name":"N"}'])).toEqual({
      body: '{"name":"N"}',
      child: undefined,
      entry: gadgetEntry,
      kind: "write",
      parentId: 0,
      resource: "gadgets",
      verb: "create",
    });
    expect(
      writeCommand(["update", "gadgets", "3/parts/9", '{"label":"L"}']),
    ).toEqual({
      body: '{"label":"L"}',
      child: { def: gadgetEntry.children!.parts, id: 9, key: "parts" },
      entry: gadgetEntry,
      kind: "write",
      parentId: 3,
      resource: "gadgets",
      verb: "update",
    });
    expect(writeCommand(["delete", "gadgets", "3/parts/9"])).toEqual({
      body: undefined,
      child: { def: gadgetEntry.children!.parts, id: 9, key: "parts" },
      entry: gadgetEntry,
      kind: "write",
      parentId: 3,
      resource: "gadgets",
      verb: "delete",
    });
  });

  test("keeps a body argument that carries a slash", () => {
    expect(writeCommand(["create", "gadgets", '{"a/b":1}'])).toEqual({
      body: '{"a/b":1}',
      child: undefined,
      entry: gadgetEntry,
      kind: "write",
      parentId: 0,
      resource: "gadgets",
      verb: "create",
    });
  });

  test("answers exit 2 with the valid choices for an unknown command", () => {
    const answer = parseOrUsage(["publish", "gadgets"]);
    expect(answer.code).toBe(2);
    assertStringIncludes(answer.message, "Unknown command 'publish'");
  });

  test("answers exit 2 with the valid resources for an unknown resource", () => {
    const answer = parseOrUsage(["list", "orders"]);
    expect(answer.code).toBe(2);
    assertStringIncludes(answer.message, "The valid resources are:");
    assertStringIncludes(answer.message, "gadgets");
  });

  test("answers exit 2 with the valid children for an unknown child", () => {
    const answer = parseOrUsage(["update", "gadgets", "3/widgets/9", "{}"]);
    expect(answer.code).toBe(2);
    assertStringIncludes(answer.message, "has no child 'widgets'");
  });

  test("answers exit 2 for a non-whole-number id", () => {
    const answer = parseOrUsage(["get", "gadgets", "abc"]);
    expect(answer.code).toBe(2);
    expect(answer.message).toBe(
      "The gadget id must be a whole number, got 'abc'.",
    );
  });

  test("answers exit 2 when a create or update misses its body", () => {
    const create = parseOrUsage(["create", "gadgets"]);
    expect(create.code).toBe(2);
    expect(create.message).toBe(
      "The 'create' command needs a JSON body argument, or '-' to read it from stdin.",
    );
    expect(parseOrUsage(["update", "gadgets", "5"]).code).toBe(2);
  });

  test("answers exit 2 for an id argument that fits no address shape", () => {
    const trailing = parseOrUsage(["update", "gadgets", "3/parts/9/12", "{}"]);
    expect(trailing.code).toBe(2);
    assertStringIncludes(trailing.message, "does not fit");

    const emptyChild = parseOrUsage(["update", "gadgets", "3/", "{}"]);
    expect(emptyChild.code).toBe(2);
  });

  test("answers exit 2 for extra arguments on the read and write verbs", () => {
    expect(parseOrUsage(["list", "gadgets", "extra"]).code).toBe(2);
    expect(parseOrUsage(["create", "gadgets", "{}", "extra"]).code).toBe(2);
    expect(parseOrUsage(["update", "gadgets", "5", "{}", "x"]).code).toBe(2);
  });

  test("answers exit 2 for an unknown resource on a custom route", () => {
    const answer = parseOrUsage(["recalibrate", "orders", "5"]);
    expect(answer.code).toBe(2);
    assertStringIncludes(answer.message, "The valid resources are:");
  });

  test("answers exit 2 when the resource is missing entirely", () => {
    expect(parseOrUsage(["list"]).code).toBe(2);
    expect(parseOrUsage(["get"]).code).toBe(2);
    expect(parseOrUsage(["create"]).code).toBe(2);
    expect(parseOrUsage(["delete", "orders", "5"]).code).toBe(2);
  });

  test("answers exit 2 when a get misses its id", () => {
    const answer = parseOrUsage(["get", "gadgets"]);
    expect(answer.code).toBe(2);
    expect(answer.message).toBe("The 'get' command needs the gadget id.");
  });

  test("answers exit 2 when an update misses its id", () => {
    const answer = parseOrUsage(["update", "gadgets"]);
    expect(answer.code).toBe(2);
    expect(answer.message).toBe("The 'update' command needs the gadget id.");
  });

  test("names the empty route list of a resource without custom routes", () => {
    const answer = parseOrUsage(["recalibrate", "groups", "5"]);
    expect(answer.code).toBe(2);
    expect(answer.message).toBe(
      "The command 'recalibrate' is not a route of 'groups'. The routes of 'groups' are: none.",
    );
  });

  test("names the empty child list of a childless resource", () => {
    const answer = parseOrUsage(["update", "groups", "5/widgets", "{}"]);
    expect(answer.code).toBe(2);
    expect(answer.message).toBe(
      "The resource 'groups' has no child 'widgets'. Its children are: none.",
    );
  });

  test("answers exit 2 when a describe names a second argument", () => {
    expect(parseOrUsage(["describe", "gadgets", "extra"]).code).toBe(2);
  });

  test("parses a bare describe over the whole table and a named one", () => {
    const all: unknown = parseCommand(testTable, ["describe"]);
    expect(all).toEqual({
      kind: "describe",
      resources: Object.entries(testTable),
    });
    const one: unknown = parseCommand(testTable, ["describe", "gadgets"]);
    expect(one).toEqual({
      kind: "describe",
      resources: [["gadgets", gadgetEntry]],
    });
    expect(parseOrUsage(["describe", "orders"]).code).toBe(2);
  });

  test("answers exit 2 when a custom route misses the resource or the id", () => {
    const bare = parseOrUsage(["deactivate"]);
    expect(bare.code).toBe(2);
    assertStringIncludes(bare.message, "needs the resource and the id");

    const noId = parseOrUsage(["deactivate", "listings"]);
    expect(noId.code).toBe(2);

    const extra = parseOrUsage(["deactivate", "listings", "5", "6"]);
    expect(extra.code).toBe(2);
  });

  test("parses a delete with its confirmation body", () => {
    expect(
      writeCommand(["delete", "gadgets", "5", '{"confirm_identifier":"N"}']),
    ).toEqual({
      body: '{"confirm_identifier":"N"}',
      child: undefined,
      entry: gadgetEntry,
      kind: "write",
      parentId: 5,
      resource: "gadgets",
      verb: "delete",
    });
  });

  test("refuses a child id on a create", () => {
    const answer = parseOrUsage(["create", "gadgets", "3/parts/9", "{}"]);
    expect(answer.code).toBe(2);
    assertStringIncludes(answer.message, "does not fit");
  });
});

describe("CLI body schemas", () => {
  test("take the schema the table declares for the verb", () => {
    expect(
      bodySchemaFor(gadgetEntry, writeCommand(["create", "gadgets", "{}"])),
    ).toBeDefined();
    expect(
      bodySchemaFor(
        gadgetEntry,
        writeCommand(["create", "gadgets", "3/parts", "{}"]),
      ),
    ).toBeDefined();
    expect(
      bodySchemaFor(gadgetEntry, writeCommand(["delete", "gadgets", "5"])),
    ).toBeDefined();
    // The listing bodies the server validates carry no schema.
    expect(
      bodySchemaFor(
        ADMIN_API_RESOURCES.listings,
        writeCommand(["update", "listings", "5", "{}"]),
      ),
    ).toBeUndefined();
  });
});
