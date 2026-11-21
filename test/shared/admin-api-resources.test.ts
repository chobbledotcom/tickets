import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
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
      "attendee-statuses": {
        children: {},
        custom: {},
        label: "Status",
        path: "attendee-statuses",
        serves: null,
      },
      attendees: {
        children: {},
        custom: {},
        label: "Attendee",
        path: "attendees",
        serves: { create: true, update: true },
      },
      attributes: {
        children: { options: { idParam: "optionId", path: "options" } },
        custom: {},
        label: "Attribute",
        path: "attributes",
        serves: null,
      },
      "external-sources": {
        children: { links: { idParam: "linkId", path: "links" } },
        custom: {
          linkLookup: { method: "GET", subpath: "lookup" },
          linkSearch: { method: "GET", subpath: "links" },
          links: { method: "GET", subpath: ":sourceId/links" },
        },
        label: "Source",
        path: "external-sources",
        serves: null,
      },
      groups: {
        children: {},
        custom: {},
        label: "Group",
        path: "groups",
        serves: null,
      },
      holidays: {
        children: {},
        custom: {},
        label: "Holiday",
        path: "holidays",
        serves: null,
      },
      images: {
        children: {},
        custom: {},
        label: "Image",
        path: "images",
        serves: null,
      },
      listings: {
        children: {},
        custom: {
          attendees: { method: "GET", subpath: ":listingId/attendees" },
          deactivate: { method: "POST", subpath: ":listingId/deactivate" },
          delete: { method: "DELETE", subpath: ":listingId" },
          reactivate: { method: "POST", subpath: ":listingId/reactivate" },
        },
        label: "Listing",
        path: "listings",
        serves: null,
      },
      questions: {
        children: { answers: { idParam: "answerId", path: "answers" } },
        custom: {
          bookings: { method: "GET", subpath: ":questionId/bookings" },
        },
        label: "Question",
        path: "questions",
        serves: null,
      },
      "site-pages": {
        children: {},
        custom: FIXED_PAGE_ROUTES,
        label: "Page",
        path: "site-pages",
        serves: null,
      },
    });
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

  test("a create keeps the assign-all switch, display type, and text", () => {
    expect(parseApiBody(questionBody().create, FULL_BODY)).toEqual({
      ok: true,
      value: FULL_BODY,
    });
  });

  test("an update keeps the assign-all switch, display type, and text", () => {
    expect(parseApiBody(questionBody().update, FULL_BODY)).toEqual({
      ok: true,
      value: FULL_BODY,
    });
  });

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
