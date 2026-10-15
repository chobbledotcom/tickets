import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";
import { has, says } from "#test-utils/says.ts";
import { TEST_NAME_FILTER_ENV } from "#test-utils/test-name-filter.ts";

const FIXTURE_DIR = "test/scripts/test-name-filter/fixtures";

/** Runs one fixture through the standard preload, the way the runners do,
 * and reports the test names the TAP stream reported. The fixture's own
 * marks land in the temp file behind `TICKETS_TEST_FILTER_MARKS`, since a
 * reporter may hide a passing test's console output. */
const runFixture = async (
  fixture: string,
  filter?: string,
  options?: { withoutMarks?: boolean },
): Promise<{
  marks: string;
  names: string[];
  stdout: string;
  success: boolean;
}> => {
  const dir: TempPath = tempDir();
  try {
    const marksPath = `${dir.path}/marks.log`;
    const env = Deno.env.toObject();
    if (filter === undefined) delete env[TEST_NAME_FILTER_ENV];
    else env[TEST_NAME_FILTER_ENV] = filter;
    if (options?.withoutMarks) delete env.TICKETS_TEST_FILTER_MARKS;
    else env.TICKETS_TEST_FILTER_MARKS = marksPath;
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
      clearEnv: true,
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
    return {
      marks,
      names,
      stdout: stream,
      success,
    };
  } finally {
    dir.dispose();
  }
};

describe("a test-name filter in the test child", () => {
  test("runs only the matching leaf of a nested suite", async () => {
    const { names, success } = await runFixture("nested.ts", "leaf alpha");

    expect(success).toBe(true);
    has(names, "leaf alpha");
    assert(!names.includes("leaf beta"));
    assert(!names.includes("leaf gamma"));
    // A suite that kept nothing leaves no pass event behind.
    assert(!names.includes("empty middle"));
    assert(!names.includes("empty inner"));
  });

  test("runs a matched describe whole", async () => {
    const { names, success } = await runFixture("nested.ts", "inner group");

    expect(success).toBe(true);
    has(names, "leaf alpha");
    has(names, "leaf beta");
    assert(!names.includes("leaf gamma"));
  });

  test("matches leaves through a /regular expression/", async () => {
    const { names, success } = await runFixture(
      "nested.ts",
      "/leaf (alpha|gamma)/",
    );

    expect(success).toBe(true);
    has(names, "leaf alpha");
    has(names, "leaf gamma");
    assert(!names.includes("leaf beta"));
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
    has(names, "leaf alpha");
    has(names, "leaf beta");
    has(names, "leaf gamma");
  });

  test("runs a matched top-level it of a hooked file", async () => {
    const { marks, names, success } = await runFixture(
      "hooks.ts",
      "standalone alpha",
    );

    expect(success).toBe(true);
    has(names, "standalone alpha");
    // The hidden suite's hook runs only when something below it is kept.
    says(marks, "global hook ran\n");
    says(marks, "standalone alpha ran\n");
    assert(!marks.includes("standalone beta ran"));
    assert(!marks.includes("inner leaf ran"));
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
    has(names, "inner leaf");
    has(names, "other leaf");
    assert(!names.includes("standalone alpha"));
    says(marks, "global hook ran\n");
    assert(!marks.includes("standalone alpha ran"));
  });

  test("runs no suite-level hooks of a pruned suite", async () => {
    const { marks, names, success } = await runFixture(
      "hooks-inside.ts",
      "kept leaf",
    );

    expect(success).toBe(true);
    has(names, "kept leaf");
    assert(!names.includes("pruned leaf"));
    says(marks, "kept leaf ran\n");
    assert(!marks.includes("pruned setup ran"));
    assert(!marks.includes("pruned leaf ran"));
    assert(!marks.includes("pruned afterAll ran"));
  });

  test("keeps and drops plain Deno.test declarations by name", async () => {
    const { marks, names, success } = await runFixture(
      "plain.ts",
      "plain test",
    );

    expect(success).toBe(true);
    has(names, "plain test");
    assert(!names.includes("wrapped leaf"));
    says(marks, "plain test ran\n");
    assert(!marks.includes("wrapped leaf ran"));
  });

  test("runs a matched bdd leaf beside dropped plain tests", async () => {
    const { marks, names, success } = await runFixture(
      "plain.ts",
      "wrapped leaf",
    );

    expect(success).toBe(true);
    has(names, "wrapped leaf");
    assert(!names.includes("plain test"));
    says(marks, "wrapped leaf ran\n");
    assert(!marks.includes("plain test ran"));
  });

  test("runs a matched standalone it of a hooked file by name", async () => {
    const { marks, names, success } = await runFixture(
      "hooks.ts",
      "standalone beta",
    );

    expect(success).toBe(true);
    has(names, "standalone beta");
    says(marks, "global hook ran\n");
    says(marks, "standalone beta ran\n");
    assert(!marks.includes("standalone alpha ran"));
    assert(!marks.includes("inner leaf ran"));
  });

  test("runs a matched group's hooks and leaf when the group keeps them", async () => {
    const { marks, names, success } = await runFixture(
      "hooks-inside.ts",
      "pruned leaf",
    );

    expect(success).toBe(true);
    has(names, "pruned leaf");
    assert(!names.includes("kept leaf"));
    says(marks, "pruned setup ran\n");
    says(marks, "pruned leaf ran\n");
    says(marks, "pruned afterAll ran after 1 setups\n");
    assert(!marks.includes("kept leaf ran"));
  });

  test("fails a fixture run whose marks path is missing", async () => {
    const { stdout, success } = await runFixture("plain.ts", "plain test", {
      withoutMarks: true,
    });

    expect(success).toBe(false);
    says(stdout, "TICKETS_TEST_FILTER_MARKS is not set");
  });
});
