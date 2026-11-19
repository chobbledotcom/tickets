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

/** Parse a minimal listing with the fields under test added. */
const parseListing = (extra: Record<string, unknown>) =>
  v.safeParse(ListingDataSchema, { maxAttendees: 1, name: "Thing", ...extra });

/** Assert a parse failed and its formatted issues carry the fragment. */
const expectIssueMessage = <T extends v.GenericSchema>(
  result: v.SafeParseResult<T>,
  fragment: string,
): void => {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(formatTransferIssues(result.issues)).toContain(fragment);
  }
};

/** Parse a minimal listing whose `fields` is the value under test. */
const parseFields = (fields: string) => parseListing({ fields });

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
  const parseDate = (date: string) => parseListing({ date });

  /** Each group of dates the schema accepts or refuses, named by the label. */
  const dateCases: { label: string; dates: string[]; accepted: boolean }[] = [
    { accepted: true, dates: [""], label: "accepts an empty value" },
    {
      accepted: true,
      dates: ["2026-06-05T10:30Z", "2026-06-05T10:30:00.123Z"],
      label: "accepts a UTC instant",
    },
    {
      accepted: false,
      dates: [
        "2026-06-05T10:30",
        "2026-06-05T10:30:15",
        "2026-06-05T10:30:00+02:30",
        "2026-06-05T10:30:00-05:00",
      ],
      label:
        "refuses a naive datetime or an offset instant: a transfer names UTC times",
    },
    {
      accepted: false,
      dates: ["2026-02-30T10:30Z", "2025-13-01T10:30Z", "2026-00-10T10:30Z"],
      label: "rejects impossible calendar dates",
    },
    {
      accepted: false,
      dates: ["2026-06-05T24:00Z", "2026-06-05T10:60Z", "2026-06-05T10:30:60Z"],
      label: "rejects out-of-range time parts",
    },
    {
      accepted: false,
      dates: [
        "2026-06-05T10:30not-a-zone",
        "2026-06-05",
        "2026-06-05T10:30.123",
        "garbage",
      ],
      label:
        "rejects trailing junk, date-only values, and bare fractional seconds",
    },
  ];

  for (const { accepted, dates, label } of dateCases) {
    test(label, () => {
      expect(dates.map((date) => parseDate(date).success)).toEqual(
        dates.map(() => accepted),
      );
    });
  }

  test("keeps a year below 100 as written", () => {
    const result = parseDate("0099-06-05T10:30Z");
    expect(result.success && result.output.date).toBe("0099-06-05T10:30Z");
  });

  test("names the datetime error in the issue message", () => {
    expectIssueMessage(
      parseDate("garbage"),
      "must be a UTC instant of a real calendar day",
    );
  });
});

describe("ListingDataSchema day prices", () => {
  const parseDayPrices = (
    dayPrices: Record<string, number>,
    durationDays?: number,
  ) => parseListing({ dayPrices, durationDays });

  test("refuses a price above the listing's own duration", () => {
    const result = parseDayPrices({ 1: 100, 2: 200, 5: 500 }, 2);
    expectIssueMessage(
      result,
      "dayPrices holds a price for a day the listing does not last",
    );
  });

  test("refuses a price above the one-day duration a listing takes when it gives none", () => {
    expectIssueMessage(
      parseDayPrices({ 1: 100, 2: 200 }),
      "dayPrices holds a price for a day the listing does not last",
    );
  });

  test("keeps a price for a day the listing lasts", () => {
    const result = parseDayPrices({ 1: 100, 2: 200 }, 2);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.dayPrices).toEqual({ 1: 100, 2: 200 });
    }
  });

  test("passes a listing without day prices through unchanged", () => {
    const result = parseListing({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect("dayPrices" in result.output).toBe(false);
    }
  });

  test("rejects a non-numeric day-count key", () => {
    expectIssueMessage(
      parseDayPrices({ weekday: 100 }),
      "day count must be a positive whole number",
    );
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
    expectIssueMessage(
      parseDayPrices({ 91: 100 }),
      `day count must be between 1 and ${MAX_DURATION_DAYS}`,
    );
  });

  const zeroFields = [
    ["max price", "maxPrice"],
    ["minimum days before", "minimumDaysBefore"],
  ] as const;
  for (const [label, field] of zeroFields) {
    test(`accepts a zero ${label}`, () => {
      const result = parseListing({ [field]: 0 });
      expect(result.success).toBe(true);
      expect(result.success && result.output[field]).toBe(0);
    });
  }

  test("leaves an omitted max price to the column default", () => {
    const result = parseListing({});
    expect(result.success).toBe(true);
    expect(result.success && Object.hasOwn(result.output, "maxPrice")).toBe(
      false,
    );
  });
});

describe("ListingDataSchema duration", () => {
  test("accepts a duration within the bookable range", () => {
    for (const durationDays of [1, MAX_DURATION_DAYS]) {
      expect(parseListing({ durationDays }).success).toBe(true);
    }
  });

  test("rejects a zero duration", () => {
    expect(parseListing({ durationDays: 0 }).success).toBe(false);
  });

  test("rejects a duration beyond the cap with a message", () => {
    expectIssueMessage(
      parseListing({ durationDays: MAX_DURATION_DAYS + 1 }),
      `must be at most ${MAX_DURATION_DAYS} days`,
    );
  });
});

describe("ListingTransferSchema version", () => {
  /** Parse a minimal listing export written at the given version. */
  const parseVersion = (version: number) =>
    v.safeParse(ListingTransferSchema, {
      kind: "listing",
      listing: { maxAttendees: 1, name: "Thing" },
      version,
    });

  test("accepts the current version", () => {
    expect(parseVersion(CATALOG_TRANSFER_VERSION).success).toBe(true);
  });

  test("accepts a blob written at version 1", () => {
    // The version is a wire contract with saved files: pin its literal, so a
    // changed constant cannot pass its own self-referential check.
    expect(parseVersion(1).success).toBe(true);
  });

  test("rejects another version with an intelligible message", () => {
    expectIssueMessage(
      parseVersion(CATALOG_TRANSFER_VERSION + 1),
      `Unsupported export version (expected ${CATALOG_TRANSFER_VERSION})`,
    );
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
