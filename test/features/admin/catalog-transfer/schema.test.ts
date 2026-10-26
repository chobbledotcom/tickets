import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  formatBundleIssues,
  ListingDataSchema,
} from "#routes/admin/catalog-transfer/schema.ts";

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
