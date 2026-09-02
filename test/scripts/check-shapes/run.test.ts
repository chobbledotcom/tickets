import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bodyFingerprint } from "#scripts/check-shapes/rules.ts";
import {
  ACCEPTED_DIR,
  collectSites,
  isSharedMechanism,
  MIN_TOKENS,
  readAccepted,
  runShapeCheck,
  SOURCE_DIRS,
} from "#scripts/check-shapes/run.ts";
import { capturedCheckOutput } from "#test-utils/check-script.ts";

/** A tree on disk to run the check against, removed when the test ends. */
const inTempTree = async (
  files: Record<string, string>,
  use: (root: string, acceptedDir: string) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir();
  try {
    const acceptedDir = `${root}/accepted`;
    await Deno.mkdir(`${root}/src`);
    await Deno.mkdir(acceptedDir);
    for (const [name, body] of Object.entries(files)) {
      await Deno.writeTextFile(`${root}/src/${name}`, body);
    }
    await use(`${root}/src`, acceptedDir);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

const TWINS = {
  "one.ts":
    "export const first = (a) => a.one().two().three().four().five();\n",
  "two.ts":
    "export const second = (v) => v.one().two().three().four().five();\n",
};

/** The body each twin's arrow carries, which the fingerprint is taken over. */
const TWIN_BODY = "a.one().two().three().four().five()";

/** The accepted line that covers the twins, built the way the report prints
 * it: each site named, sorted, with its body's fingerprint. */
const twinsAcceptedLine = (root: string): string =>
  `${root}/one.ts::first~${bodyFingerprint(TWIN_BODY)},${root}/two.ts::second~${bodyFingerprint(
    TWIN_BODY.replace(/^a/, "v"),
  )}`;

describe("runShapeCheck", () => {
  test("reports a pair nothing accepts, and prints the line to accept", async () => {
    await inTempTree(TWINS, async (root, acceptedDir) => {
      const output = capturedCheckOutput();
      expect(await runShapeCheck([root], acceptedDir, output)).toBe(1);
      const report = output.lines.join("\n");
      expect(report).toContain("first");
      expect(report).toContain("second");
      expect(report).toContain(`to accept: ${twinsAcceptedLine(root)}`);
    });
  });

  test("passes once the accepted list covers the pair", async () => {
    await inTempTree(TWINS, async (root, acceptedDir) => {
      await Deno.writeTextFile(
        `${acceptedDir}/a.txt`,
        `${twinsAcceptedLine(root)}  # a test pair\n`,
      );
      const output = capturedCheckOutput();
      expect(await runShapeCheck([root], acceptedDir, output)).toBe(0);
    });
  });

  test("stales an accepted entry whose body was edited, shape or no shape", async () => {
    await inTempTree(TWINS, async (root, acceptedDir) => {
      await Deno.writeTextFile(
        `${acceptedDir}/a.txt`,
        `${twinsAcceptedLine(root)}  # a test pair\n`,
      );
      // A rename keeps the shape but changes the body's text.
      await Deno.writeTextFile(
        `${root}/one.ts`,
        "export const first = (a) => a.one().two().three().four().sixth();\n",
      );
      const output = capturedCheckOutput();
      expect(await runShapeCheck([root], acceptedDir, output)).toBe(1);
      expect(output.lines.join("\n")).toContain(
        "re-read its note, then refresh its fingerprints",
      );
    });
  });

  test("fails on an accepted entry that matches nothing now", async () => {
    await inTempTree(
      { "one.ts": "export const only = (a) => a;\n" },
      async (root, acceptedDir) => {
        await Deno.writeTextFile(
          `${acceptedDir}/a.txt`,
          "src/gone.ts::a,src/gone.ts::b  # merged already\n",
        );
        const output = capturedCheckOutput();
        expect(await runShapeCheck([root], acceptedDir, output)).toBe(1);
        expect(output.lines.join("\n")).toContain("matches nothing now");
      },
    );
  });

  test("reads only .txt files from the accepted directory", async () => {
    await inTempTree(TWINS, async (_root, acceptedDir) => {
      await Deno.writeTextFile(`${acceptedDir}/notes.md`, "ignored  # nope\n");
      expect((await readAccepted(acceptedDir)).entries).toEqual([]);
    });
  });

  test("passes with nothing to say when the tree has no twins", async () => {
    await inTempTree(
      { "one.ts": "export const only = (a) => a;\n" },
      async (root, acceptedDir) => {
        const output = capturedCheckOutput();
        expect(await runShapeCheck([root], acceptedDir, output)).toBe(0);
        expect(output.lines.join("\n")).toContain("No two named functions");
      },
    );
  });

  test("refuses a file the parser cannot read whole", async () => {
    await inTempTree(
      { "broken.ts": "export const half = (a) => a.(" },
      (root) => expect(collectSites([root])).rejects.toThrow("does not parse"),
    );
  });

  test("walks the browser scripts we ship as plain .js", async () => {
    const sites = await collectSites(SOURCE_DIRS);
    expect(sites.some((site) => site.file.endsWith("client/scanner.js"))).toBe(
      true,
    );
  });

  test("leaves the shipped migrations and the built bundles out of the walk", async () => {
    const sites = await collectSites(SOURCE_DIRS);
    expect(sites.some((site) => /migrations\/2\d/.test(site.file))).toBe(false);
    expect(sites.some((site) => /ui\/static\//.test(site.file))).toBe(false);
  });

  test("compares #fp, so a body that copies one of its helpers is seen", async () => {
    const sites = await collectSites(SOURCE_DIRS);
    expect(sites.some((site) => isSharedMechanism(site.file))).toBe(true);
  });

  test("holds this repository at its accepted list", async () => {
    const output = capturedCheckOutput();
    expect(await runShapeCheck(SOURCE_DIRS, ACCEPTED_DIR, output)).toBe(0);
  });

  test("keeps the minimum a whole number of tokens above zero", () => {
    expect(MIN_TOKENS).toBeGreaterThan(0);
    expect(Number.isInteger(MIN_TOKENS)).toBe(true);
  });
});
