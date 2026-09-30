import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import answersAtBooking from "#db/migrations/2026-09-28_answers_at_booking.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const migration = () => answersAtBooking(buildMigrationContext());

describeWithEnv("db > migrations > answers at booking", { db: true }, () => {
  test("declares the table and index it owns", () => {
    // Anything left off this list is never verified by the chain, so a
    // partial upgrade would record itself as applied.
    expect(migration().id).toBe("2026-09-28_answers_at_booking");
    expect(migration().requires).toEqual({
      indexes: ["idx_answers_at_booking_unique"],
      newTables: ["answers_at_booking"],
    });
  });
});
