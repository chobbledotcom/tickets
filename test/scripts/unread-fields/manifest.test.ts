import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  manifestReader,
  ownerPathSchema,
} from "#scripts/unread-fields/manifest.ts";

const read = manifestReader(
  "sample",
  "sample entry",
  v.strictObject({ path: ownerPathSchema("sample entry") }),
  (exportedFrom, { path }) => [{ exportedFrom, path }],
);

const entry = { path: [{ name: "Body" }] };

describe("unread-field manifest reader", () => {
  test("hands each entry over beside the file that exports its owner", () => {
    expect(
      read({
        "src/shared/api.ts": [entry, { path: [{ name: "Reply" }] }],
        "src/shared/sum.ts": [{ path: [{ name: "Sum" }, { way: "[]" }] }],
      }),
    ).toEqual([
      { exportedFrom: "src/shared/api.ts", path: [{ name: "Body" }] },
      { exportedFrom: "src/shared/api.ts", path: [{ name: "Reply" }] },
      {
        exportedFrom: "src/shared/sum.ts",
        path: [{ name: "Sum" }, { way: "[]" }],
      },
    ]);
  });

  test("keeps a way step apart from a name it shares", () => {
    expect(
      read({
        "src/shared/api.ts": [{ path: [{ way: "[]" }, { name: "[]" }] }],
      }),
    ).toEqual([
      {
        exportedFrom: "src/shared/api.ts",
        path: [{ way: "[]" }, { name: "[]" }],
      },
    ]);
  });

  test("names the manifest and lists each issue at its own place", () => {
    expect(() =>
      read({ "./src/shared/api.ts": [entry], "src/shared/sum.ts": [] }),
    ).toThrow(
      [
        "The unread-field sample manifest is not valid:",
        "  ./src/shared/api.ts: A sample file must be a path under src/",
        "  src/shared/sum.ts: A file must name at least one sample entry",
      ].join("\n"),
    );
  });

  test("refuses a manifest that is not an object", () => {
    expect(() => read(null)).toThrow(
      "  the top of the manifest: Invalid type: Expected Object but received null",
    );
  });

  test("refuses a step that carries a name and a way at once", () => {
    expect(() =>
      read({ "src/shared/api.ts": [{ path: [{ name: "Body", way: "[]" }] }] }),
    ).toThrow(
      "src/shared/api.ts / 0 / path / 0: A step must name a field or the way a reader reaches through it",
    );
  });

  test("refuses an entry with no owner path step", () => {
    expect(() => read({ "src/shared/api.ts": [{ path: [] }] })).toThrow(
      "src/shared/api.ts / 0 / path: A sample entry must name at least one owner path step",
    );
  });
});
