/**
 * Rules the navigation must keep. Every link here names a route declared in
 * `areas.ts`, so these checks are what stop the sidebar pointing at something
 * the routing layer does not serve.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ADMIN_SECTIONS } from "#shared/admin-surface/sections.ts";
import {
  ADMIN_SURFACE,
  adminDestination,
  adminPattern,
} from "#shared/admin-surface.ts";

const navEntries = ADMIN_SECTIONS.flatMap((section) =>
  section.nav.map((entry) => ({ entry, section })),
);

describe("the admin sections table", () => {
  test("keeps the complete top-level section order", () => {
    expect(ADMIN_SECTIONS.map((section) => section.id)).toEqual([
      "home",
      "listings",
      "calendar",
      "servicing",
      "attendees",
      "users",
      "groups",
      "images",
      "modifiers",
      "ledger",
      "site",
      "settings",
    ]);
  });

  test("keeps each section's sub-navigation in its declared order", () => {
    const users = ADMIN_SECTIONS.find((section) => section.id === "users")!;
    expect(users.nav.map((entry) => entry.id)).toEqual([
      "users",
      "userNew",
      "sessions",
      "apiKeys",
    ]);
  });

  test("names a real route in every link", () => {
    const missing = navEntries
      .filter(({ entry }) => ADMIN_SURFACE.destinations[entry.id] === undefined)
      .map(({ entry, section }) => `${section.id}: ${entry.id}`);
    expect(missing).toEqual([]);
  });

  test("gives every section a landing route it can link to", () => {
    const missing = ADMIN_SECTIONS.filter(
      (section) => ADMIN_SURFACE.destinations[section.landing] === undefined,
    ).map((section) => section.id);
    expect(missing).toEqual([]);
  });

  test("opens every section with its own landing link", () => {
    const wrong = ADMIN_SECTIONS.filter(
      (section) => section.nav[0]?.id !== section.landing,
    ).map((section) => section.id);
    expect(wrong).toEqual([]);
  });

  test("marks exactly the landing link as the landing kind", () => {
    const wrong = navEntries
      .filter(
        ({ entry, section }) =>
          (entry.kind === "landing") !== (entry.id === section.landing),
      )
      .map(({ entry, section }) => `${section.id}: ${entry.id}`);
    expect(wrong).toEqual([]);
  });

  test("points every add and import link at a write form", () => {
    // Read-only mode hides a link by its route's intent, so a create link
    // pointing at a view route would stay clickable with writing switched off.
    const readable = navEntries
      .filter(({ entry }) => entry.kind === "create" || entry.kind === "import")
      .filter(({ entry }) => adminDestination(entry.id).intent !== "write-form")
      .map(({ entry }) => entry.id);
    expect(readable).toEqual([]);
  });

  test("links to each route from one section only", () => {
    const seen = new Set<string>();
    const twice: string[] = [];
    for (const { entry } of navEntries) {
      if (seen.has(entry.id)) twice.push(entry.id);
      seen.add(entry.id);
    }
    expect(twice).toEqual([]);
  });
});

/** Every message key the English catalog defines, across all its files. */
const catalogKeys = new Set(
  Array.from(Deno.readDirSync("src/locales/en"))
    .filter((entry) => entry.name.endsWith(".json"))
    .flatMap((entry) =>
      Object.keys(
        JSON.parse(Deno.readTextFileSync(`src/locales/en/${entry.name}`)),
      ),
    ),
);

describe("the words the navigation shows", () => {
  test("names a real message for every section", () => {
    const missing = ADMIN_SECTIONS.filter(
      (section) => !catalogKeys.has(section.labelKey),
    ).map((section) => `${section.id}: ${section.labelKey}`);
    expect(missing).toEqual([]);
  });

  test("names a real message for every link", () => {
    const missing = navEntries
      .filter(({ entry }) => !catalogKeys.has(entry.labelKey))
      .map(({ entry }) => `${entry.id}: ${entry.labelKey}`);
    expect(missing).toEqual([]);
  });
});

describe("the sections that own a record page", () => {
  const withDetail = ADMIN_SECTIONS.filter(
    (section) => section.detail !== undefined,
  );

  test("cover listings and groups", () => {
    expect(withDetail.map((section) => section.id)).toEqual([
      "listings",
      "groups",
    ]);
  });

  test("name the record page and the form to fall back to", () => {
    expect(
      withDetail.map((section) => [
        adminPattern(section.detail!.page),
        adminPattern(section.detail!.editForm),
      ]),
    ).toEqual([
      ["/admin/listing/:id", "/admin/listing/:id/edit"],
      ["/admin/groups/:id", "/admin/groups/:id/edit"],
    ]);
  });

  test("point both routes at one record", () => {
    const wrong = withDetail
      .filter(({ detail }) =>
        [detail!.page, detail!.editForm].some(
          (id) => !adminPattern(id).includes(":id"),
        ),
      )
      .map((section) => section.id);
    expect(wrong).toEqual([]);
  });

  test("keep the record page out of an editor's reach", () => {
    // Every tab of both pages is staff-only, so an editor following the link
    // would meet a 404. entityReturnPath reads this audience to send them to
    // the edit form instead, which is why the two must stay apart.
    const open = withDetail.filter(({ detail }) =>
      adminDestination(detail!.page).audience.includes("editor"),
    );
    expect(open.map((section) => section.id)).toEqual([]);
  });

  test("keep the edit form within an editor's reach", () => {
    const shut = withDetail.filter(
      ({ detail }) =>
        !adminDestination(detail!.editForm).audience.includes("editor"),
    );
    expect(shut.map((section) => section.id)).toEqual([]);
  });
});
