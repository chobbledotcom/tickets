import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  baselineRose,
  type DocumentFile,
  freshBaseline,
  freshEntry,
  markdownFilesIn,
  markdownFilesUnder,
  readDocuments,
  runSteCheck,
} from "#scripts/check-ste/run.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";

describe("reading the markdown the check covers", () => {
  let dir: TempPath;

  const makeDocs = () => {
    Deno.mkdirSync(`${dir.path}/docs`);
    Deno.mkdirSync(`${dir.path}/cli`);
    Deno.mkdirSync(`${dir.path}/scripts/.hidden`, { recursive: true });
    Deno.writeTextFileSync(`${dir.path}/AGENTS.md`, "Write it.\n");
    Deno.writeTextFileSync(`${dir.path}/notes.txt`, "not markdown\n");
    Deno.writeTextFileSync(`${dir.path}/docs/one.md`, "Write one.\n");
    Deno.writeTextFileSync(`${dir.path}/docs/two.md`, "Write two.\n");
    Deno.writeTextFileSync(`${dir.path}/cli/README.md`, "Write three.\n");
    Deno.writeTextFileSync(`${dir.path}/scripts/README.md`, "Write four.\n");
    Deno.writeTextFileSync(
      `${dir.path}/scripts/.hidden/secret.md`,
      "Write five.\n",
    );
  };

  test("markdownFilesIn lists only .md files in one folder, sorted", async () => {
    await withTemp(async () => {
      makeDocs();
      expect(await markdownFilesIn(dir.path)).toEqual([
        `${dir.path}/AGENTS.md`,
      ]);
      expect(await markdownFilesIn(`${dir.path}/docs`)).toEqual([
        `${dir.path}/docs/one.md`,
        `${dir.path}/docs/two.md`,
      ]);
    });
  });

  test("markdownFilesUnder walks a tree, minus hidden folders", async () => {
    await withTemp(async () => {
      makeDocs();
      expect(await markdownFilesUnder(`${dir.path}/scripts`)).toEqual([
        `${dir.path}/scripts/README.md`,
      ]);
    });
  });

  test("readDocuments reads the root files plus every named tree, sorted", async () => {
    await withTemp(async () => {
      makeDocs();
      const documents: DocumentFile[] = await readDocuments(dir.path, [
        `${dir.path}/docs`,
        `${dir.path}/cli`,
        `${dir.path}/scripts`,
      ]);
      expect(documents.map((one) => one.path)).toEqual([
        `${dir.path}/AGENTS.md`,
        `${dir.path}/cli/README.md`,
        `${dir.path}/docs/one.md`,
        `${dir.path}/docs/two.md`,
        `${dir.path}/scripts/README.md`,
      ]);
      expect(documents[0]?.content).toBe("Write it.\n");
    });
  });

  const withTemp = async (run: () => Promise<void>) => {
    dir = tempDir();
    try {
      await run();
    } finally {
      dir.dispose();
    }
  };
});

describe("check-ste runner", () => {
  const output = {
    log: () => {},
    logError: () => {},
  };

  const file = (path: string, content: string): DocumentFile => ({
    content,
    path,
  });

  /** Run the check over one document and one baseline entry, and hand back
   * the exit code plus the lines sent to the error logger. */
  const checkAgainst = (
    content: string,
    entry: Record<string, number>,
  ): { code: number; errors: string[] } => {
    const errors: string[] = [];
    const code = runSteCheck(
      [file("a.md", content)],
      {},
      { "a.md": entry },
      {
        log: () => {},
        logError: (line) => errors.push(line),
      },
    );
    return { code, errors };
  };

  test("passes a document at its baseline, finding by finding", () => {
    const files = [
      file("a.md", "Write it; then stop. It may fail.\n"),
      file("b.md", "Write b; one.\n"),
    ];
    const atBaseline = {
      "a.md": freshEntry("Write it; then stop. It may fail.\n"),
      "b.md": freshEntry("Write b; one.\n"),
    };
    expect(runSteCheck(files, {}, atBaseline, output)).toBe(0);
    // b.md's record now covers none of its findings, so they all rose.
    expect(runSteCheck(files, {}, { ...atBaseline, "b.md": {} }, output)).toBe(
      1,
    );
  });

  test("fails when one identity rose, naming that finding", () => {
    const recorded = freshEntry("Write; one.\n");
    const { code, errors } = checkAgainst(
      "Write; one. It may fail.\n",
      recorded,
    );
    expect(code).toBe(1);
    // Editing the line makes new prose of every finding on it, so the
    // semicolon's old identity no longer covers it either.
    expect(errors[0]).toBe(
      'a.md:1 [banned-modal]: "may" — use can, will, or must',
    );
    expect(errors[1]).toBe('a.md:1 [semicolon]: ";" — write two sentences');
    expect(errors[2]).toContain("2 technical-english issue(s) found");
  });

  test("keeps an allowance from moving to a new line of prose", () => {
    // The writer removed a grandfathered semicolon and added a different
    // one elsewhere. One finding for one finding, but the new one's prose
    // holds a different identity, so it rose.
    const recorded = freshEntry("Write; one.\n");
    const { code, errors } = checkAgainst(
      "It may fail. Also; here.\n",
      recorded,
    );
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/\[banned-modal\]|\[semicolon\]/);
  });

  test("fails when a document improved, so the update lands with its step", () => {
    const recorded = freshEntry("Write one; note.\n");
    recorded[Object.keys(recorded)[0]!] = 3;
    const { code, errors } = checkAgainst("Write one; note.\n", recorded);
    expect(code).toBe(1);
    expect(errors[0]).toContain("a.md [improved]");
    expect(errors[0]).toContain("--update");
  });

  test("fails when a document holds no findings any more", () => {
    const recorded = freshEntry("Write it; clean.\n");
    const { code, errors } = checkAgainst("Write it clean.\n", recorded);
    expect(code).toBe(1);
    expect(errors[0]).toContain("a.md [improved]");
  });

  test("a document with no entry must be clean", () => {
    const files = [file("new.md", "Write it; then stop.\n")];
    expect(runSteCheck(files, {}, {}, output)).toBe(1);
    expect(
      runSteCheck(
        files,
        {},
        { "new.md": freshEntry(files[0]!.content) },
        output,
      ),
    ).toBe(0);
  });

  test("skips a record document, however it reads", async () => {
    const files = [file("plan.md", "It's been; simply made, would you not.\n")];
    expect(runSteCheck(files, { "plan.md": "a record" }, {}, output)).toBe(0);
    expect(await freshBaseline(files, { "plan.md": "a record" })).toEqual({});
  });

  test("freshBaseline records every non-record document's findings", async () => {
    const documents = [
      file("a.md", "Write; one.\n"),
      file("plan.md", "It's been; simply made.\n"),
    ];
    expect(await freshBaseline(documents, { "plan.md": "a record" })).toEqual({
      "a.md": freshEntry("Write; one.\n"),
    });
  });

  test("fails for a records or baseline entry that names no document", () => {
    const files = [file("a.md", "Write it.\n")];
    const errors: string[] = [];
    const code = runSteCheck(
      files,
      { "gone.md": "a record" },
      { "also-gone.md": {} },
      {
        ...output,
        logError: (line) => errors.push(line),
      },
    );
    expect(code).toBe(1);
    expect(errors[0]).toContain("also-gone.md");
    expect(errors[0]).toContain("baseline.json");
    expect(errors[1]).toContain("gone.md");
    expect(errors[1]).toContain("records.json");
  });

  test("logs the success line when everything matches", () => {
    const lines: string[] = [];
    const code = runSteCheck(
      [file("a.md", "Write it.\n")],
      {},
      {},
      { ...output, log: (line) => lines.push(line) },
    );
    expect(code).toBe(0);
    expect(lines).toEqual([
      "Every policy document passes the simplified-technical-english checks.",
    ]);
  });
});

describe("the baseline the update step records", () => {
  test("freshEntry counts each finding identity", () => {
    const entry = freshEntry("Write; one. It may fail.\n");
    expect(Object.keys(entry)).toEqual([
      'banned-modal "may" in Write; one. It may fail.',
      'semicolon ";" in Write; one. It may fail.',
    ]);
    expect(Object.values(entry)).toEqual([1, 1]);
    expect(freshEntry("Write it clean.\n")).toEqual({});
  });

  test("a repeated finding on one prose line counts together", () => {
    const entry = freshEntry("Write one; also two;\n");
    expect(entry).toEqual({
      'semicolon ";" in Write one; also two;': 2,
    });
  });

  test("baselineRose answers yes only when an identity's count rose", () => {
    const recorded = { "a.md": freshEntry("Write; one.\nTwo; three.\n") };
    const atBaseline = freshEntry("Write; one.\nTwo; three.\n");
    expect(baselineRose(recorded, { "a.md": atBaseline })).toBe(false);
    expect(baselineRose(recorded, {})).toBe(false);
    const oneLeft = freshEntry("Write; one.\n");
    expect(baselineRose(recorded, { "a.md": oneLeft })).toBe(false);
    const oneMore = freshEntry("Write; one.\nTwo;\nThree;\n");
    expect(baselineRose(recorded, { "a.md": oneMore })).toBe(true);
    expect(baselineRose(recorded, { "b.md": oneLeft })).toBe(true);
  });
});
