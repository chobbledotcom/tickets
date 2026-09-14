import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import groupShowHiddenListings from "#db/migrations/2026-09-14_group_show_hidden_listings.ts";
import {
  applySchemaChanges,
  getExistingColumns,
  syncIndexes,
} from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const migration = () => groupShowHiddenListings(context);

describeWithEnv(
  "db > migrations > group show hidden listings",
  { db: true },
  () => {
    test("adds the flag so a stored group keeps showing its hidden members", async () => {
      await getDb().execute(
        "INSERT INTO groups (id, slug, slug_index, name) VALUES (9091, 'hidden-flag-group', 'hidden-flag-index', 'Hidden Flag Group')",
      );
      await getDb().execute(
        "ALTER TABLE groups DROP COLUMN show_hidden_listings",
      );

      await migration().up();

      expect(
        (await getExistingColumns("groups")).has("show_hidden_listings"),
      ).toBe(true);
      const result = await getDb().execute(
        "SELECT show_hidden_listings FROM groups WHERE id = 9091",
      );
      // DEFAULT 1 is the compatibility promise: an upgraded site's groups keep
      // offering their hidden members until each group opts out.
      expect(Number(result.rows[0]?.show_hidden_listings)).toBe(1);
    });

    test("declares every object it owns", () => {
      // Anything left off this list is never verified, so a partial upgrade
      // would record itself as applied.
      expect(migration().id).toBe("2026-09-14_group_show_hidden_listings");
      expect(migration().requires).toEqual({
        columns: { groups: ["show_hidden_listings"] },
      });
    });
  },
);
