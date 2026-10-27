import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  CATALOG_TRANSFER_VERSION,
  formatBundleIssues,
  formatTransferIssues,
  GroupTransferSchema,
  ListingDataSchema,
  ListingTransferSchema,
} from "#routes/admin/catalog-transfer/schema.ts";
import { MAX_DURATION_DAYS } from "#types";

/** Parse a minimal listing whose `fields` is the value under test. */
const parseFields = (fields: string) =>
  v.safeParse(ListingDataSchema, { fields, maxAttendees: 1, name: "Thing" });

describe("ListingDataSchema fields", () => {
  test("trims whitespace around each field name", () => {
    const result = parseFields(" email , phone ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.fields).toBe("email,phone");
  });

  test("drops repeated and trailing commas", () => {
    const result = parseFields("email,,phone,");
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.fields).toBe("email,phone");
  });

  test("accepts an empty fields list", () => {
    const result = parseFields("");
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.fields).toBe("");
  });

  test("rejects an unknown contact field", () => {
    expect(parseFields("email,fax").success).toBe(false);
  });
});

describe("formatBundleIssues", () => {
  /** One issue shaped the way safeParse reports nested object errors. */
  const issueAt = (
    path: (string | number)[],
    message: string,
  ): v.BaseIssue<unknown> =>
    ({ message, path: path.map((key) => ({ key })) }) as v.BaseIssue<unknown>;

  test("names a bundle item by its raw body's name and field", () => {
    const raw = { listings: [{ listing: { name: "Act 0" } }] };
    expect(
      formatBundleIssues(
        [
          issueAt(
            ["listings", 0, "listing", "maxAttendees"],
            "must be at least 1",
          ),
        ],
        raw,
      ),
    ).toBe(
      'Invalid catalog file — "Act 0": listing.maxAttendees: must be at least 1',
    );
  });

  test("reports a group item by its own name", () => {
    expect(
      formatBundleIssues(
        [issueAt(["groups", 0, "group", "maxAttendees"], "oops")],
        { groups: [{ group: { name: "Pack" } }] },
      ),
    ).toBe('Invalid catalog file — "Pack": group.maxAttendees: oops');
  });

  test("falls back to the position when the raw document is not an object", () => {
    expect(
      formatBundleIssues(
        [issueAt(["listings", 0, "listing", "name"], "bad")],
        "nope",
      ),
    ).toBe('Invalid catalog file — "listing 1": listing.name: bad');
  });

  test("falls back to the position when the kind's array is absent", () => {
    expect(
      formatBundleIssues([issueAt(["groups", 0, "group", "name"], "bad")], {
        listings: [],
      }),
    ).toBe('Invalid catalog file — "group 1": group.name: bad');
  });

  test("falls back to the position when the body is not an object", () => {
    expect(
      formatBundleIssues([issueAt(["listings", 0, "listing", "name"], "bad")], {
        listings: [{ listing: "oops" }],
      }),
    ).toBe('Invalid catalog file — "listing 1": listing.name: bad');
  });

  test("falls back to the position when the item is not an object", () => {
    expect(
      formatBundleIssues([issueAt(["listings", 1, "listing", "name"], "bad")], {
        listings: [null, 7],
      }),
    ).toBe('Invalid catalog file — "listing 2": listing.name: bad');
  });

  test("falls back to the position when the body holds no usable name", () => {
    expect(
      formatBundleIssues([issueAt(["listings", 0, "listing", "name"], "bad")], {
        listings: [{ listing: { name: "   " } }],
      }),
    ).toBe('Invalid catalog file — "listing 1": listing.name: bad');
  });

  test("falls back to the position when the body's name is not a string", () => {
    expect(
      formatBundleIssues([issueAt(["listings", 0, "listing", "name"], "bad")], {
        listings: [{ listing: { name: 42 } }],
      }),
    ).toBe('Invalid catalog file — "listing 1": listing.name: bad');
  });

  test("reports a name-level failure without a field suffix", () => {
    expect(
      formatBundleIssues([issueAt(["listings", 0], "Invalid input")], {
        listings: [{ listing: { name: "Act 0" } }],
      }),
    ).toBe('Invalid catalog file — "Act 0": Invalid input');
  });

  test("passes a non-item issue through unchanged and drops duplicates", () => {
    expect(
      formatBundleIssues(
        [
          issueAt(["kind"], "Invalid input"),
          issueAt(["kind"], "Invalid input"),
        ],
        {},
      ),
    ).toBe("Invalid catalog file — Invalid input");
  });
});

describe("ListingDataSchema datetime", () => {
  const parseDate = (date: string) =>
    v.safeParse(ListingDataSchema, { date, maxAttendees: 1, name: "Thing" });

  test("accepts an empty value", () => {
    expect(parseDate("").success).toBe(true);
  });

  test("accepts a naive datetime with or without seconds", () => {
    for (const date of [
      "2026-06-05T10:30",
      "2026-06-05T10:30:00",
      "2026-06-05T10:30:15",
    ]) {
      expect(parseDate(date).success).toBe(true);
    }
  });

  test("accepts a UTC or offset instant", () => {
    for (const date of [
      "2026-06-05T10:30Z",
      "2026-06-05T10:30:00.123Z",
      "2026-06-05T10:30:00+02:30",
      "2026-06-05T10:30:00-05:00",
    ]) {
      expect(parseDate(date).success).toBe(true);
    }
  });

  test("rejects impossible calendar dates", () => {
    for (const date of [
      "2026-02-30T10:30",
      "2025-13-01T10:30",
      "2026-00-10T10:30",
    ]) {
      expect(parseDate(date).success).toBe(false);
    }
  });

  test("rejects a year below 100", () => {
    // Date.UTC maps the years 0 to 99 onto 1900 to 1999. The rolled date keeps
    // its month and day, so only the year comparison rejects these.
    for (const date of ["0000-01-01T00:00", "0099-06-05T10:30"]) {
      expect(parseDate(date).success).toBe(false);
    }
  });

  test("rejects out-of-range time parts", () => {
    for (const date of [
      "2026-06-05T24:00",
      "2026-06-05T10:60",
      "2026-06-05T10:30:60",
    ]) {
      expect(parseDate(date).success).toBe(false);
    }
  });

  test("rejects an out-of-range UTC offset", () => {
    for (const date of [
      "2026-06-05T10:30+24:00",
      "2026-06-05T10:30+99:99",
      "2026-06-05T10:30-23:61",
    ]) {
      expect(parseDate(date).success).toBe(false);
    }
  });

  test("rejects trailing junk, date-only values, and bare fractional seconds", () => {
    for (const date of [
      "2026-06-05T10:30not-a-zone",
      "2026-06-05",
      "2026-06-05T10:30.123",
      "garbage",
    ]) {
      expect(parseDate(date).success).toBe(false);
    }
  });

  test("names the datetime error in the issue message", () => {
    const result = parseDate("garbage");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatTransferIssues(result.issues)).toContain(
        "must be a valid datetime",
      );
    }
  });
});

describe("ListingDataSchema day prices", () => {
  const parseDayPrices = (
    dayPrices: Record<string, number>,
    durationDays?: number,
  ) =>
    v.safeParse(ListingDataSchema, {
      dayPrices,
      durationDays,
      maxAttendees: 1,
      name: "Thing",
    });

  test("drops keys beyond the listing's own duration", () => {
    const result = parseDayPrices({ 1: 100, 2: 200, 5: 500 }, 2);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.dayPrices).toEqual({ 1: 100, 2: 200 });
    }
  });

  test("keeps only the first day price when the duration is absent", () => {
    const result = parseDayPrices({ 1: 100, 2: 200 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.dayPrices).toEqual({ 1: 100 });
    }
  });

  test("passes a listing without day prices through unchanged", () => {
    const result = v.safeParse(ListingDataSchema, {
      maxAttendees: 1,
      name: "Thing",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("dayPrices" in result.output).toBe(false);
    }
  });

  test("rejects a non-numeric day-count key", () => {
    const result = parseDayPrices({ weekday: 100 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatTransferIssues(result.issues)).toContain(
        "day count must be a positive whole number",
      );
    }
  });

  test("joins a field's repeated messages with a semicolon", () => {
    const result = parseDayPrices({ weekday: 100 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatTransferIssues(result.issues)).toBe(
        "Invalid catalog file — dayPrices.weekday: " +
          "day count must be a positive whole number; " +
          `day count must be between 1 and ${MAX_DURATION_DAYS}`,
      );
    }
  });

  test("rejects a zero day-count key", () => {
    expect(parseDayPrices({ 0: 100 }).success).toBe(false);
  });

  test("rejects a day-count key beyond the bookable range", () => {
    const result = parseDayPrices({ 91: 100 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatTransferIssues(result.issues)).toContain(
        `day count must be between 1 and ${MAX_DURATION_DAYS}`,
      );
    }
  });

  test("accepts a zero max price", () => {
    const result = v.safeParse(ListingDataSchema, {
      maxAttendees: 1,
      maxPrice: 0,
      name: "Thing",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.maxPrice).toBe(0);
  });

  test("accepts a zero minimum days before", () => {
    const result = v.safeParse(ListingDataSchema, {
      maxAttendees: 1,
      minimumDaysBefore: 0,
      name: "Thing",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.minimumDaysBefore).toBe(0);
  });

  test("defaults an omitted max price to zero", () => {
    const result = v.safeParse(ListingDataSchema, {
      maxAttendees: 1,
      name: "Thing",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.output.maxPrice).toBe(0);
  });
});

describe("ListingDataSchema duration", () => {
  test("accepts a duration within the bookable range", () => {
    for (const durationDays of [1, MAX_DURATION_DAYS]) {
      const result = v.safeParse(ListingDataSchema, {
        durationDays,
        maxAttendees: 1,
        name: "Thing",
      });
      expect(result.success).toBe(true);
    }
  });

  test("rejects a zero duration", () => {
    const result = v.safeParse(ListingDataSchema, {
      durationDays: 0,
      maxAttendees: 1,
      name: "Thing",
    });
    expect(result.success).toBe(false);
  });

  test("rejects a duration beyond the cap with a message", () => {
    const result = v.safeParse(ListingDataSchema, {
      durationDays: MAX_DURATION_DAYS + 1,
      maxAttendees: 1,
      name: "Thing",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatTransferIssues(result.issues)).toContain(
        `must be at most ${MAX_DURATION_DAYS} days`,
      );
    }
  });
});

describe("ListingTransferSchema version", () => {
  test("accepts the current version", () => {
    const result = v.safeParse(ListingTransferSchema, {
      kind: "listing",
      listing: { maxAttendees: 1, name: "Thing" },
      version: CATALOG_TRANSFER_VERSION,
    });
    expect(result.success).toBe(true);
  });

  test("accepts a blob written at version 1", () => {
    // The version is a wire contract with saved files: pin its literal, so a
    // changed constant cannot pass its own self-referential check.
    const result = v.safeParse(ListingTransferSchema, {
      kind: "listing",
      listing: { maxAttendees: 1, name: "Thing" },
      version: 1,
    });
    expect(result.success).toBe(true);
  });

  test("rejects another version with an intelligible message", () => {
    const result = v.safeParse(ListingTransferSchema, {
      kind: "listing",
      listing: { maxAttendees: 1, name: "Thing" },
      version: CATALOG_TRANSFER_VERSION + 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatTransferIssues(result.issues)).toContain(
        `Unsupported export version (expected ${CATALOG_TRANSFER_VERSION})`,
      );
    }
  });
});

describe("GroupTransferSchema", () => {
  test("accepts a group export with its members", () => {
    const result = v.safeParse(GroupTransferSchema, {
      group: { maxAttendees: 1, name: "Fans" },
      kind: "group",
      members: [{ listing: "Gig", quantity: 2 }],
      version: CATALOG_TRANSFER_VERSION,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.group.name).toBe("Fans");
      expect(result.output.members).toEqual([{ listing: "Gig", quantity: 2 }]);
    }
  });
});

describe("formatTransferIssues", () => {
  test("joins the named fields with a semicolon", () => {
    const result = v.safeParse(ListingTransferSchema, {
      kind: "listing",
      listing: { maxAttendees: 0, name: "" },
      version: CATALOG_TRANSFER_VERSION + 1,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = formatTransferIssues(result.issues);
    expect(message.startsWith("Invalid catalog file — ")).toBe(true);
    expect(message).toContain("; listing.name: ");
    expect(message).toContain("listing.maxAttendees");
    expect(message).toContain("version");
  });
});
