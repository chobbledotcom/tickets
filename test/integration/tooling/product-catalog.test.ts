import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type CatalogProduct,
  parseProductFile,
} from "#cli/product-catalog/parse.ts";
import {
  attributeVocabulary,
  categoryTitle,
  ensureConsistentAttributeSpellings,
  ensureUniqueTitles,
  readCategoryEntries,
  readProducts,
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

/** One product file whose single filter attribute carries one name and
 *  value. */
const productWithAttribute = (
  filename: string,
  name: string,
  value: string,
): CatalogProduct =>
  parseProductFile(
    filename,
    `---\ntitle: Product ${filename}\noptions:\n  - name: 1 Day\n    unit_price: 100\nfilter_attributes:\n  - name: ${name}\n    value: ${value}\n---\n`,
  )!;

describe("product catalog", () => {
  test("refuses a catalog whose files share a title", () => {
    const first = parseProductFile("a.md", productFrontmatter)!;
    const second = parseProductFile("b.md", productFrontmatter)!;
    expect(() => ensureUniqueTitles([first, second])).toThrow(
      "duplicate product title '8 Lane Reindeer Racing Hire' in a and b",
    );
    expect(() => ensureUniqueTitles([first])).not.toThrow();
  });

  test("folds case and whitespace when checking duplicate titles", () => {
    // The server's name registry treats these as one name, so two files that
    // differ only by case would fight over the same create.
    const first = parseProductFile("a.md", productFrontmatter)!;
    const second = parseProductFile(
      "b.md",
      productFrontmatter.replace(
        "title: 8 Lane Reindeer Racing Hire",
        "title:   8 LANE reindeer racing hire  ",
      ),
    )!;
    expect(() => ensureUniqueTitles([first, second])).toThrow(
      "duplicate product title '8 LANE reindeer racing hire' in a and b",
    );
  });

  test("refuses two spellings of one attribute name", () => {
    // The site folds case and trims names, so both spellings are one
    // attribute: the second create would be a duplicate that the next
    // import cannot match.
    const first = productWithAttribute("a.md", "Colour", "Red");
    const second = productWithAttribute("b.md", "colour", "Blue");
    expect(() => ensureConsistentAttributeSpellings([first, second])).toThrow(
      "attribute 'Colour' and 'colour' are one attribute to the site (a and b); use one spelling and rerun",
    );
  });

  test("refuses two spellings of one option text", () => {
    const first = productWithAttribute("a.md", "Colour", "Red");
    const second = productWithAttribute("b.md", "Colour", "red");
    expect(() => ensureConsistentAttributeSpellings([first, second])).toThrow(
      "attribute 'Colour' holds options 'Red' and 'red' (a and b); they are one option to the site; use one spelling and rerun",
    );
  });

  test("allows one spelling used across products", () => {
    const first = productWithAttribute("a.md", "Colour", "Red");
    const second = productWithAttribute("b.md", "Colour", "Red");
    expect(() =>
      ensureConsistentAttributeSpellings([first, second]),
    ).not.toThrow();
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
      // A file whose frontmatter holds no mapping (empty, or a scalar) has
      // no title either.
      await Deno.writeTextFile(`${dir}/bare.md`, "---\n---\n");
      await Deno.writeTextFile(`${dir}/scalar.md`, "---\n5\n---\n");
      expect(await categoryTitle(dir, "bare")).toBe("bare");
      expect(await categoryTitle(dir, "scalar")).toBe("scalar");
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

  test("reads every product file in site order", async () => {
    const dir = await Deno.makeTempDir();
    const withOption = (front: string): string =>
      `---\n${front}\noptions:\n  - name: 1 Day\n    unit_price: 100\n---\n`;
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
      const files = await readProducts(dir);
      expect(files.map(({ product }) => product.filename)).toEqual([
        "m",
        "a",
        "z",
      ]);
      // Each file carries the exact text it was parsed from.
      expect(files[0]!.text).toContain("options:");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
