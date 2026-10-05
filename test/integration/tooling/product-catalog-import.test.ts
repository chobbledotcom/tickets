import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attributeVocabulary,
  categoryTitle,
  parseProductFile,
  readCategoryEntries,
} from "#cli/product-catalog.ts";
import {
  composeDescription,
  conflictLine,
  listingBody,
  matchedIds,
  minorUnits,
  parseImportFlags,
  planLine,
  resolveImportPlan,
  resolveOptionIds,
  storedTicketsId,
  withTicketsMeta,
} from "#cli/product-plan.ts";
import { withTempDir } from "#test-utils/files.ts";

describe("product catalog import", () => {
  const productFrontmatter = `---
title: 8 Lane Reindeer Racing Hire
subtitle: Festive roll-and-bowl racing for up to 8 players
price: £1695
order: 73
categories:
  - categories/christmas-game-hire.md
  - src/categories/fun-days.md
features:
  - Public liability insurance included
specs:
  - name: Players
    value: Up to 8 players
  - name: Power
    value: 2 x Power Socket
filter_attributes:
  - name: Guest Capacity
    value: 50-500+ guests
  - name: Power Required
    value: Mains power required
  - name: Mains power required
    value: TBC
options:
  - name: 1 Day
    max_quantity: 10
    unit_price: 1695
    days: 1
  - name: 7 Days
    max_quantity: 10
    unit_price: 3995
    days: 7
faqs:
  - question: Does it need power?
    answer: Yes.
---

Body text that the importer never reads.
`;

  test("writes the tickets ids before the closing fence once", () => {
    const withMeta = withTicketsMeta(productFrontmatter, {
      id: 42,
      slug: "9zz9z",
    });
    expect(withMeta).toContain("tickets_id: 42\ntickets_slug: 9zz9z\n---\n");
    // A rerun with the same ids leaves the block as it is.
    expect(withTicketsMeta(withMeta, { id: 42, slug: "9zz9z" })).toBe(withMeta);
  });

  test("replaces a stored placeholder and an older stamp", () => {
    const placeholder = "---\ntitle: Batak Lite\ntickets_id:\n---\n";
    expect(withTicketsMeta(placeholder, { id: 42, slug: "b" })).toBe(
      "---\ntitle: Batak Lite\ntickets_id: 42\ntickets_slug: b\n---\n",
    );
    const stamped = withTicketsMeta(placeholder, { id: 42, slug: "b" });
    expect(withTicketsMeta(stamped, { id: 43, slug: "c" })).toBe(
      "---\ntitle: Batak Lite\ntickets_id: 43\ntickets_slug: c\n---\n",
    );
  });

  test("leaves text without a closing fence unchanged", () => {
    const text = "---\ntitle: Batak Lite";
    expect(withTicketsMeta(text, { id: 42, slug: "b" })).toBe(text);
  });

  test("rejects a product with no rental options", () => {
    expect(() =>
      parseProductFile("batak.md", "---\ntitle: Batak Lite\n---\n"),
    ).toThrow("batak.md: a product needs at least one rental option");
    expect(() =>
      parseProductFile(
        "batak.md",
        "---\ntitle: Batak Lite\noptions:\n  - max_quantity: 5\n---\n",
      ),
    ).toThrow("batak.md: a product needs at least one rental option");
  });

  test("reads the importer flags, consuming the directory operand", () => {
    expect(parseImportFlags(["--dir", "cat", "--plan", "--update"])).toEqual({
      dir: "cat",
      plan: true,
      update: true,
    });
    expect(parseImportFlags(["--dir", "cat"])).toEqual({
      dir: "cat",
      plan: false,
      update: false,
    });
  });

  test("rejects a missing or flag-like --dir operand", () => {
    expect(() => parseImportFlags(["--dir"])).toThrow(
      "--dir requires a directory",
    );
    expect(() => parseImportFlags(["--dir", "--plan"])).toThrow(
      "--dir requires a directory",
    );
  });

  test("rejects an unknown or stray argument", () => {
    expect(() => parseImportFlags(["--paln"])).toThrow(
      "unknown argument: --paln",
    );
    expect(() => parseImportFlags(["../fun-pro-uk"])).toThrow(
      "unknown argument: ../fun-pro-uk",
    );
  });

  test("resolves every filter attribute to its option id", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    const ids = new Map(
      product.filterAttributes.map((attribute, index) => [
        `${attribute.name}\n${attribute.value}`,
        10 + index,
      ]),
    );
    expect(resolveOptionIds(product, ids)).toEqual([10, 11, 12]);
  });

  test("names the product whose attribute has no option id", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(() => resolveOptionIds(product, new Map())).toThrow(
      "a: no option id for Guest Capacity: 50-500+ guests",
    );
  });

  test("decides one action per product file", () => {
    expect(resolveImportPlan(42, [], false)).toEqual({
      action: "skip-imported",
    });
    expect(resolveImportPlan(null, [], false)).toEqual({
      action: "create",
    });
    expect(resolveImportPlan(null, [7], false)).toEqual({
      action: "skip-conflict",
      listingId: 7,
    });
    expect(resolveImportPlan(null, [7], true)).toEqual({
      action: "update",
      listingId: 7,
    });
    expect(resolveImportPlan(null, [7, 9], false)).toEqual({
      action: "skip-ambiguous",
      listingIds: [7, 9],
    });
  });

  test("prints the plan from the product's own selection", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(planLine({ action: "create" }, product)).toBe(
      "would create listing 8 Lane Reindeer Racing Hire " +
        "(2 rental options, 3 attributes)\n",
    );
    expect(planLine({ action: "update", listingId: 7 }, product)).toBe(
      "would update listing 8 Lane Reindeer Racing Hire " +
        "(2 rental options, 3 attributes)\n",
    );
    expect(planLine({ action: "skip-imported" }, product)).toBe(
      "already imported: 8 Lane Reindeer Racing Hire\n",
    );
    expect(planLine({ action: "skip-conflict", listingId: 7 }, product)).toBe(
      "would skip listing 8 Lane Reindeer Racing Hire: the name matches " +
        "listing 7; rerun with --update to overwrite it\n",
    );
    expect(
      planLine({ action: "skip-ambiguous", listingIds: [7, 9] }, product),
    ).toBe(
      "would skip listing 8 Lane Reindeer Racing Hire: the name matches " +
        "listings 7 and 9; rename one on the site and rerun\n",
    );
  });

  test("prints a real-run conflict line that names the way out", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(conflictLine(product, 7, false)).toBe(
      "skipped listing 8 Lane Reindeer Racing Hire: the name matches " +
        "listing 7; rerun with --update to overwrite it\n",
    );
  });

  test("reads a stored tickets id, or null for a placeholder", () => {
    expect(storedTicketsId("a.md", "---\ntickets_id: 42\n---\n")).toBe(42);
    expect(storedTicketsId("a.md", "---\ntickets_id:\n---\n")).toBeNull();
    expect(storedTicketsId("a.md", "---\ntitle: Batak Lite\n---\n")).toBeNull();
  });

  test("ignores a tickets id line in the body", () => {
    // A body that repeats the field name must not make the importer skip a
    // product it never imported.
    expect(
      storedTicketsId("a.md", "---\ntitle: Batak Lite\n---\n\ntickets_id: 5\n"),
    ).toBeNull();
  });

  test("reads nothing for text without a frontmatter block", () => {
    expect(storedTicketsId("a.md", "no frontmatter here")).toBeNull();
  });

  test("matches listings the way the site's name registry does", () => {
    // The server folds case and trims names, so a catalog title that differs
    // only by case is the same listing, not a duplicate create.
    const existing = [
      { id: 7, name: "  Batak LITE " },
      { id: 9, name: "Giant Jenga Hire" },
    ];
    expect(matchedIds("batak lite", existing)).toEqual([7]);
    expect(matchedIds("Batak Lite", existing)).toEqual([7]);
    expect(matchedIds("Giant Jenga Hire", existing)).toEqual([9]);
    expect(matchedIds("Coconut Shy", existing)).toEqual([]);
  });

  test("rejects a stored id that cannot name a listing", () => {
    for (const value of ["0", "99999999999999999999"]) {
      expect(() =>
        storedTicketsId("a.md", `---\ntickets_id: ${value}\n---\n`),
      ).toThrow("a.md: tickets_id must be a positive whole number");
    }
  });

  test("rejects a non-numeric stored tickets id", () => {
    // A present but malformed value must not read as absent: the importer
    // would create the product again or overwrite a name match.
    for (const value of ["abc", "-1", "1.5"]) {
      expect(() =>
        storedTicketsId("a.md", `---\ntickets_id: ${value}\n---\n`),
      ).toThrow("a.md: tickets_id must be a positive whole number");
    }
  });

  test("reads a category title, or the slug when the file has none", async () => {
    await withTempDir(async (dir) => {
      await Deno.writeTextFile(
        `${dir}/christmas.md`,
        "---\ntitle: Christmas Game Hire\n---\n",
      );
      await Deno.writeTextFile(`${dir}/untitled.md`, "no frontmatter");
      expect(await categoryTitle(dir, "christmas")).toBe("Christmas Game Hire");
      expect(await categoryTitle(dir, "untitled")).toBe("untitled");
    });
  });

  test("stops when a category file is missing or cannot be read", async () => {
    await withTempDir(async (dir) => {
      // A stale or misspelled category path must not quietly create a
      // wrongly named group.
      await expect(categoryTitle(dir, "missing")).rejects.toThrow();
      await Deno.writeTextFile(
        `${dir}/broken.md`,
        "---\ntitle: [unclosed\n---\n",
      );
      await expect(categoryTitle(dir, "broken")).rejects.toThrow(
        `${dir}/broken.md: unparseable frontmatter:`,
      );
      // A slug that names a directory is a read error, not a missing file.
      await Deno.mkdir(`${dir}/subdir.md`);
      await expect(categoryTitle(dir, "subdir")).rejects.toThrow();
    });
  });

  test("preflights every category name before any site change", async () => {
    await withTempDir(async (dir) => {
      await Deno.writeTextFile(
        `${dir}/christmas-game-hire.md`,
        "---\ntitle: Christmas Game Hire\n---\n",
      );
      await Deno.writeTextFile(
        `${dir}/fun-days.md`,
        "---\ntitle: Fun Days\n---\n",
      );
      expect(
        await readCategoryEntries(dir, ["christmas-game-hire", "fun-days"]),
      ).toEqual([
        { name: "Christmas Game Hire", slug: "christmas-game-hire" },
        { name: "Fun Days", slug: "fun-days" },
      ]);
      // The preflight runs before the first API call, so a stale category
      // path cannot leave half the catalog imported.
      await expect(readCategoryEntries(dir, ["missing"])).rejects.toThrow();
    });
  });

  test("keeps the stamp out of a body that mentions tickets_id", () => {
    const text = "---\ntitle: Batak Lite\n---\n\nbody tickets_id: 5\n";
    expect(withTicketsMeta(text, { id: 42, slug: "b" })).toBe(
      "---\ntitle: Batak Lite\ntickets_id: 42\ntickets_slug: b\n---\n\nbody tickets_id: 5\n",
    );
  });

  test("stamps a CRLF file with its own line endings", () => {
    // A stamp must stay a two-line change: the body keeps the file's CRLF.
    expect(
      withTicketsMeta("---\r\ntitle: Batak Lite\r\n---\r\n", {
        id: 42,
        slug: "b",
      }),
    ).toBe(
      "---\r\ntitle: Batak Lite\r\ntickets_id: 42\r\ntickets_slug: b\r\n---\r\n",
    );
  });
  test("collects the attribute vocabulary in first-seen order", () => {
    const first = parseProductFile("a.md", productFrontmatter)!;
    const second = parseProductFile(
      "b.md",
      productFrontmatter.replace("50-500+ guests", "20-200 guests"),
    )!;
    const vocabulary = attributeVocabulary([first, second]);
    expect(vocabulary).toEqual([
      {
        name: "Guest Capacity",
        // First seen first; the second product's value follows.
        values: ["50-500+ guests", "20-200 guests"],
      },
      {
        name: "Power Required",
        values: ["Mains power required", "TBC"],
      },
    ]);
  });

  test("maps whole pounds to minor units", () => {
    expect(minorUnits(1695)).toBe(169500);
  });

  test("composes the description from subtitle, specs, and features", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(composeDescription(product)).toBe(
      [
        "Festive roll-and-bowl racing for up to 8 players",
        [
          "### Specifications",
          "- Players: Up to 8 players",
          "- Power: 2 x Power Socket",
        ].join("\n"),
        ["### What's included", "- Public liability insurance included"].join(
          "\n",
        ),
      ].join("\n\n"),
    );
  });

  test("builds the listing body from the rental options", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(listingBody(product, [11, 12], [5])).toEqual({
      attribute_option_ids: [11, 12],
      customisable_days: true,
      day_prices: { 1: 169500, 7: 399500 },
      description: composeDescription(product),
      duration_days: 7,
      fields: "email,phone,address",
      group_ids: [5],
      hidden: true,
      listing_type: "daily",
      max_attendees: 1,
      max_quantity: 10,
      name: "8 Lane Reindeer Racing Hire",
    });
  });
  test("caps the listing quantity at the strictest option", () => {
    const product = parseProductFile(
      "a.md",
      [
        "---",
        "title: Batak Lite",
        "options:",
        "  - name: 1 Day",
        "    max_quantity: 10",
        "    unit_price: 100",
        "  - name: 7 Days",
        "    days: 7",
        "    max_quantity: 2",
        "    unit_price: 500",
        "---",
      ].join("\n"),
    )!;
    expect(listingBody(product, [], []).max_quantity).toBe(2);
  });
});
