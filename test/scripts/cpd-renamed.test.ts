import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  cloneKind,
  collectFindings,
  isImportSpan,
  type JscpdDuplicate,
  pairHash,
  resolvePath,
  runRenamedCloneCheck,
} from "#scripts/cpd-renamed/run.ts";

describe("skeleton", () => {
  it("keeps only the punctuation shape of the code", () => {
    expect(
      cloneKind("pipe(map((x) => x.name))(users)", "a(b((c) => c.d))(e)"),
    ).toBe("words");
  });

  it("treats strings as words, so only the wording differs", () => {
    expect(cloneKind(`t("orders.title")`, `t("pages.title")`)).toBe("words");
  });

  it("keeps control-flow keywords, so different flow is not a rename", () => {
    expect(cloneKind("if (ready) work();", "while (ready) work();")).toBe(
      "different",
    );
  });

  it("keeps true and false, so a flipped flag is not a rename", () => {
    expect(cloneKind("return !listing.active;", "return listing.active;")).toBe(
      "different",
    );
  });

  it("masks reserved words used as member names, so a rename is still a rename", () => {
    expect(cloneKind("client.delete(item);", "client.archive(item);")).toBe(
      "words",
    );
  });
});

describe("cloneKind", () => {
  it("calls byte-equal snippets identical", () => {
    const snippet = "export const a = (): string => hmac(slug);";
    expect(cloneKind(snippet, snippet)).toBe("identical");
  });

  it("calls different shapes different", () => {
    expect(
      cloneKind(
        "pipe(filter(active), map(name))(users);",
        "for (const user of users) { if (user.active) out.push(user.name); }",
      ),
    ).toBe("different");
  });
});

describe("isImportSpan", () => {
  it("accepts a span that opens with import", () => {
    expect(isImportSpan(`import { expect } from "@std/expect";`)).toBe(true);
  });

  it("accepts a member-list tail that closes on a module specifier", () => {
    expect(
      isImportSpan(`  getGroupBySlugIndex,
  groups,
} from "#db/groups.ts";`),
    ).toBe(true);
  });

  it("accepts an import jscpd cut mid-statement", () => {
    // jscpd stops a span on a token boundary, not a statement boundary, so
    // the last import may be missing its `from "…"` close. It is still only
    // import content. (The fixture lines are indented so the raw import
    // checker treats them as example text, not real imports.)
    expect(
      isImportSpan(`import { settings } from "#db/settings.ts";
        import {
          createTokenRoute,`),
    ).toBe(true);
  });

  it("accepts a member tail cut out of an import block", () => {
    // jscpd cuts on token boundaries, so a span can begin mid-list and end
    // before the `from "…"` close. It is still import content.
    expect(
      isImportSpan(`summarizeProviderResponse,
  targetAllowsEmpty,
  targetQuery,`),
    ).toBe(true);
    expect(isImportSpan("targetQuery,")).toBe(true);
  });

  it("rejects a span that continues past an import into copied code", () => {
    expect(
      isImportSpan(`import { expect } from "@std/expect";
export const answer = (slug: string) => hash(slug);`),
    ).toBe(false);
  });

  it("rejects executable shorthand returns, identical on both sides", () => {
    // A bare word-and-braces list is not import syntax: an executable clone
    // must not slip past the gate as a would-be import fragment.
    expect(isImportSpan("return { alpha, beta, gamma, delta, epsilon };")).toBe(
      false,
    );
  });

  it("rejects ordinary code that merely mentions from", () => {
    expect(isImportSpan("const row = await readFrom(groups);")).toBe(false);
    expect(
      isImportSpan("export const computeIndex = (slug) => hash(slug);"),
    ).toBe(false);
  });

  it("treats an empty span as not an import", () => {
    expect(isImportSpan("")).toBe(false);
  });
});

describe("pairHash", () => {
  it("is stable across formatting noise and differs between pairs", async () => {
    const first = await pairHash(
      { file: "a.ts", snippet: "const a = 1;\n" },
      { file: "b.ts", snippet: "const b = 2;" },
    );
    const same = await pairHash(
      { file: "a.ts", snippet: "const a = 1;" },
      { file: "b.ts", snippet: "  const b = 2;" },
    );
    const other = await pairHash(
      { file: "a.ts", snippet: "const a = 1;" },
      { file: "b.ts", snippet: "const b = 3;" },
    );
    expect(first).toBe(same);
    expect(first).not.toBe(other);
    expect(first).toHaveLength(64);
  });

  it("names the files, so the same snippets copied elsewhere are a new pair", async () => {
    const original = await pairHash(
      { file: "src/one.ts", snippet: "shared body" },
      { file: "src/two.ts", snippet: "shared body" },
    );
    const copied = await pairHash(
      { file: "src/other/one.ts", snippet: "shared body" },
      { file: "src/other/two.ts", snippet: "shared body" },
    );
    expect(copied).not.toBe(original);
  });
});

describe("resolvePath", () => {
  it("finds the scan root that holds the file", () => {
    const roots = ["/nonexistent-root", "scripts"];
    expect(resolvePath(roots, "checksum.ts")).toBe("scripts/checksum.ts");
  });

  it("names the file when no root holds it", () => {
    expect(() => resolvePath(["scripts"], "no-such-file.ts")).toThrow(
      "jscpd reported a file no scan root holds: no-such-file.ts",
    );
  });
});

const writeFixture = async (files: Record<string, string>): Promise<string> => {
  const root = await Deno.makeTempDir({ prefix: "cpd-renamed-test-" });
  for (const [name, body] of Object.entries(files)) {
    const path = `${root}/${name}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, body);
  }
  return root;
};

const pairOf = (
  firstName: string,
  firstStart: number,
  secondName: string,
  secondStart: number,
): JscpdDuplicate => ({
  firstFile: { end: firstStart + 2, name: firstName, start: firstStart },
  secondFile: { end: secondStart + 2, name: secondName, start: secondStart },
});

describe("collectFindings", () => {
  it("keeps word-only pairs and drops imports and different shapes", async () => {
    const root = await writeFixture({
      "a.ts": `export const computeOneIndex = (slug: string): string =>
  hmac(slug);
`,
      "b.ts": `export const computeTwoIndex = (slug: string): string =>
  hmac(slug);
`,
      "c.ts": `import { expect } from "first-fixture";
import { it } from "second-fixture";
`,
      "d.ts": `import { expect } from "third-fixture";
import { describe } from "fourth-fixture";
`,
      "e.ts": `const total = (rows: Row[]): number => rows.length;
`,
    });
    try {
      const findings = await collectFindings({
        duplicates: [
          pairOf("a.ts", 1, "b.ts", 1),
          pairOf("c.ts", 1, "d.ts", 1),
          pairOf("a.ts", 1, "e.ts", 1),
        ],
        output: { log: () => {} },
        registryFile: `${root}/allowed.json`,
        roots: [root],
      });
      expect(findings.length).toBe(1);
      expect(findings[0]?.kind).toBe("words");
      expect(findings[0]?.first).toBe("a.ts");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("runRenamedCloneCheck", () => {
  const fixtures = {
    "a.ts": `export const computeOneIndex = (slug: string): string =>
  hmac(slug);
`,
    "b.ts": `export const computeTwoIndex = (slug: string): string =>
  hmac(slug);
`,
  };

  const run = async (
    root: string,
    duplicates: JscpdDuplicate[],
    registryFile: string,
    update = false,
  ) => {
    const lines: string[] = [];
    const code = await runRenamedCloneCheck({
      duplicates,
      output: { log: (line) => lines.push(line) },
      registryFile,
      roots: [root],
      update,
    });
    let registry: Array<{ reason?: string }> = [];
    try {
      registry = JSON.parse(Deno.readTextFileSync(registryFile));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return { code, lines, registry };
  };

  it("fails on a new word-only copy and passes once the registry carries it", async () => {
    const root = await writeFixture(fixtures);
    const registryFile = `${root}/allowed.json`;
    try {
      const first = await run(
        root,
        [pairOf("a.ts", 1, "b.ts", 1)],
        registryFile,
      );
      expect(first.code).toBe(1);
      expect(first.lines.join("\n")).toContain("COPY FOUND");

      await run(root, [pairOf("a.ts", 1, "b.ts", 1)], registryFile, true);
      const second = await run(
        root,
        [pairOf("a.ts", 1, "b.ts", 1)],
        registryFile,
      );
      expect(second.code).toBe(0);
      expect(second.registry.length).toBe(1);
      expect(second.registry[0]?.reason).toContain("pending review");

      const third = await run(root, [], registryFile);
      expect(third.code).toBe(1);
      expect(third.lines.join("\n")).toContain("STALE ENTRY");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  /** The base fixture pair's finding — shared by the tests below. */
  const baseFinding = async (root: string) => {
    const [finding] = await collectFindings({
      duplicates: [pairOf("a.ts", 1, "b.ts", 1)],
      output: { log: () => {} },
      registryFile: `${root}/allowed.json`,
      roots: [root],
    });
    if (finding === undefined) throw new Error("fixture pair not found");
    return finding;
  };

  it("fails on the same pair content copied into new files", async () => {
    // The registry identity names both files, so a previously reviewed copy
    // relocated to new files still needs its own review.
    const root = await writeFixture({
      ...fixtures,
      "nested/one.ts": fixtures["a.ts"],
      "nested/two.ts": fixtures["b.ts"],
    });
    const registryFile = `${root}/allowed.json`;
    try {
      const finding = await baseFinding(root);
      const nested = pairOf("nested/one.ts", 1, "nested/two.ts", 1);
      const [nestedFinding] = await collectFindings({
        duplicates: [nested],
        output: { log: () => {} },
        registryFile,
        roots: [root],
      });
      if (nestedFinding === undefined) {
        throw new Error("nested fixture pair not found");
      }
      expect(nestedFinding.kind).toBe(finding.kind);
      expect(nestedFinding.hash).not.toBe(finding.hash);

      await Deno.writeTextFile(
        registryFile,
        `${JSON.stringify([{ ...finding, reason: "declared rows" }])}\n`,
      );
      const result = await run(root, [nested], registryFile);
      expect(result.code).toBe(1);
      expect(result.lines.join("\n")).toContain("COPY FOUND");
      expect(result.lines.join("\n")).toContain("nested/one.ts");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("keeps a reviewed reason, read or rewritten", async () => {
    const root = await writeFixture(fixtures);
    const registryFile = `${root}/allowed.json`;
    try {
      const seed = `${JSON.stringify([
        {
          ...(await baseFinding(root)),
          reason: "declared data rows — by design",
        },
      ])}\n`;
      const pair = [pairOf("a.ts", 1, "b.ts", 1)];
      for (const update of [false, true]) {
        await Deno.writeTextFile(registryFile, seed);
        const result = await run(root, pair, registryFile, update);
        expect(result.code).toBe(0);
        expect(result.registry[0]?.reason).toBe(
          "declared data rows — by design",
        );
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("fails loudly on a registry file that is not JSON", async () => {
    const root = await writeFixture({
      ...fixtures,
      "allowed.json": "not json",
    });
    try {
      await run(root, [pairOf("a.ts", 1, "b.ts", 1)], `${root}/allowed.json`);
      throw new Error("expected the broken registry to fail");
    } catch (error) {
      expect(error instanceof SyntaxError).toBe(true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
