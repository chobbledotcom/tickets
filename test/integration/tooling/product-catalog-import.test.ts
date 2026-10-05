import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseProductFile } from "#cli/product-catalog/parse.ts";
import {
  composeDescription,
  conflictLine,
  ensureNamespaceFree,
  listingBody,
  matchedIds,
  minorUnits,
  parseImportFlags,
  planLine,
  refuseChangedFile,
  resolveImportPlan,
  resolveOptionIds,
  storedTicketsId,
  withTicketsMeta,
} from "#cli/product-plan.ts";

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
      parseProductFile("batak.md", "---\ntitle: Batak Lite\noptions:\n---\n"),
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
    const listings = [
      { id: 42, name: "Batak Lite" },
      { id: 7, name: "Old Batak" },
      { id: 9, name: "Giant Jenga Hire" },
    ];
    expect(
      resolveImportPlan(
        { filename: "a.md", id: 42, title: "Batak Lite" },
        [],
        false,
        listings,
      ),
    ).toEqual({ action: "skip-imported" });
    // The site folds case and trims names, so a differently spelled listing
    // name still proves the stamp.
    expect(
      resolveImportPlan(
        { filename: "a.md", id: 42, title: "Batak Lite" },
        [],
        false,
        [{ id: 42, name: "  batak lite " }],
      ),
    ).toEqual({ action: "skip-imported" });
    expect(resolveImportPlan(null, [], false, listings)).toEqual({
      action: "create",
    });
    expect(resolveImportPlan(null, [7], false, listings)).toEqual({
      action: "skip-conflict",
      listingId: 7,
    });
    expect(resolveImportPlan(null, [7], true, listings)).toEqual({
      action: "update",
      listingId: 7,
    });
    expect(resolveImportPlan(null, [7, 9], false, listings)).toEqual({
      action: "skip-ambiguous",
      listingIds: [7, 9],
    });
  });

  test("refuses a stamp that names no live listing", () => {
    // The site may have deleted the listing, or the import may point at
    // another site: a skipped file would keep the invalid reference forever.
    expect(() =>
      resolveImportPlan(
        { filename: "a.md", id: 43, title: "Batak Lite" },
        [],
        false,
        [{ id: 42, name: "Batak Lite" }],
      ),
    ).toThrow(
      "a.md: tickets_id 43 names no listing on the site; restore the listing or delete the stamp from the file",
    );
  });

  test("refuses a stamp that names another product's listing", () => {
    expect(() =>
      resolveImportPlan(
        { filename: "a.md", id: 42, title: "Batak Lite" },
        [],
        false,
        [{ id: 42, name: "Giant Jenga Hire" }],
      ),
    ).toThrow(
      "a.md: tickets_id 42 names listing 'Giant Jenga Hire', not 'Batak Lite'; delete the stamp from the file or rename one and rerun",
    );
  });

  test("refuses to stamp a file that changed since the read", () => {
    // The stamp is written from the snapshot every decision read: the write
    // would discard the editor's newer content.
    expect(() =>
      refuseChangedFile("cat/src/products/a.md", "old text", "new text", 42),
    ).toThrow(
      "cat/src/products/a.md changed while the import ran; the listing holds id 42. Add the tickets_id and tickets_slug lines to the file by hand, or rerun with --update to stamp it",
    );
    expect(() =>
      refuseChangedFile("cat/src/products/a.md", "same", "same", 42),
    ).not.toThrow();
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

  test("refuses a product title a group already holds", () => {
    // The server keeps one namespace for listings and groups, so the create
    // would fail after the import had already written attributes and groups.
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(() =>
      ensureNamespaceFree(
        [product],
        [],
        [],
        [{ id: 7, name: "8 lane reindeer racing hire" }],
      ),
    ).toThrow(
      "a group named '8 lane reindeer racing hire' already exists (id 7); a listing cannot take a group's name, so rename one and rerun",
    );
  });

  test("refuses a product title a category of the same catalog holds", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(() =>
      ensureNamespaceFree(
        [product],
        [{ name: "8 LANE reindeer racing hire", slug: "christmas" }],
        [],
        [],
      ),
    ).toThrow(
      "the product '8 Lane Reindeer Racing Hire' and the category '8 LANE reindeer racing hire' share a name; rename one and rerun",
    );
  });

  test("refuses a category name a listing already holds", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(() =>
      ensureNamespaceFree(
        [product],
        [{ name: "Christmas Game Hire", slug: "christmas-game-hire" }],
        [{ id: 9, name: "  christmas game hire " }],
        [],
      ),
    ).toThrow(
      "a listing named '  christmas game hire ' already exists (id 9); a group cannot take a listing's name, so rename one and rerun",
    );
  });

  test("refuses two categories under one folded name", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(() =>
      ensureNamespaceFree(
        [product],
        [
          { name: "Fun Days", slug: "fun-days" },
          { name: "  fun days ", slug: "christmas-game-hire" },
        ],
        [],
        [],
      ),
    ).toThrow(
      "the categories 'fun-days' and 'christmas-game-hire' are both named '  fun days '; rename one and rerun",
    );
  });

  test("leaves the plan's own name matches to the plan", () => {
    // A title matching an existing listing is the plan's conflict path, and
    // a category matching a group is the reuse path: neither is a refusal.
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(() =>
      ensureNamespaceFree(
        [product],
        [{ name: "Christmas Game Hire", slug: "christmas-game-hire" }],
        [{ id: 9, name: "8 Lane Reindeer Racing Hire" }],
        [{ id: 5, name: "christmas game hire" }],
      ),
    ).not.toThrow();
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
      max_attendees: 10,
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
    // The site caps a daily listing's bookable quantity per date by
    // max_attendees, so the capacity follows the strictest option too.
    const body = listingBody(product, [], []);
    expect(body.max_quantity).toBe(2);
    expect(body.max_attendees).toBe(2);
  });
});
