import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Finding } from "#scripts/unread-fields/findings.ts";
import { scanUnreadFields } from "#scripts/unread-fields/scan.ts";

/**
 * A whole repository, small enough to hold in your head, covering every way a
 * field can be reached. The scan runs over it once and each test reads one
 * verdict out of the answer.
 */
const FIXTURE: Record<string, string> = {
  "deno.json": JSON.stringify({
    imports: { "#jsx/": "./scripts/jsx/", "#shapes": "./src/shapes.ts" },
  }),

  // The JSX runtime lives under scripts/ so its own fields are not findings.
  "scripts/jsx/jsx-runtime.ts": `
export namespace JSX {
  export type Element = { tag: string };
}
export const Fragment = "fragment";
export const jsx = (tag: unknown): JSX.Element => ({ tag: String(tag) });
export const jsxs = jsx;
`,

  "src/badge.tsx": `
import type { JSX } from "#jsx/jsx-runtime.ts";

export type BadgeProps = { label: string; supplied: string };

export const Badge = ({ label }: BadgeProps): JSX.Element => ({ tag: label });

export const badge = <Badge label="hi" supplied="nothing reads this" />;
`,

  "src/consume.ts": `
import { report, sum } from "./produce.ts";

export const shown = String(sum.total) + report.headline;

export const takeDeepOut = (): number => {
  let deep = 0;
  ({ deep } = report.nested);
  return deep;
};

export const takePatternOut = (): number => {
  let takenOutByPattern = 0;
  ({ takenOutByPattern } = sum);
  return takenOutByPattern;
};
`,

  // Every field written, none read: on its own this file proves nothing.
  "src/produce.ts": `
import type { Report, Sum } from "#shapes";

export const sum: Sum = { total: 1, noOneReadsThis: 2, takenOutByPattern: 3 };
export const report: Report = {
  headline: "hi",
  onlyTestsRead: "x",
  nested: { deep: 3 },
};
`,

  "src/shapes.ts": `
export interface Sum {
  total: number;
  noOneReadsThis: number;
  takenOutByPattern: number;
}

export type Report = {
  headline: string;
  onlyTestsRead: string;
  nested: { deep: number };
  [key: string]: unknown;
};

interface NotExported {
  hidden: number;
}

export const hide = (n: NotExported): number => n.hidden;
`,

  "test/report.test.ts": `
import { report } from "../src/produce.ts";

export const seen = report.onlyTestsRead;
`,
};

const buildFixture = async (root: string): Promise<void> => {
  for (const folder of ["cli", "scripts/jsx", "src", "test"]) {
    await Deno.mkdir(`${root}/${folder}`, { recursive: true });
  }
  for (const [path, text] of Object.entries(FIXTURE)) {
    await Deno.writeTextFile(`${root}/${path}`, text);
  }
};

describe("scanUnreadFields", () => {
  let root = "";
  let findings: Finding[] = [];

  const verdictOf = (owner: string, field: string): string | undefined =>
    findings.find((f) => f.owner === owner && f.field === field)?.verdict;

  beforeAll(async () => {
    root = await Deno.makeTempDir({ prefix: "unread-fields-" });
    await buildFixture(root);
    findings = await scanUnreadFields(root);
  });

  afterAll(async () => {
    await Deno.remove(root, { recursive: true });
  });

  test("reports every field of every exported shape, and only those", () => {
    expect(findings.map((f) => `${f.owner}.${f.field}`).sort()).toEqual([
      "BadgeProps.label",
      "BadgeProps.supplied",
      "Report.deep",
      "Report.headline",
      "Report.nested",
      "Report.onlyTestsRead",
      "Sum.noOneReadsThis",
      "Sum.takenOutByPattern",
      "Sum.total",
    ]);
  });

  test("leaves alone a shape the file does not export", () => {
    expect(findings.some((f) => f.owner === "NotExported")).toBe(false);
  });

  test("names the file that declares each field", () => {
    expect(findings.find((f) => f.field === "total")?.file).toBe(
      "src/shapes.ts",
    );
  });

  test("sees a field read through an import map alias", () => {
    expect(verdictOf("Sum", "total")).toBe("read");
  });

  test("reports a field of an interface that nothing reads", () => {
    expect(verdictOf("Sum", "noOneReadsThis")).toBe("never read");
  });

  test("sees a field of an exported type alias", () => {
    expect(verdictOf("Report", "headline")).toBe("read");
  });

  test("sees a field of an object type nested in an exported shape", () => {
    expect(verdictOf("Report", "deep")).toBe("read");
  });

  test("counts only the tests when only the tests read a field", () => {
    expect(verdictOf("Report", "onlyTestsRead")).toBe("read only by tests");
  });

  test("counts a field taken out by a destructuring assignment as read", () => {
    expect(verdictOf("Sum", "takenOutByPattern")).toBe("read");
  });

  test("counts a JSX attribute as supplying the field, not reading it", () => {
    expect(verdictOf("BadgeProps", "supplied")).toBe("never read");
  });

  test("counts a prop the component destructures as read", () => {
    expect(verdictOf("BadgeProps", "label")).toBe("read");
  });
});
