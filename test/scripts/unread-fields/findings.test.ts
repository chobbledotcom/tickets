import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type Finding,
  reportLines,
  verdictFor,
  worthReporting,
} from "#scripts/unread-fields/findings.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({
  field: "total",
  file: "src/a.ts",
  owner: "Sum",
  verdict: "never read",
  ...over,
});

describe("verdictFor", () => {
  test("calls a field with no readers never read", () => {
    expect(verdictFor([])).toBe("never read");
  });

  test("calls a field only its tests read exactly that", () => {
    expect(verdictFor(["test/a.test.ts", "test/b.test.ts"])).toBe(
      "read only by tests",
    );
  });

  test("calls a field one shipped reader reads read", () => {
    expect(verdictFor(["test/a.test.ts", "scripts/b.ts"])).toBe("read");
  });
});

describe("worthReporting", () => {
  test("drops the fields production reads", () => {
    expect(worthReporting([finding({ verdict: "read" })])).toEqual([]);
  });

  test("orders by file, then by the field's full name", () => {
    const order = worthReporting([
      finding({ field: "b", file: "src/z.ts" }),
      finding({ field: "b", file: "src/a.ts" }),
      finding({ field: "a", file: "src/a.ts" }),
    ]).map((f) => `${f.file}:${f.field}`);

    expect(order).toEqual(["src/a.ts:a", "src/a.ts:b", "src/z.ts:b"]);
  });
});

describe("reportLines", () => {
  test("says so when every field is read", () => {
    expect(reportLines([finding({ verdict: "read" })])).toEqual([
      "Every exported field of the 1 scanned is read.",
    ]);
  });

  test("counts the two kinds separately in its opening line", () => {
    const [headline] = reportLines([
      finding(),
      finding({ field: "other", verdict: "read only by tests" }),
      finding({ field: "fine", verdict: "read" }),
    ]);

    expect(headline).toBe(
      "2 of 3 exported fields are never read in production:" +
        " 1 read by nothing, 1 read only by tests.",
    );
  });

  test("names each field with its verdict and its file", () => {
    expect(reportLines([finding()]).at(-1)).toBe(
      "  never read          Sum.total  src/a.ts",
    );
  });
});
