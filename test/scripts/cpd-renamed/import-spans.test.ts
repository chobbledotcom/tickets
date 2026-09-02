import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  isImportSpan,
  staticImportSpans,
} from "#scripts/cpd-renamed/import-spans.ts";
import {
  collectFindings,
  type JscpdDuplicate,
} from "#scripts/cpd-renamed/run.ts";

const side = (name: string, start: number, end: number) => ({
  end,
  name,
  start,
});

const pair = (
  first: string,
  second: string,
  start: number,
  end: number,
): JscpdDuplicate => ({
  firstFile: side(first, start, end),
  secondFile: side(second, start, end),
});

const writeFiles = async (files: Record<string, string>): Promise<string> => {
  const root = await Deno.makeTempDir({ prefix: "cpd-import-span-" });
  await Promise.all(
    Object.entries(files).map(([name, source]) =>
      Deno.writeTextFile(`${root}/${name}`, source),
    ),
  );
  return root;
};

const collect = async (root: string, duplicate: JscpdDuplicate) =>
  await collectFindings({
    duplicates: [duplicate],
    output: { log: () => {} },
    registryFile: `${root}/allowed.json`,
    roots: [root],
  });

describe("renamed-copy import spans", () => {
  test("accepts a range inside one static import", () => {
    const source = [
      "import {",
      "  alpha, beta, gamma,",
      '} from "./values.ts";',
    ].join("\n");

    expect(
      isImportSpan(source, side("values.ts", 2, 2), [
        { end: source.length, start: 0 },
      ]),
    ).toBe(true);
  });

  test("rejects the same range without a static import", () => {
    const source = ["const row = {", "  alpha, beta, gamma,", "};"].join("\n");

    expect(isImportSpan(source, side("row.ts", 2, 2), [])).toBe(false);
  });

  test("rejects re-exports and ranges that continue into code", () => {
    const reExport = 'export { alpha, beta } from "./values.ts";';
    const reExportImports = staticImportSpans("barrel.ts", reExport);
    expect(reExportImports).toEqual([]);
    expect(
      isImportSpan(reExport, side("barrel.ts", 1, 1), reExportImports),
    ).toBe(false);

    const mixed = 'import { alpha } from "./values.ts";\nrun(alpha);';
    const importEnd = mixed.indexOf(";") + 1;
    expect(
      isImportSpan(mixed, side("mixed.ts", 1, 2), [
        { end: importEnd, start: 0 },
      ]),
    ).toBe(false);
  });

  test("accepts a range across adjacent static imports", () => {
    const source = [
      'import { alpha } from "./one.ts";',
      'import { beta } from "./two.ts";',
    ].join("\n");
    const firstEnd = source.indexOf(";") + 1;
    const secondStart = source.indexOf("import", firstEnd);

    expect(
      isImportSpan(source, side("imports.ts", 1, 2), [
        { end: firstEnd, start: 0 },
        { end: source.length, start: secondStart },
      ]),
    ).toBe(true);
  });

  test("rejects executable text between static imports", () => {
    const source = [
      'import { alpha } from "./one.ts";',
      "run(alpha);",
      'import { beta } from "./two.ts";',
    ].join("\n");

    expect(
      isImportSpan(
        source,
        side("imports.ts", 1, 3),
        staticImportSpans("imports.ts", source),
      ),
    ).toBe(false);
  });

  test("rejects empty coverage and invalid report ranges", () => {
    expect(isImportSpan("   ", side("empty.ts", 1, 1), [])).toBe(false);
    expect(() =>
      isImportSpan("const value = 1;", side("bad.ts", 0, 1), []),
    ).toThrow("invalid line range");
  });

  test("keeps an object shorthand pair as a finding", async () => {
    const root = await writeFiles({
      "a.ts": [
        "const first =",
        "{",
        "  alpha, beta, gamma, delta, epsilon, zeta, eta, theta, iota,",
        "};",
      ].join("\n"),
      "b.ts": [
        "const second =",
        "{",
        "  one, two, three, four, five, six, seven, eight, nine,",
        "};",
      ].join("\n"),
    });
    try {
      const findings = await collect(root, pair("a.ts", "b.ts", 2, 4));

      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe("words");
      expect(findings[0]?.first).toBe("a.ts");
      expect(findings[0]?.second).toBe("b.ts");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("still exempts a pair of real import member lists", async () => {
    const root = await writeFiles({
      "a.ts": [
        "import {",
        "  alpha, beta, gamma, delta, epsilon, zeta, eta, theta, iota,",
        '} from "./first.ts";',
      ].join("\n"),
      "b.ts": [
        "import {",
        "  one, two, three, four, five, six, seven, eight, nine,",
        '} from "./second.ts";',
      ].join("\n"),
    });
    try {
      expect(await collect(root, pair("a.ts", "b.ts", 1, 3))).toEqual([]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("still exempts imports after non-ASCII comment text", async () => {
    const comment = "// caf\u00e9 \ud83d\ude00 note";
    const root = await writeFiles({
      "a.ts": [
        comment,
        "import {",
        "  alpha, beta, gamma, delta, epsilon, zeta, eta, theta, iota,",
        '} from "./first.ts";',
      ].join("\n"),
      "b.ts": [
        comment,
        "import {",
        "  one, two, three, four, five, six, seven, eight, nine,",
        '} from "./second.ts";',
      ].join("\n"),
    });
    try {
      expect(await collect(root, pair("a.ts", "b.ts", 2, 4))).toEqual([]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("rejects an invalid second range when the first side is code", async () => {
    const root = await writeFiles({
      "a.ts": "const first = run(alpha);",
      "b.ts": "const second = run(beta);",
    });
    const duplicate = {
      firstFile: side("a.ts", 1, 1),
      secondFile: side("b.ts", 1, 2),
    };
    try {
      await expect(collect(root, duplicate)).rejects.toThrow(
        "invalid line range for b.ts: 1-2",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("keeps JSON pairs without parsing them as modules", async () => {
    const root = await writeFiles({
      "a.json": '{\n  "alpha": ["one", "two", "three"]\n}',
      "b.json": '{\n  "beta": ["four", "five", "six"]\n}',
    });
    try {
      const findings = await collect(root, pair("a.json", "b.json", 1, 3));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe("words");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  test("reads and parses each source once per scan", async () => {
    const root = await writeFiles({
      "a.ts": "const alpha = run(one);",
      "b.ts": "const beta = run(two);",
      "c.ts": "const gamma = run(three);",
    });
    const readText = spy(Deno, "readTextFileSync");
    try {
      await collectFindings({
        duplicates: [pair("a.ts", "b.ts", 1, 1), pair("a.ts", "c.ts", 1, 1)],
        output: { log: () => {} },
        registryFile: `${root}/allowed.json`,
        roots: [root],
      });
      const fixtureReads = readText.calls.filter(({ args }) =>
        String(args[0]).startsWith(root),
      );
      expect(fixtureReads).toHaveLength(3);
    } finally {
      readText.restore();
      await Deno.remove(root, { recursive: true });
    }
  });
});
