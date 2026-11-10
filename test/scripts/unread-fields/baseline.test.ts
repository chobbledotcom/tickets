import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  parseBaseline,
  UNREAD_FIELD_BASELINE,
} from "#scripts/unread-fields/baseline.ts";
import {
  expectStableUniqueIdentities,
  testRefusedEntries,
} from "#test-utils/unread-field-policy.ts";

const debt = { fields: ["total"], path: [{ name: "Sum" }] };

describe("unread-field baseline", () => {
  test("holds exact current debt in stable order", () => {
    expectStableUniqueIdentities(UNREAD_FIELD_BASELINE);
  });

  test("names only exported production files", () => {
    expect(
      UNREAD_FIELD_BASELINE.every(({ exportedFrom }) =>
        exportedFrom.startsWith("src/"),
      ),
    ).toBe(true);
  });
});

describe("unread-field baseline manifest", () => {
  test("reads one exact identity for each field of each owner", () => {
    expect(
      parseBaseline({
        "src/sum.ts": [
          { fields: ["total", "other"], path: [{ name: "Sum" }] },
          { fields: ["id"], path: [{ name: "Rows" }, { way: "[]" }] },
        ],
      }),
    ).toEqual([
      {
        exportedFrom: "src/sum.ts",
        field: "id",
        path: [{ name: "Rows" }, { way: "[]" }],
      },
      { exportedFrom: "src/sum.ts", field: "other", path: [{ name: "Sum" }] },
      { exportedFrom: "src/sum.ts", field: "total", path: [{ name: "Sum" }] },
    ]);
  });

  test("puts the identities in the stable order, whatever the manifest order", () => {
    expectStableUniqueIdentities(
      parseBaseline({
        "src/other.ts": [{ fields: ["b", "a"], path: [{ name: "Other" }] }],
        "src/sum.ts": [debt],
      }),
    );
  });

  // A debt entry the gate cannot read back is an error at its own place.
  testRefusedEntries(parseBaseline, debt, [
    [
      "a debt entry with no owner path step",
      { path: [] },
      "path: A debt entry must name at least one owner path step",
    ],
    [
      "a debt entry with no field",
      { fields: [] },
      "fields: A debt entry must name at least one field",
    ],
    [
      "a reason, which belongs to an exemption rule",
      { evidence: "a reader" },
      'evidence: Invalid key: Expected never but received "evidence"',
    ],
  ]);
});
