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

  // Outside the four scanned folders, so its read does not count.
  "outside.ts": `
import { sum } from "./src/produce.ts";

export const ignored = sum.readOnlyFromOutside;
`,

  // Reached by the prefix form of an alias, "#jsx/*". It lives under scripts/
  // so its own fields are not findings.
  "scripts/jsx/jsx-runtime.ts": `
export namespace JSX {
  export type Element = { tag: string };
}
`,

  "src/badge.tsx": `
import type { JSX } from "#jsx/jsx-runtime.ts";

export type BadgeProps = { label: string; supplied: string };

export const Badge = ({ label }: BadgeProps): JSX.Element => ({ tag: label });

export const badge = <Badge label="hi" supplied="nothing reads this" />;
`,

  // A barrel. Its re-exports belong to the file that declares them, so nothing
  // here is counted twice. The last name is not there to be re-exported, so
  // the compiler stands in a symbol that was never written down anywhere.
  "src/barrel.ts": `
export type { Report, Sum } from "#shapes";
export type { Gone } from "./nowhere.ts";
`,

  "src/consume.ts": `
import type { Reached } from "./inner";
import { report, sum } from "./produce.ts";
import type { ExtendsFarBase, Passed } from "./shapes.ts";

export const shown = String(sum.total) + report.headline;

export const reach = (r: Reached): number => r.total;

export const far = (f: ExtendsFarBase): number => f.readFromFarAway;

export const forward = ({ kept, ...rest }: Passed): Passed => ({
  ...rest,
  kept: kept + 1,
});

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

  // Reached by a directory import. The compiler finds it only when the host
  // says truthfully that "src/inner.ts" is not a file.
  "src/inner/index.ts": `
export interface Reached {
  total: number;
}

export interface FarBase {
  paddingSoTheOffsetIsWrongInAnotherFile: number;
  readFromFarAway: number;
}
`,

  // No import and no export, so this file is a script and not a module. It
  // offers nothing for other files to reach.
  "src/plain.ts": `
const kept = 1;
console.log(kept);
`,

  // Every field written, none read: on its own this file proves nothing.
  "src/produce.ts": `
import type { Report, Sum } from "#shapes";

export const sum: Sum = {
  noOneReadsThis: 2,
  readOnlyFromOutside: 4,
  takenOutByPattern: 3,
  total: 1,
};
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
  readOnlyFromOutside: number;
  takenOutByPattern: number;
}

export type Report = {
  headline: string;
  onlyTestsRead: string;
  nested: { deep: number };
  [key: string]: unknown;
};

class BaseClass {
  fromAClass = 1;
}

interface HiddenBase extends BaseClass {
  fromABaseNobodySees: number;
  shadowed: number;
}

import type { FarBase } from "./inner/index.ts";

export interface ExtendsFarBase extends FarBase {}

export interface Extends extends HiddenBase {
  ofItsOwn: number;
  shadowed: number;
}

export namespace Wrapped {
  export import Self = Wrapped;

  export interface Inner {
    onlyInsideNamespace: number;
  }
}

export interface Passed {
  kept: number;
  carriedBySpread: number;
}

interface NotExported {
  hidden: number;
}

interface IntersectedBase {
  fromAnIntersection: number;
}

export type Intersects = IntersectedBase & {
  ofItsOwnAgain: number;
};

interface ListExported {
  onlyInAList: number;
}

export type { ListExported };

export const hide = (n: NotExported): number => n.hidden;
`,

  "test/report.test.ts": `
import { report } from "../src/produce.ts";

export const seen = report.onlyTestsRead;
`,
};

const buildFixture = async (root: string): Promise<void> => {
  for (const folder of ["cli", "scripts/jsx", "src/inner", "test"]) {
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
      "Extends.fromABaseNobodySees",
      "Extends.ofItsOwn",
      "Extends.shadowed",
      "ExtendsFarBase.paddingSoTheOffsetIsWrongInAnotherFile",
      "ExtendsFarBase.readFromFarAway",
      "FarBase.paddingSoTheOffsetIsWrongInAnotherFile",
      "FarBase.readFromFarAway",
      "Inner.onlyInsideNamespace",
      "Intersects.fromAnIntersection",
      "Intersects.ofItsOwnAgain",
      "ListExported.onlyInAList",
      "Passed.carriedBySpread",
      "Passed.kept",
      "Reached.total",
      "Report.headline",
      "Report.nested",
      "Report.nested.deep",
      "Report.onlyTestsRead",
      "Sum.noOneReadsThis",
      "Sum.readOnlyFromOutside",
      "Sum.takenOutByPattern",
      "Sum.total",
    ]);
  });

  test("leaves alone a shape the file does not export", () => {
    expect(findings.some((f) => f.owner === "NotExported")).toBe(false);
  });

  test("finds a field an exported shape takes from a hidden base", () => {
    expect(verdictOf("Extends", "fromABaseNobodySees")).toBe("never read");
  });

  test("counts a field the shape declares again only once", () => {
    expect(
      findings.filter((f) => f.owner === "Extends" && f.field === "shadowed"),
    ).toHaveLength(1);
  });

  test("looks a field up in the file that declares it", () => {
    expect(verdictOf("ExtendsFarBase", "readFromFarAway")).toBe("read");
  });

  test("names the declaring file, not the shape that hands the field on", () => {
    expect(
      findings.find(
        (f) => f.owner === "ExtendsFarBase" && f.field === "readFromFarAway",
      )?.file,
    ).toBe("src/inner/index.ts");
  });

  test("finds a field an exported alias takes from an intersection", () => {
    expect(verdictOf("Intersects", "fromAnIntersection")).toBe("never read");
  });

  test("finds a shape exported by a list at the foot of the file", () => {
    expect(verdictOf("ListExported", "onlyInAList")).toBe("never read");
  });

  test("counts a re-exported shape once, where it is declared", () => {
    const totals = findings.filter(
      (f) => f.owner === "Sum" && f.field === "total",
    );
    expect(totals.map((f) => f.file)).toEqual(["src/shapes.ts"]);
  });

  test("finds a shape declared inside a namespace", () => {
    expect(verdictOf("Inner", "onlyInsideNamespace")).toBe("never read");
  });

  test("sees a field read through a directory import", () => {
    expect(verdictOf("Reached", "total")).toBe("read");
  });

  test("ignores a reader outside the folders it scans", () => {
    expect(verdictOf("Sum", "readOnlyFromOutside")).toBe("never read");
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
    expect(verdictOf("Report.nested", "deep")).toBe("read");
  });

  test("counts only the tests when only the tests read a field", () => {
    expect(verdictOf("Report", "onlyTestsRead")).toBe("read only by tests");
  });

  test("counts a field taken out by a destructuring assignment as read", () => {
    expect(verdictOf("Sum", "takenOutByPattern")).toBe("read");
  });

  test("counts a field a rest pattern names as read", () => {
    expect(verdictOf("Passed", "kept")).toBe("read");
  });

  // The blind spot the README names first: a spread moves the field without
  // naming it, so there is no reference for the scan to find.
  test("cannot follow a field carried only by a spread", () => {
    expect(verdictOf("Passed", "carriedBySpread")).toBe("never read");
  });

  test("counts a JSX attribute as supplying the field, not reading it", () => {
    expect(verdictOf("BadgeProps", "supplied")).toBe("never read");
  });

  test("counts a prop the component destructures as read", () => {
    expect(verdictOf("BadgeProps", "label")).toBe("read");
  });
});
