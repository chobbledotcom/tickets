/**
 * Servicing §20 — code quality & reuse (DRY / shared helpers).
 *
 * The mechanical guard is `deno task cpd` (jscpd at 0%), which runs as its own
 * dedicated step in both `deno task precommit` and CI — never inside the test
 * suite, where a second full jscpd subprocess would add a minute of CPU to
 * every run for a check already enforced elsewhere. These tests pin the
 * *specific* shared helpers so the feature can't land as near-duplicate logic
 * sprinkled across files.
 */
import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import {
  ATTENDEE_FIELDS,
  attendeeColumns,
} from "#shared/db/attendees/select.ts";

// Anchored to the repo root (the test runner's cwd) rather than this file's own
// location, so the source scan keeps working wherever the test file lives.
const SRC_DIR = join(Deno.cwd(), "src");

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
    expect(attendeeAdminPath({ id: 1, kind: SERVICING_KIND })).toBe(
      "/admin/servicing/1",
    );
    expect(attendeeAdminPath({ id: 1, kind: ATTENDEE_KIND })).toBe(
      "/admin/attendees/1",
    );
  });
});

describe("servicing §20 — servicing query readers reuse the shared attendee SELECT builder", () => {
  test("the servicing readers module builds on attendeeColumns with a kind predicate", async () => {
    const servicingReaderPath = join(
      SRC_DIR,
      "shared/db/attendees/servicing.ts",
    );
    const src = await readFile(servicingReaderPath);
    // The shared column builder is used and the kind predicate filters it —
    // not a copy-pasted column list. The kind is bound as a SERVICING_KIND
    // parameter (not a hard-coded SQL string) so the value can't drift from
    // the shared projection.
    expect(src).toContain("attendeeColumns");
    expect(src).toContain("SERVICING_KIND");
    // And it does NOT hand-list the attendee columns (a copy-paste giveaway).
    expect(src).not.toMatch(/attendee\.pii_blob,\s*attendee\.status_id/);
  });

  test("attendeeColumns always emits the core columns and adds only the fields asked for", () => {
    const full = attendeeColumns("inner", ATTENDEE_FIELDS);
    const none = attendeeColumns("inner", []);
    // Both carry the always-present core (identity + cheap per-listing columns),
    // so every reader projects the same base regardless of its field set.
    expect(none).toContain("attendee.pii_blob");
    expect(none).toContain("listingAttendee.listing_id");
    // The money subqueries are opt-in: `price_paid` is projected only when its
    // field is requested, so a money-free read runs none of its subqueries and
    // its column list is strictly shorter.
    expect(full).toContain("AS price_paid");
    expect(none).not.toContain("AS price_paid");
    expect(none.length).toBeLessThan(full.length);
  });
});
