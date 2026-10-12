import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";
import { TEST_NAME_FILTER_ENV } from "#test-utils/test-name-filter.ts";

const FIXTURE_DIR = "test/scripts/test-name-filter/fixtures";

/** Runs one fixture through the standard preload, the way the runners do,
 * and reports the test names the TAP stream reported. The fixture's own
 * marks land in the temp file behind `TICKETS_TEST_FILTER_MARKS`, since a
 * reporter may hide a passing test's console output. */
const runFixture = async (
  fixture: string,
  filter?: string,
): Promise<{ names: string[]; marks: string; success: boolean }> => {
  const dir: TempPath = tempDir();
  try {
    const marksPath = `${dir.path}/marks.log`;
    const env = Deno.env.toObject();
    if (filter === undefined) delete env[TEST_NAME_FILTER_ENV];
    else env[TEST_NAME_FILTER_ENV] = filter;
    env.TICKETS_TEST_FILTER_MARKS = marksPath;
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--no-check",
        "--allow-all",
        "--preload",
        "./test/test-utils/preload.ts",
        "--reporter",
        "tap",
        `${FIXTURE_DIR}/${fixture}`,
      ],
      cwd: projectRoot,
      env,
      stderr: "null",
      stdout: "piped",
    });
    const { stdout, success } = await command.output();
    const stream = new TextDecoder().decode(stdout);
    const names = [...stream.matchAll(/^\s*ok\s+\d+\s+-\s+(.+)$/gm)].map(
      (match) => match[1]!,
    );
    const marks = await Deno.readTextFile(marksPath).catch((error) => {
      if (error instanceof Deno.errors.NotFound) return "";
      throw error;
    });
    return { marks, names, success };
  } finally {
    dir.dispose();
  }
};

describe("a test-name filter in the test child", () => {
  test("runs only the matching leaf of a nested suite", async () => {
    const { names, success } = await runFixture("nested.ts", "leaf alpha");

    expect(success).toBe(true);
    expect(names).toContain("leaf alpha");
    expect(names).not.toContain("leaf beta");
    expect(names).not.toContain("leaf gamma");
    // A suite that kept nothing leaves no pass event behind.
    expect(names).not.toContain("empty middle");
    expect(names).not.toContain("empty inner");
  });

  test("runs a matched describe whole", async () => {
    const { names, success } = await runFixture("nested.ts", "inner group");

    expect(success).toBe(true);
    expect(names).toContain("leaf alpha");
    expect(names).toContain("leaf beta");
    expect(names).not.toContain("leaf gamma");
  });

  test("matches leaves through a /regular expression/", async () => {
    const { names, success } = await runFixture(
      "nested.ts",
      "/leaf (alpha|gamma)/",
    );

    expect(success).toBe(true);
    expect(names).toContain("leaf alpha");
    expect(names).toContain("leaf gamma");
    expect(names).not.toContain("leaf beta");
  });

  test("matches no test and reports an empty plan", async () => {
    const { marks, names, success } = await runFixture(
      "nested.ts",
      "no such leaf",
    );

    expect(success).toBe(true);
    expect(names).toEqual([]);
    expect(marks).toBe("");
  });

  test("runs every test when no filter is set", async () => {
    const { names, success } = await runFixture("nested.ts");

    expect(success).toBe(true);
    expect(names).toContain("leaf alpha");
    expect(names).toContain("leaf beta");
    expect(names).toContain("leaf gamma");
  });

  test("runs a matched top-level it of a hooked file", async () => {
    const { marks, names, success } = await runFixture(
      "hooks.ts",
      "standalone alpha",
    );

    expect(success).toBe(true);
    expect(names).toContain("standalone alpha");
    // The hidden suite's hook runs only when something below it is kept.
    expect(marks).toContain("global hook ran\n");
    expect(marks).toContain("standalone alpha ran\n");
    expect(marks).not.toContain("standalone beta ran");
    expect(marks).not.toContain("inner leaf ran");
  });

  test("never runs a hooked file's hidden suite when nothing is kept", async () => {
    const { marks, names, success } = await runFixture(
      "hooks.ts",
      "no such leaf",
    );

    expect(success).toBe(true);
    expect(names).toEqual([]);
    expect(marks).toBe("");
  });

  test("runs a kept group of a hooked file whole", async () => {
    const { marks, names, success } = await runFixture(
      "hooks.ts",
      "hooked group",
    );

    expect(success).toBe(true);
    expect(names).toContain("inner leaf");
    expect(names).toContain("other leaf");
    expect(names).not.toContain("standalone alpha");
    expect(marks).toContain("global hook ran\n");
    expect(marks).not.toContain("standalone alpha ran");
  });

  test("runs no suite-level hooks of a pruned suite", async () => {
    const { marks, names, success } = await runFixture(
      "hooks-inside.ts",
      "kept leaf",
    );

    expect(success).toBe(true);
    expect(names).toContain("kept leaf");
    expect(names).not.toContain("pruned leaf");
    expect(marks).toContain("kept leaf ran\n");
    expect(marks).not.toContain("pruned setup ran");
    expect(marks).not.toContain("pruned leaf ran");
    expect(marks).not.toContain("pruned afterAll ran");
  });

  test("keeps and drops plain Deno.test declarations by name", async () => {
    const { marks, names, success } = await runFixture(
      "plain.ts",
      "plain test",
    );

    expect(success).toBe(true);
    expect(names).toContain("plain test");
    expect(names).not.toContain("wrapped leaf");
    expect(marks).toContain("plain test ran\n");
    expect(marks).not.toContain("wrapped leaf ran");
  });

  test("runs a matched bdd leaf beside dropped plain tests", async () => {
    const { marks, names, success } = await runFixture(
      "plain.ts",
      "wrapped leaf",
    );

    expect(success).toBe(true);
    expect(names).toContain("wrapped leaf");
    expect(names).not.toContain("plain test");
    expect(marks).toContain("wrapped leaf ran\n");
    expect(marks).not.toContain("plain test ran");
  });
});
