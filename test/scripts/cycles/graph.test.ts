import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import {
  cyclicGroups,
  formatCycleReport,
  loadTimeEdges,
} from "#scripts/cycles/graph.ts";
import { runCycleReport } from "#scripts/cycles/run.ts";
import type { ModuleGraph } from "#scripts/module-graph.ts";

const ROOT = "/repo";

/** One dependency as the graph reader parses it — derived from the graph
 * type, so the fixture follows the reader's own shape. */
type Dep = NonNullable<ModuleGraph["modules"][number]["dependencies"]>[number];

/** A module in the graph: local unless its specifier says otherwise. */
const moduleOf = (
  path: string,
  deps: Partial<Dep>[],
): ModuleGraph["modules"][number] => ({
  dependencies: deps.map((dep) => ({
    specifier: dep.specifier ?? "",
    ...dep,
  })),
  specifier: path.startsWith("file://") ? path : `file://${ROOT}/${path}`,
});

/** A graph whose root is the first module given. */
const graphOf = (
  root: ModuleGraph["modules"][number],
  ...rest: ModuleGraph["modules"][number][]
): ModuleGraph => ({ modules: [root, ...rest], roots: [root.specifier] });

describe("loadTimeEdges", () => {
  test("keeps the static local imports as relative edges", () => {
    const edges = loadTimeEdges(
      graphOf(
        moduleOf("src/a.ts", [
          { code: { specifier: `file://${ROOT}/src/b.ts` } },
        ]),
        moduleOf("src/b.ts", []),
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
        ]),
        moduleOf("src/lazy.ts", []),
        moduleOf("file:///elsewhere/src/out.ts", []),
      ),
      ROOT,
    );
    expect(edges.has("src/a.ts")).toBe(false);
  });

  test("reports a module that imports itself as a tangle of one", () => {
    const edges = loadTimeEdges(
      graphOf(
        moduleOf("src/entry.ts", [
          { code: { specifier: `file://${ROOT}/src/self.ts` } },
        ]),
        moduleOf("src/self.ts", [
          { code: { specifier: `file://${ROOT}/src/self.ts` } },
        ]),
      ),
      ROOT,
    );
    expect(cyclicGroups(edges)).toEqual([["src/self.ts"]]);
  });

  test("keeps edges under a repo path whose URL form is escaped", () => {
    // A checkout under "my repo" arrives from deno info as file:///my%20repo/.
    // The dependency carries the escaped form the way deno info emits it.
    const edges = loadTimeEdges(
      graphOf(
        {
          dependencies: [
            {
              code: { specifier: "file:///my%20repo/src/b.ts" },
              specifier: "",
            },
          ],
          specifier: "file:///my%20repo/src/a.ts",
        },
        {
          dependencies: [],
          specifier: "file:///my%20repo/src/b.ts",
        },
      ),
      "/my repo",
    );
    expect(edges.get("src/a.ts")).toEqual(new Set(["src/b.ts"]));
  });

  test("keeps a module whose name begins with two dots", () => {
    // "..generated" is a folder under the root, not the parent escape.
    const edges = loadTimeEdges(
      graphOf(
        moduleOf("src/entry.ts", [
          { code: { specifier: `file://${ROOT}/..generated/a.ts` } },
        ]),
        moduleOf("..generated/a.ts", []),
      ),
      ROOT,
    );
    expect(edges.get("src/entry.ts")).toEqual(new Set(["..generated/a.ts"]));
  });

  test("skips a cycle nothing at runtime can reach", () => {
    // The entry imports the pair for types only, so neither module ever
    // evaluates and their mutual imports are no load-order tangle.
    const edges = loadTimeEdges(
      graphOf(
        moduleOf("src/entry.ts", [{ specifier: "#pair/a.ts" }]),
        moduleOf("src/pair/a.ts", [
          { code: { specifier: `file://${ROOT}/src/pair/b.ts` } },
        ]),
        moduleOf("src/pair/b.ts", [
          { code: { specifier: `file://${ROOT}/src/pair/a.ts` } },
        ]),
      ),
      ROOT,
    );
    expect(edges.size).toBe(0);
  });

  test("keeps a cycle behind a dynamic import", () => {
    // A deferred module still evaluates on first use, so its own static
    // cycle is a real load-order tangle once it loads.
    const edges = loadTimeEdges(
      graphOf(
        moduleOf("src/entry.ts", [
          {
            code: { specifier: `file://${ROOT}/src/lazy/a.ts` },
            isDynamic: true,
          },
        ]),
        moduleOf("src/lazy/a.ts", [
          { code: { specifier: `file://${ROOT}/src/lazy/b.ts` } },
        ]),
        moduleOf("src/lazy/b.ts", [
          { code: { specifier: `file://${ROOT}/src/lazy/a.ts` } },
        ]),
      ),
      ROOT,
    );
    expect(cyclicGroups(edges)).toEqual([["src/lazy/a.ts", "src/lazy/b.ts"]]);
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

  test("keeps a self-edge as a one-module group", () => {
    expect(cyclicGroups(edgesOf([["a.ts", "a.ts"]]))).toEqual([["a.ts"]]);
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
  test("shapes the answer from whatever graph it reads", async () => {
    // A stubbed reader keeps the deno-info subprocess out of the ordinary
    // suite; the real read has its own direct tests. The fixture must sit
    // under the repo root the report computes for itself.
    const repo = resolve(import.meta.dirname!, "../../..");
    const graph = graphOf(
      moduleOf(`file://${repo}/src/a.ts`, [
        { code: { specifier: `file://${repo}/src/b.ts` } },
      ]),
      moduleOf(`file://${repo}/src/b.ts`, [
        { code: { specifier: `file://${repo}/src/a.ts` } },
      ]),
    );
    const report = await runCycleReport(() => Promise.resolve(graph));
    expect(report).toContain("modules with load-time imports: 2");
    expect(report).toContain("cyclic groups: 1");
    expect(report).toContain("== group of 2 ==");
    expect(report).toContain("  src/a.ts");
    expect(report).toContain("  src/b.ts");
    expect(report).toContain("type-only imports evaluate nothing and dynamic");
  });
});
