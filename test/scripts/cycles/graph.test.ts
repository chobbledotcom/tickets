import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  cyclicGroups,
  formatCycleReport,
  loadTimeEdges,
} from "#scripts/cycles/graph.ts";
import { runCycleReport } from "#scripts/cycles/run.ts";
import type { Dependency, ModuleGraph } from "#scripts/module-graph.ts";

const ROOT = "/repo";

/** A module in the graph: local unless its specifier says otherwise. */
const moduleOf = (
  path: string,
  deps: Partial<Dependency>[],
): ModuleGraph["modules"][number] => ({
  dependencies: deps.map((dep) => ({
    specifier: dep.specifier ?? "",
    ...dep,
  })),
  specifier: path.startsWith("file://") ? path : `file://${ROOT}/${path}`,
});

const graphOf = (
  ...modules: ModuleGraph["modules"][number][]
): ModuleGraph => ({ modules, roots: [] });

describe("loadTimeEdges", () => {
  test("keeps the static local imports as relative edges", () => {
    const edges = loadTimeEdges(
      graphOf(
        moduleOf("src/a.ts", [
          { code: { specifier: `file://${ROOT}/src/b.ts` } },
        ]),
      ),
      ROOT,
    );
    expect(edges.get("src/a.ts")).toEqual(new Set(["src/b.ts"]));
  });

  test("drops dynamic imports, type-only imports, and far modules", () => {
    const edges = loadTimeEdges(
      graphOf(
        moduleOf("src/a.ts", [
          {
            code: { specifier: `file://${ROOT}/src/lazy.ts` },
            isDynamic: true,
          },
          { specifier: "#types" },
          { code: { specifier: "npm:valibot" } },
          { code: { specifier: "file:///elsewhere/src/out.ts" } },
          { code: { specifier: `file://${ROOT}/src/a.ts` } },
        ]),
      ),
      ROOT,
    );
    expect(edges.has("src/a.ts")).toBe(false);
  });
});

describe("cyclicGroups", () => {
  const edgesOf = (pairs: [string, string][]): Map<string, Set<string>> => {
    const edges = new Map<string, Set<string>>();
    for (const [from, to] of pairs) {
      const targets = edges.get(from) ?? new Set<string>();
      targets.add(to);
      edges.set(from, targets);
    }
    return edges;
  };

  test("finds a two-module cycle", () => {
    expect(
      cyclicGroups(
        edgesOf([
          ["a.ts", "b.ts"],
          ["b.ts", "a.ts"],
        ]),
      ),
    ).toEqual([["a.ts", "b.ts"]]);
  });

  test("finds a three-module loop beside a plain chain", () => {
    const groups = cyclicGroups(
      edgesOf([
        ["a.ts", "b.ts"],
        ["b.ts", "c.ts"],
        ["c.ts", "a.ts"],
        ["d.ts", "e.ts"],
      ]),
    );
    expect(groups).toEqual([["a.ts", "b.ts", "c.ts"]]);
  });

  test("lists the largest group first, members sorted", () => {
    const groups = cyclicGroups(
      edgesOf([
        ["y.ts", "z.ts"],
        ["z.ts", "y.ts"],
        ["a.ts", "c.ts"],
        ["c.ts", "b.ts"],
        ["b.ts", "a.ts"],
      ]),
    );
    expect(groups).toEqual([
      ["a.ts", "b.ts", "c.ts"],
      ["y.ts", "z.ts"],
    ]);
  });

  test("answers nothing for an acyclic graph", () => {
    expect(
      cyclicGroups(
        edgesOf([
          ["a.ts", "b.ts"],
          ["b.ts", "c.ts"],
        ]),
      ),
    ).toEqual([]);
  });
});

describe("formatCycleReport", () => {
  test("states what was measured and names every group's members", () => {
    const edges = new Map<string, Set<string>>([
      ["a.ts", new Set(["b.ts"])],
      ["b.ts", new Set(["a.ts"])],
    ]);
    const report = formatCycleReport(edges, [["a.ts", "b.ts"]]);
    expect(report).toContain("modules with load-time imports: 2");
    expect(report).toContain("cyclic groups: 1");
    expect(report).toContain("dynamic");
    expect(report).toContain("== group of 2 ==");
    expect(report).toContain("  a.ts");
    expect(report).toContain("  b.ts");
  });

  test("still explains the measurement when the tree is clean", () => {
    const report = formatCycleReport(new Map(), []);
    expect(report).toContain("cyclic groups: 0");
  });
});

describe("runCycleReport", () => {
  test("runs against the real tree and reports a shaped answer", async () => {
    const report = await runCycleReport();
    // Structure, not debt: the report must state what it measured and count
    // its groups, whatever the tree's current cycle count is.
    expect(report).toMatch(/modules with load-time imports: \d+/);
    expect(report).toMatch(/cyclic groups: \d+/);
    expect(report).toContain("type-only imports evaluate nothing and dynamic");
  });
});
