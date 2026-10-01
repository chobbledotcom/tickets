import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import squareLinkEnds from "#db/migrations/2026-10-01_square_link_ends.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const migration = () => squareLinkEnds(buildMigrationContext());

describeWithEnv("db > migrations > square link ends", { db: true }, () => {
  test("declares the table it owns", () => {
    // Anything left off this list is never verified by the chain, so a
    // partial upgrade would record itself as applied.
    expect(migration().id).toBe("2026-10-01_square_link_ends");
    expect(migration().requires).toEqual({
      indexes: ["idx_square_link_ends_next_attempt"],
      newTables: ["square_link_ends"],
    });
  });
});
