import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ensureUniqueTitles,
  parseProductFile,
  readProducts,
} from "#cli/product-catalog.ts";

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
      "---\ntitle: Batak Lite\noptions:\n  - name: 1 Day\n    unit_price: 100\n---\n",
    )!;
    expect(product.options).toEqual([
      { days: 1, max_quantity: 10, name: "1 Day", unit_price: 100 },
    ]);
    expect(product.order).toBe(0);
  });

  test("reads a numeric order, or sorts first without one", () => {
    const product = parseProductFile(
      "a.md",
      "---\ntitle: Batak Lite\norder: 73\noptions:\n  - name: 1 Day\n    unit_price: 100\n---\n",
    )!;
    expect(product.order).toBe(73);
  });

  test("rejects a non-numeric order", () => {
    // A NaN order would sort the product nowhere on the site.
    expect(() =>
      parseProductFile(
        "a.md",
        "---\ntitle: Batak Lite\norder: soon\noptions:\n  - name: 1 Day\n    unit_price: 100\n---\n",
      ),
    ).toThrow("a.md: order is not a number");
  });
  test("needs a price on every rental option", () => {
    // A price is money: a missing one must not quietly read as free.
    expect(() =>
      parseProductFile(
        "a.md",
        "---\ntitle: Batak Lite\noptions:\n  - name: 1 Day\n---\n",
      ),
    ).toThrow("a.md: option '1 Day' needs a unit_price");
  });

  test("rejects a non-numeric option field", () => {
    expect(() =>
      parseProductFile(
        "a.md",
        "---\ntitle: Batak Lite\noptions:\n  - name: 1 Day\n    unit_price: free\n---\n",
      ),
    ).toThrow("a.md: option '1 Day' has a non-numeric unit_price");
    // Booleans read as numbers through Number(); reject them outright.
    expect(() =>
      parseProductFile(
        "a.md",
        "---\ntitle: Batak Lite\noptions:\n  - name: 1 Day\n    days: true\n    unit_price: 100\n---\n",
      ),
    ).toThrow("a.md: option '1 Day' has a non-numeric days");
  });

  test("rejects option day counts and quantities below one", () => {
    // A zero or negative day count or quantity would book nonsense.
    for (const field of ["days", "max_quantity"]) {
      for (const value of ["0", "-1", "1.5"]) {
        expect(() =>
          parseProductFile(
            "a.md",
            `---\ntitle: Batak Lite\noptions:\n  - name: 1 Day\n    unit_price: 100\n    ${field}: ${value}\n---\n`,
          ),
        ).toThrow(
          `a.md: option '1 Day' has a ${field} that is not a positive whole number`,
        );
      }
    }
  });

  test("rejects a rental period above the application maximum", () => {
    // The application clamps bookings to 90 days and drops day prices past
    // it, so a longer option would import half-lost.
    expect(() =>
      parseProductFile(
        "a.md",
        "---\ntitle: Batak Lite\noptions:\n  - name: 1 Day\n    unit_price: 100\n    days: 91\n---\n",
      ),
    ).toThrow("a.md: option '1 Day' books 91 days, above the maximum of 90");
  });

  test("rejects a negative option price", () => {
    expect(() =>
      parseProductFile(
        "a.md",
        "---\ntitle: Batak Lite\noptions:\n  - name: 1 Day\n    unit_price: -5\n---\n",
      ),
    ).toThrow("a.md: option '1 Day' has a negative unit_price");
  });

  test("rejects option, spec, and filter entries that are not records", () => {
    // A scalar or null entry is malformed external data: it must stop the
    // import naming the file and the field, not read as an absent entry.
    for (const [field, malformed] of [
      ["options", "  - 1 Day"],
      ["options", "  -"],
      ["specs", "  - just text"],
      ["filter_attributes", "  - 7"],
    ] as const) {
      expect(() =>
        parseProductFile(
          "a.md",
          [
            "---",
            "title: Batak Lite",
            "options:",
            "  - name: 1 Day",
            "    unit_price: 100",
            ...(field === "options" ? [malformed] : [`${field}:`, malformed]),
            "---",
          ].join("\n"),
        ),
      ).toThrow(
        `a.md: ${field} holds an entry that is not a name/value record`,
      );
    }
  });

  test("rejects a filter attribute with a name but no value", () => {
    // A misspelled field (`values:`) must not read as no selection: the
    // import would lose the attribute quietly.
    expect(() =>
      parseProductFile(
        "a.md",
        [
          "---",
          "title: Batak Lite",
          "options:",
          "  - name: 1 Day",
          "    unit_price: 100",
          "filter_attributes:",
          "  - name: Guest Capacity",
          "    values: 50-500+ guests",
          "---",
        ].join("\n"),
      ),
    ).toThrow("a.md: a filter attribute needs both a name and a value");
  });

  test("names the file when the frontmatter does not parse", () => {
    expect(() =>
      parseProductFile("a.md", "---\ntitle: [unclosed\n---\n"),
    ).toThrow("a.md: unparseable frontmatter:");
    // Empty frontmatter holds no product, and parsing it must not crash.
    expect(parseProductFile("a.md", "---\n---\n")).toBeNull();
  });

  test("rejects two options that book the same day count", () => {
    expect(() =>
      parseProductFile(
        "a.md",
        [
          "---",
          "title: Batak Lite",
          "options:",
          "  - name: 1 Day",
          "    unit_price: 100",
          "  - name: One Day",
          "    unit_price: 120",
          "---",
        ].join("\n"),
      ),
    ).toThrow("a.md: two options book 1 day(s)");
  });

  test("reads a CRLF product file like a Unix one", () => {
    const product = parseProductFile(
      "a.md",
      "---\r\ntitle: Batak Lite\r\noptions:\r\n  - name: 1 Day\r\n    unit_price: 100\r\n---\r\n",
    )!;
    expect(product.title).toBe("Batak Lite");
    expect(product.options).toEqual([
      { days: 1, max_quantity: 10, name: "1 Day", unit_price: 100 },
    ]);
  });

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
        "    unit_price: 100",
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
