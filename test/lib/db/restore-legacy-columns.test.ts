import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  dumpMigrationState,
  legacyColumnRestores,
} from "#shared/db/restore-legacy-columns.ts";

describe("db > restore legacy columns", () => {
  describe("dumpMigrationState", () => {
    const KNOWN = ["2026-06-16_agent_users", "2026-07-05_first_class_images"];
    const migrationRow = (id: string): string =>
      `INSERT INTO "schema_migrations" ("id", "description", "applied_at") VALUES ('${id}', 'Adds things', '2026-07-03T10:32:24.047Z');`;

    test("a dump missing a known migration reads as pending", () => {
      expect(
        dumpMigrationState([migrationRow("2026-06-16_agent_users")], KNOWN),
      ).toEqual({ fromNewerBuild: [], hasPending: true });
    });

    test("an id dated after this build's newest migration reads as newer", () => {
      const state = dumpMigrationState(
        [migrationRow("2099-01-01_from_the_future")],
        KNOWN,
      );
      expect(state.fromNewerBuild).toEqual(["2099-01-01_from_the_future"]);
    });

    test("an unknown id sharing the newest date fails closed when nothing is pending", () => {
      // A complete dump plus an unrecognised same-day id: a same-day
      // migration from a newer build looks exactly like this, so it must be
      // refused rather than silently dropping that migration's table data.
      const state = dumpMigrationState(
        [...KNOWN, "2026-07-05_same_day_addition"].map(migrationRow),
        KNOWN,
      );
      expect(state.fromNewerBuild).toEqual(["2026-07-05_same_day_addition"]);
    });

    test("an unknown same-date id is tolerated when the dump has pending migrations", () => {
      // Pending migrations prove the dump predates this build, so a same-day
      // unrecognised id can only be an orphaned marker from a same-day
      // rename — refusing it would block a legitimate older backup.
      const state = dumpMigrationState(
        ["2026-06-16_agent_users", "2026-07-05_renamed_since"].map(
          migrationRow,
        ),
        KNOWN,
      );
      expect(state).toEqual({ fromNewerBuild: [], hasPending: true });
    });

    test("an orphaned marker from a renamed migration is tolerated", () => {
      // Real databases carry markers whose migration was later renamed (the
      // old row is never deleted). Dated within this build's history, it must
      // not read as a newer build.
      const state = dumpMigrationState(
        [...KNOWN, "2026-06-18_answer_price_modifiers"].map(migrationRow),
        KNOWN,
      );
      expect(state).toEqual({ fromNewerBuild: [], hasPending: false });
    });

    test("a dump recording exactly the known migrations has nothing pending", () => {
      expect(dumpMigrationState(KNOWN.map(migrationRow), KNOWN)).toEqual({
        fromNewerBuild: [],
        hasPending: false,
      });
    });

    test("a dump with no schema_migrations statements reads as fully pending", () => {
      expect(
        dumpMigrationState(
          [`INSERT INTO "settings" ("key", "value") VALUES ('a', 'b');`],
          KNOWN,
        ),
      ).toEqual({ fromNewerBuild: [], hasPending: true });
    });

    test("applied_at timestamps are not mistaken for migration ids", () => {
      // The row's only id-shaped literal is the id itself; the timestamp
      // ('2026-07-03T…') and description must not register as recorded ids.
      const state = dumpMigrationState(KNOWN.map(migrationRow), KNOWN);
      expect(state.fromNewerBuild).toEqual([]);
    });

    test("id-shaped literals outside schema_migrations are ignored", () => {
      const state = dumpMigrationState(
        [
          `INSERT INTO "listings" ("id", "name") VALUES (1, '2099-01-01_from_the_future');`,
        ],
        KNOWN,
      );
      expect(state.fromNewerBuild).toEqual([]);
    });
  });

  const legacyInsert = `INSERT INTO "listings" ("id", "name", "image_url") VALUES (1, 'cipher', 'img');`;

  test("re-adds a column the current schema no longer declares", () => {
    expect(legacyColumnRestores([legacyInsert])).toEqual([
      `ALTER TABLE "listings" ADD COLUMN "image_url"`,
    ]);
  });

  test("returns nothing when every dump column is still declared", () => {
    expect(
      legacyColumnRestores([
        `INSERT INTO "settings" ("key", "value") VALUES ('a', 'b');`,
      ]),
    ).toEqual([]);
  });

  test("re-adds each legacy column once across repeated statements", () => {
    expect(legacyColumnRestores([legacyInsert, legacyInsert])).toEqual([
      `ALTER TABLE "listings" ADD COLUMN "image_url"`,
    ]);
  });

  test("collects legacy columns per table across the whole dump", () => {
    const statements = [
      legacyInsert,
      `INSERT INTO "holidays" ("id", "legacy_note") VALUES (1, 'x');`,
    ];
    expect(legacyColumnRestores(statements)).toEqual([
      `ALTER TABLE "listings" ADD COLUMN "image_url"`,
      `ALTER TABLE "holidays" ADD COLUMN "legacy_note"`,
    ]);
  });

  test("ignores tables the current schema does not declare", () => {
    expect(
      legacyColumnRestores([
        `INSERT INTO "events" ("id", "image_url") VALUES (1, 'img');`,
      ]),
    ).toEqual([]);
  });

  test("ignores statements that are not exportTable-shaped INSERTs", () => {
    expect(
      legacyColumnRestores([
        "DELETE FROM listings;",
        "INSERT INTO listings (id, image_url) VALUES (1, 'unquoted');",
      ]),
    ).toEqual([]);
  });

  test("leaves a column list with a non-identifier token for the INSERT to reject", () => {
    expect(
      legacyColumnRestores([
        `INSERT INTO "listings" ("id", "bad""name") VALUES (1, 'x');`,
      ]),
    ).toEqual([]);
  });
});
