import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attributeVocabulary,
  categoryTitle,
  composeDescription,
  conflictLine,
  listingBody,
  minorUnits,
  parseImportFlags,
  parseProductFile,
  planLine,
  readProducts,
  resolveImportPlan,
  resolveOptionIds,
  storedTicketsId,
  withTicketsMeta,
} from "#cli/product-catalog.ts";
import { withTempDir } from "#test-utils/files.ts";

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

describe("product catalog", () => {
  test("parses a product file's frontmatter", () => {
    const product = parseProductFile(
      "8-lane-reindeer-racing.md",
      productFrontmatter,
    );
    expect(product).toEqual({
      categories: ["christmas-game-hire", "fun-days"],
      features: ["Public liability insurance included"],
      filename: "8-lane-reindeer-racing",
      filterAttributes: [
        { name: "Guest Capacity", value: "50-500+ guests" },
        { name: "Power Required", value: "Mains power required" },
        // The alias folds the stray spelling onto the site's main name.
        { name: "Power Required", value: "TBC" },
      ],
      options: [
        { days: 1, max_quantity: 10, name: "1 Day", unit_price: 1695 },
        { days: 7, max_quantity: 10, name: "7 Days", unit_price: 3995 },
      ],
      order: 73,
      specs: [
        { name: "Players", value: "Up to 8 players" },
        { name: "Power", value: "2 x Power Socket" },
      ],
      subtitle: "Festive roll-and-bowl racing for up to 8 players",
      title: "8 Lane Reindeer Racing Hire",
    });
  });

  test("ignores non-markdown and non-product files", () => {
    expect(parseProductFile("products.json", "{}")).toBeNull();
    expect(parseProductFile("empty.md", "no frontmatter")).toBeNull();
    expect(parseProductFile("untitled.md", '---\ntitle: ""\n---\n')).toBeNull();
  });

  test("fills the option defaults for a bare option", () => {
    const product = parseProductFile(
      "a.md",
      "---\ntitle: Batak Lite\noptions:\n  - name: 1 Day\n---\n",
    )!;
    expect(product.options).toEqual([
      { days: 1, max_quantity: 10, name: "1 Day", unit_price: 0 },
    ]);
    expect(product.order).toBe(0);
  });

  test("reads nothing for scalar list fields and drops blank entries", () => {
    const product = parseProductFile(
      "a.md",
      [
        "---",
        "title: Batak Lite",
        "subtitle: 5",
        "categories: categories/fun-days.md",
        "features:",
        '  - ""',
        "  - Public liability insurance included",
        "specs: 3",
        "filter_attributes: hello",
        "options:",
        "  - name: 1 Day",
        "---",
      ].join("\n"),
    )!;
    expect(product.subtitle).toBe("");
    expect(product.categories).toEqual([]);
    expect(product.features).toEqual(["Public liability insurance included"]);
    expect(product.specs).toEqual([]);
    expect(product.filterAttributes).toEqual([]);
  });

  test("reads every product file in site order", async () => {
    const dir = await Deno.makeTempDir();
    const withOption = (front: string): string =>
      `---\n${front}\noptions:\n  - name: 1 Day\n---\n`;
    try {
      await Deno.mkdir(`${dir}/sub`);
      await Deno.writeTextFile(
        `${dir}/z.md`,
        withOption("title: Zipline\norder: 2"),
      );
      await Deno.writeTextFile(
        `${dir}/a.md`,
        withOption("title: Air Hockey\norder: 2"),
      );
      await Deno.writeTextFile(
        `${dir}/m.md`,
        withOption("title: Midway\norder: 1"),
      );
      await Deno.writeTextFile(`${dir}/notes.json`, "{}");
      await Deno.writeTextFile(`${dir}/empty.md`, "no frontmatter");
      const products = await readProducts(dir);
      expect(products.map((product) => product.filename)).toEqual([
        "m",
        "a",
        "z",
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
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
    expect(resolveImportPlan(42, undefined, false)).toEqual({
      action: "skip-imported",
    });
    expect(resolveImportPlan(null, undefined, false)).toEqual({
      action: "create",
    });
    expect(resolveImportPlan(null, 7, false)).toEqual({
      action: "skip-conflict",
      listingId: 7,
    });
    expect(resolveImportPlan(null, 7, true)).toEqual({
      action: "update",
      listingId: 7,
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
  });

  test("prints a real-run conflict line that names the way out", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    expect(conflictLine(product, 7, false)).toBe(
      "skipped listing 8 Lane Reindeer Racing Hire: the name matches " +
        "listing 7; rerun with --update to overwrite it\n",
    );
  });

  test("reads a stored tickets id, or null for a placeholder", () => {
    expect(storedTicketsId("---\ntickets_id: 42\n---\n")).toBe(42);
    expect(storedTicketsId("---\ntickets_id:\n---\n")).toBeNull();
    expect(storedTicketsId("---\ntitle: Batak Lite\n---\n")).toBeNull();
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
      expect(await categoryTitle(dir, "missing")).toBe("missing");
    });
  });

  test("stops when a category file exists but cannot be read", async () => {
    await withTempDir(async (dir) => {
      await Deno.writeTextFile(
        `${dir}/broken.md`,
        "---\ntitle: [unclosed\n---\n",
      );
      await expect(categoryTitle(dir, "broken")).rejects.toThrow();
      // A slug that names a directory is a read error, not a missing file.
      await Deno.mkdir(`${dir}/subdir.md`);
      await expect(categoryTitle(dir, "subdir")).rejects.toThrow();
    });
  });
});
