import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseProductFile } from "#cli/product-catalog/parse.ts";
import { ensureUniqueTitles, readProducts } from "#cli/product-catalog.ts";

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
