// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  memberRowHtml,
  packageSectionHtml,
} from "#test/specs/support/package-section.ts";
import type { Group } from "#types";

// jscpd:ignore-end

describe("the package section helpers", () => {
  const group = { id: 7, name: "Camp Kit" } as Group;

  /** A package section as the ticket page renders it: the package's fieldset,
   * its description, one member whose row carries a nested child-selector
   * fieldset (a member that is itself a parent), and one plain member after
   * it (listing-rows.ts renders the section, child-block.ts the nested one). */
  const pageWithNestedMemberRow = (): string =>
    "<main>" +
    '<fieldset class="package-section" data-package-section="7">' +
    "<legend>Camp Kit</legend>" +
    '<div class="prose"><p>Everything for camp. <img src="/image/kit.webp" alt="Kit"></p></div>' +
    '<div class="ticket-row package-member">' +
    '<img src="/image/bedroll.webp" alt="Bedroll">' +
    '<label>Tent <span class="package-member-qty">&times;1</span></label>' +
    "<p>Tent words</p>" +
    '<fieldset class="child-selector" data-parent-id="12">' +
    "<legend>Choose your tent</legend>" +
    '<label class="child-option"><input type="checkbox">Green tent</label>' +
    "</fieldset>" +
    "</div>" +
    '<div class="ticket-row package-member">' +
    '<label>Lantern <span class="package-member-qty">&times;2</span></label>' +
    "</div>" +
    "</fieldset>" +
    "</main>";

  const section = packageSectionHtml(pageWithNestedMemberRow(), group);

  /** The member's row slice, with the claim every row test shares: the slice
   * starts at the row's own opening tag. */
  const rowSlice = (name: string): string => {
    const row = memberRowHtml(section, name);
    expect(row.startsWith('<div class="ticket-row package-member">')).toBe(
      true,
    );
    return row;
  };

  test("slices the section from its attribute to its own close", () => {
    expect(section.startsWith('data-package-section="7">')).toBe(true);
    expect(section.endsWith("</fieldset>")).toBe(true);
    expect(section).not.toContain("</main>");
  });

  test("keeps the rows that follow a member's nested fieldset inside", () => {
    expect(section).toContain(
      '<label>Lantern <span class="package-member-qty">&times;2</span></label>',
    );
  });

  test("slices a section that holds no nested fieldset whole", () => {
    const page =
      '<fieldset class="package-section" data-package-section="7">' +
      "<legend>Camp Kit</legend>" +
      '<div class="ticket-row package-member">' +
      '<label>Tent <span class="package-member-qty">&times;1</span></label>' +
      "</div>" +
      "</fieldset>";
    expect(packageSectionHtml(page, group)).toBe(
      page.slice(page.indexOf('data-package-section="7"')),
    );
  });

  test("fails loudly when the page shows no section for the package", () => {
    expect(() => packageSectionHtml("<main></main>", group)).toThrow(
      "shows no section for the package Camp Kit",
    );
  });

  test("fails loudly when the page never closes the section", () => {
    const page =
      '<fieldset class="package-section" data-package-section="7">' +
      "<legend>Camp Kit</legend>";
    expect(() => packageSectionHtml(page, group)).toThrow(
      "leaves the package Camp Kit's section open",
    );
  });

  test("slices one member's row out of the section", () => {
    const row = rowSlice("Tent");
    expect(row).toContain('alt="Bedroll"');
    expect(row).toContain(
      '<label>Tent <span class="package-member-qty">&times;1</span></label>',
    );
    expect(row).not.toContain("Lantern");
    // A member that is itself a parent keeps its child selector in its row.
    expect(row).toContain('<fieldset class="child-selector"');
    expect(row).toContain("</fieldset></div>");
  });

  test("slices the last member's row to the section's end", () => {
    const row = rowSlice("Lantern");
    expect(row).toContain(
      '<label>Lantern <span class="package-member-qty">&times;2</span></label>',
    );
    expect(row).not.toContain('alt="Bedroll"');
    expect(row.endsWith("</fieldset>")).toBe(true);
  });

  test("fails loudly when the member's label sits outside any row", () => {
    const rowless = section.replace(
      '<div class="ticket-row package-member">',
      "",
    );
    expect(() => memberRowHtml(rowless, "Tent")).toThrow(
      "renders Tent outside a row",
    );
  });

  test("does not count a picture hoisted above the rows as the row's own", () => {
    // The regression the row slice exists to catch: the member's picture
    // rendered at the top of the section, outside its row, once passed.
    const hoisted = pageWithNestedMemberRow()
      .replace(
        '<div class="ticket-row package-member">' +
          '<img src="/image/bedroll.webp" alt="Bedroll">',
        '<div class="ticket-row package-member">',
      )
      .replace(
        "<legend>Camp Kit</legend>",
        "<legend>Camp Kit</legend>" +
          '<img src="/image/bedroll.webp" alt="Bedroll">',
      );
    const row = memberRowHtml(packageSectionHtml(hoisted, group), "Tent");
    expect(row).not.toContain('alt="Bedroll"');
  });

  test("fails loudly when the section shows no row for the member", () => {
    expect(() => memberRowHtml(section, "Stove")).toThrow(
      "shows no row for Stove",
    );
  });
});
