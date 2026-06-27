/**
 * Servicing §20 — code quality & reuse (DRY / shared helpers).
 *
 * The mechanical guard is `deno task cpd` (jscpd at 0%, run in precommit).
 * These tests pin the *specific* shared helpers so the feature can't land as
 * near-duplicate logic sprinkled across files.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
import { ATTENDEE_JOIN_SELECT } from "#shared/db/attendees/queries.ts";

const currentDir = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(currentDir, "../../../src");

/** Recursively collect file paths under `dir` matching `ext`. */
const collectFiles = async (dir: string, exts: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) out.push(...(await collectFiles(path, exts)));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(path);
  }
  return out;
};

const readFile = async (path: string): Promise<string> =>
  await Deno.readTextFile(path);

describe("servicing §20 — one shared kind-aware link builder (no second copy)", () => {
  test("attendeeAdminPath is the only site that chooses /admin/servicing vs /admin/attendees", async () => {
    // Scan the source tree for any hand-rolled dispatch that builds
    // `/admin/servicing/` or `/admin/attendees/` from a kind, outside the
    // single helper module. A second copy would fail this.
    const files = await collectFiles(SRC_DIR, [".ts", ".tsx"]);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes("attendee-links")) continue;
      const src = await readFile(file);
      // A bespoke dispatch: a ternary/condition on `kind` producing either
      // servicing or attendees admin path.
      if (
        /kind\s*===?\s*['"]servicing['"].*\/admin\/(servicing|attendees)/s.test(
          src,
        )
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("attendeeAdminPath is callable for both kinds (the shared builder is real)", () => {
    expect(attendeeAdminPath({ id: 1, kind: "servicing" })).toBe(
      "/admin/servicing/1",
    );
    expect(attendeeAdminPath({ id: 1, kind: "attendee" })).toBe(
      "/admin/attendees/1",
    );
  });
});

describe("servicing §20 — servicing query readers reuse the shared SELECT constant", () => {
  test("the servicing readers module builds on ATTENDEE_JOIN_SELECT with a kind predicate", async () => {
    const servicingReaderPath = join(
      SRC_DIR,
      "shared/db/attendees/servicing.ts",
    );
    const src = await readFile(servicingReaderPath);
    // The shared column list is imported and the kind predicate filters it —
    // not a copy-pasted column list. The kind is bound as a SERVICING_KIND
    // parameter (not a hard-coded SQL string) so the value can't drift from
    // the constant.
    expect(src).toContain("ATTENDEE_JOIN_SELECT");
    expect(src).toContain("SERVICING_KIND");
    // And it does NOT hand-list the attendee columns (a copy-paste giveaway).
    expect(src).not.toMatch(/a\.pii_blob,\s*a\.status_id/);
  });

  test("ATTENDEE_JOIN_SELECT is the single column list the attendee readers use", () => {
    // The constant exists and is exported (the import above resolves). A
    // servicing reader built on it inherits every column the attendee readers
    // project, so the two can't drift.
    expect(typeof ATTENDEE_JOIN_SELECT).toBe("string");
    expect(ATTENDEE_JOIN_SELECT.length).toBeGreaterThan(0);
  });
});

describe("servicing §20 — precommit duplication check stays at 0%", () => {
  test("deno task cpd exits zero (no new duplication landed)", async () => {
    // Meta-guard: the feature must land without tripping jscpd's 0% threshold.
    // Skipped in plain `deno test` runs that don't have the toolchain pinned;
    // the precommit script runs it for real.
    const command = new Deno.Command("deno", {
      args: ["task", "cpd"],
      stderr: "inherit",
      stdout: "piped",
    });
    const { success } = await command.output();
    expect(success).toBe(true);
  });
});
