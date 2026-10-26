/**
 * A package's section slice holds the whole section: a member that is itself
 * a parent renders its own fieldset inside the section, and an early close
 * would hide every later member's row. A member's row slice holds that
 * member's own row only, so a picture the row should carry cannot pass by
 * appearing anywhere in the section.
 */

// jscpd:ignore-start

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  packageMemberRowHtml,
  packageSectionHtml,
} from "#test/specs/support/ticket-page-images.ts";

// jscpd:ignore-end

const group = { id: 7, name: "Hamper" };

const memberRow = (name: string, body: string): string =>
  `<div class="ticket-row package-member"><label>${name} <span class="package-member-qty">&times;1</span></label>${body}</div>`;

/** A package section whose first member is a parent: its row carries a
 * nested child-selector fieldset, and a later member follows it. */
const sectionWithNestedFieldset = [
  `<fieldset class="ticket-package" data-package-section="${group.id}">`,
  "<legend>Hamper</legend>",
  `<p>the package's own words</p>`,
  memberRow(
    "Tent",
    `<p><img src="/image/tent.webp" alt="Bedroll"></p>` +
      `<fieldset class="child-selector" data-parent-id="12">` +
      "<legend>Choose a Tent</legend><div>an option</div></fieldset>",
  ),
  memberRow("Lamp", `<p><img src="/image/lamp.webp" alt="Lamp"></p>`),
  "</fieldset>",
  "<p>the next thing on the page</p>",
].join("");

describe("packageSectionHtml", () => {
  test("holds the whole section across a nested child-selector fieldset", () => {
    const section = packageSectionHtml(sectionWithNestedFieldset, group);
    assertStringIncludes(section, "<legend>Hamper</legend>");
    assertStringIncludes(section, "the package's own words");
    assertStringIncludes(section, "<label>Tent <span");
    assertStringIncludes(section, "<label>Lamp <span");
    expect(section.startsWith("<fieldset")).toBe(true);
    expect(section.endsWith("</fieldset>")).toBe(true);
    expect(section.includes("the next thing on the page")).toBe(false);
  });

  test("throws when the page shows no section for the package", () => {
    expect(() => packageSectionHtml("<p>nothing here</p>", group)).toThrow(
      /no section for the package Hamper/,
    );
  });
});

describe("packageMemberRowHtml", () => {
  test("holds the named member's row alone", () => {
    const row = packageMemberRowHtml(sectionWithNestedFieldset, "Tent");
    assertStringIncludes(row, "<label>Tent <span");
    assertStringIncludes(row, '<img src="/image/tent.webp" alt="Bedroll">');
    expect(row.includes('<img src="/image/lamp.webp"')).toBe(false);
  });

  test("finds a member whose row follows a nested fieldset", () => {
    const row = packageMemberRowHtml(sectionWithNestedFieldset, "Lamp");
    assertStringIncludes(row, '<img src="/image/lamp.webp" alt="Lamp">');
    expect(row.includes("Bedroll")).toBe(false);
  });

  test("throws when no row carries the member's name", () => {
    expect(() =>
      packageMemberRowHtml(sectionWithNestedFieldset, "Stove"),
    ).toThrow(/no row for the member Stove/);
  });
});
