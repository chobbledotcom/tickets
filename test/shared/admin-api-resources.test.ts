import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
  adminApiServes,
  CreateSitePageBodySchema,
  HolidayRowSchema,
  QuestionRowSchema,
  SitePageRowSchema,
  UpdateSitePageBodySchema,
} from "#shared/admin-api-resources.ts";
import { parseApiBody } from "#shared/rest/crud-parsers.ts";

const RESOURCES: Record<string, AdminApiResource> = ADMIN_API_RESOURCES;

/** The fixed pages a site-page client reads and writes by name. */
const FIXED_PAGE_ROUTES = Object.fromEntries(
  ["contact", "home", "terms"].flatMap((page) =>
    ["DELETE", "GET", "POST", "PUT"].map((method) => [
      `${page}-${method.toLowerCase()}`,
      { method, subpath: page },
    ]),
  ),
);

/** What each resource declares: its label, path, routes, and child paths. */
const declaredTable = () =>
  Object.fromEntries(
    Object.entries(RESOURCES).map(([name, entry]) => [
      name,
      {
        children: Object.fromEntries(
          Object.entries(entry.children ?? {}).map(([child, declared]) => [
            child,
            { idParam: declared.idParam, path: declared.path },
          ]),
        ),
        custom: entry.custom ?? {},
        label: entry.label,
        path: entry.path,
        serves: entry.serves ?? null,
      },
    ]),
  );

type Declared = {
  children: Record<string, { idParam: string; path: string }>;
  custom: Record<string, { method: string; subpath: string }>;
  label: string;
  path: string;
  serves: Record<string, boolean> | null;
};

/** A declared resource, with no child paths, custom routes, or serves flags
 *  unless the case names them. */
const declared = (
  label: string,
  path: string,
  named: Partial<Declared> = {},
): Declared => ({
  children: {},
  custom: {},
  label,
  path,
  serves: null,
  ...named,
});

/** A custom route of a resource. */
const route = (method: string, subpath: string) => ({ method, subpath });

describe("admin api resource table", () => {
  test("a holiday row keeps the fields the table does not name", () => {
    const row = v.parse(HolidayRowSchema, {
      created: "2026-10-07T00:00:00.000Z",
      end_date: "2026-10-10",
      id: 3,
      name: "Fair week",
      start_date: "2026-10-08",
    });
    expect(row).toMatchObject({ id: 3, name: "Fair week" });
    expect((row as Record<string, unknown>).created).toBe(
      "2026-10-07T00:00:00.000Z",
    );
  });

  test("declares every resource's label, path, routes, and children", () => {
    expect(declaredTable()).toEqual({
      "attendee-statuses": declared("Status", "attendee-statuses"),
      attendees: declared("Attendee", "attendees", {
        serves: { create: true, update: true },
      }),
      attributes: declared("Attribute", "attributes", {
        children: { options: { idParam: "optionId", path: "options" } },
      }),
      "external-sources": declared("Source", "external-sources", {
        children: { links: { idParam: "linkId", path: "links" } },
        custom: {
          linkLookup: route("GET", "lookup"),
          linkSearch: route("GET", "links"),
          links: route("GET", ":sourceId/links"),
        },
      }),
      groups: declared("Group", "groups"),
      holidays: declared("Holiday", "holidays"),
      images: declared("Image", "images"),
      listings: declared("Listing", "listings", {
        custom: {
          attendees: route("GET", ":listingId/attendees"),
          deactivate: route("POST", ":listingId/deactivate"),
          delete: route("DELETE", ":listingId"),
          reactivate: route("POST", ":listingId/reactivate"),
        },
      }),
      questions: declared("Question", "questions", {
        children: { answers: { idParam: "answerId", path: "answers" } },
        custom: { bookings: route("GET", ":questionId/bookings") },
      }),
      redirects: declared("Redirect", "redirects", {
        serves: { create: true, delete: true, list: true },
      }),
      "site-pages": declared("Page", "site-pages", {
        custom: FIXED_PAGE_ROUTES,
      }),
    });
  });
});

describe("adminApiServes", () => {
  test("a resource with no declaration serves all five routes", () => {
    for (const verb of ["create", "delete", "get", "list", "update"] as const) {
      expect(adminApiServes({}, verb)).toBe(true);
    }
  });

  test("a declaration serves only the routes it lists", () => {
    const redirects = ADMIN_API_RESOURCES.redirects;
    expect(
      (["create", "delete", "get", "list", "update"] as const).filter((verb) =>
        adminApiServes(redirects, verb),
      ),
    ).toEqual(["create", "delete", "list"]);
  });
});

describe("the site page bodies", () => {
  const FULL_BODY = {
    content: "Body text",
    hidden: true,
    meta_description: "A description",
    meta_title: "A title",
    name: "About",
    slug: "about",
  };

  test("a create keeps every writable field", () => {
    expect(parseApiBody(CreateSitePageBodySchema, FULL_BODY)).toEqual({
      ok: true,
      value: FULL_BODY,
    });
  });

  test("an update keeps every writable field and the parent", () => {
    expect(
      parseApiBody(UpdateSitePageBodySchema, { ...FULL_BODY, parent: 4 }),
    ).toEqual({ ok: true, value: { ...FULL_BODY, parent: 4 } });
    expect(parseApiBody(UpdateSitePageBodySchema, { parent: null })).toEqual({
      ok: true,
      value: { parent: null },
    });
  });

  test("a create answers a required message for a missing name or slug", () => {
    expect(parseApiBody(CreateSitePageBodySchema, { slug: "about" })).toEqual({
      error: "name is required",
      ok: false,
    });
    expect(parseApiBody(CreateSitePageBodySchema, { name: "About" })).toEqual({
      error: "Slug is required",
      ok: false,
    });
    expect(
      parseApiBody(CreateSitePageBodySchema, { name: "About", slug: "  " }),
    ).toEqual({ error: "Slug is required", ok: false });
  });

  test("an update refuses a parent that is not a page id or null", () => {
    expect(parseApiBody(UpdateSitePageBodySchema, { parent: "x" })).toEqual({
      error: "parent must be a page id or null",
      ok: false,
    });
  });

  test("a row refuses a parent that is not a page id or null", () => {
    const result = v.safeParse(SitePageRowSchema, {
      name: "About",
      parent: "x",
      slug: "about",
    });
    expect(result.success ? null : result.issues[0].message).toBe(
      "parent must be a page id or null",
    );
  });
});

describe("the question bodies", () => {
  const questionBody = () => ({
    create: ADMIN_API_RESOURCES.questions.createBodySchema,
    update: ADMIN_API_RESOURCES.questions.updateBodySchema,
  });
  const FULL_BODY = {
    assign_all: true,
    display_type: "free_text",
    text: "Any allergies?",
  };

  for (const [action, schema] of Object.entries(questionBody())) {
    test(`a ${action} keeps the assign-all switch, display type, and text`, () => {
      expect(parseApiBody(schema, FULL_BODY)).toEqual({
        ok: true,
        value: FULL_BODY,
      });
    });
  }

  test("a create answers a required message for missing or empty text", () => {
    const withoutText = { assign_all: false, display_type: "radio" };
    expect(parseApiBody(questionBody().create, withoutText)).toEqual({
      error: "text is required",
      ok: false,
    });
    expect(
      parseApiBody(questionBody().create, { ...withoutText, text: "" }),
    ).toEqual({ error: "text is required", ok: false });
  });

  test("a create answers a required message for a missing display type", () => {
    expect(
      parseApiBody(questionBody().create, { assign_all: false, text: "Why?" }),
    ).toEqual({ error: "display_type is required", ok: false });
  });

  test("a question row carries its assign-all switch and display type", () => {
    const row = {
      answers: [{ id: 1, text: "Yes", times_selected: 2 }],
      assign_all: false,
      display_type: "radio",
      id: 5,
      text: "Ok?",
    };
    expect(v.parse(QuestionRowSchema, row)).toEqual(row);
    expect(
      v.safeParse(QuestionRowSchema, { ...row, display_type: "bogus" }).success,
    ).toBe(false);
  });
});

describe("the bodies a field list declares", () => {
  const bodies = [
    ["attribute", ADMIN_API_RESOURCES.attributes, { name: "Difficulty" }],
    [
      "holiday",
      ADMIN_API_RESOURCES.holidays,
      {
        end_date: "2025-12-26",
        name: "Christmas",
        start_date: "2025-12-25",
      },
    ],
    [
      "redirect",
      ADMIN_API_RESOURCES.redirects,
      { from_path: "/old-page", to_url: "/new-page" },
    ],
  ] as const;

  test("the holiday, redirect, and attribute entries carry their field list", () => {
    expect([
      ADMIN_API_RESOURCES.attributes.fields?.map((field) => field.key),
      ADMIN_API_RESOURCES.holidays.fields?.map((field) => field.key),
      ADMIN_API_RESOURCES.redirects.fields?.map((field) => field.key),
    ]).toEqual([
      ["name"],
      ["name", "startDate", "endDate"],
      ["fromPath", "toUrl"],
    ]);
  });

  for (const [name, entry, body] of bodies) {
    test(`a ${name} create keeps its declared body, and an update takes none`, () => {
      expect(parseApiBody(entry.createBodySchema, body)).toEqual({
        ok: true,
        value: body,
      });
      expect(parseApiBody(entry.updateBodySchema, {})).toEqual({
        ok: true,
        value: {},
      });
    });
  }
});

describe("a body field of the wrong type names the field", () => {
  const updateSitePage = UpdateSitePageBodySchema;
  const updateQuestion = ADMIN_API_RESOURCES.questions.updateBodySchema;
  const cases = [
    [updateSitePage, { content: 1 }, "content must be a string"],
    [updateSitePage, { hidden: "yes" }, "hidden must be a boolean"],
    [
      updateSitePage,
      { meta_description: 1 },
      "meta_description must be a string",
    ],
    [updateSitePage, { meta_title: 1 }, "meta_title must be a string"],
    [updateSitePage, { slug: 1 }, "slug must be a string"],
    [updateQuestion, { assign_all: "yes" }, "assign_all must be a boolean"],
    [updateQuestion, { text: 1 }, "text must be a string"],
  ] as const;

  for (const [schema, body, error] of cases) {
    test(`an update refuses "${error}"`, () => {
      expect(parseApiBody(schema, body)).toEqual({ error, ok: false });
    });
  }
});
