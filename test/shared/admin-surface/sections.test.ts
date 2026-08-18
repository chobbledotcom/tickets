/**
 * Rules the navigation must keep. Every link here names a route declared in
 * `areas.ts`, so these checks are what stop the sidebar pointing at something
 * the routing layer does not serve.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ADMIN_SECTIONS } from "#shared/admin-surface/sections.ts";
import { ADMIN_SURFACE, adminDestination } from "#shared/admin-surface.ts";

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
