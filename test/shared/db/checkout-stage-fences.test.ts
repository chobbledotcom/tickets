import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import checkoutStagePaymentFencesMigration from "#shared/db/migrations/2026-07-16_checkout_stage_payment_fences.ts";
import {
  CHECKOUT_STAGE_PAYMENT_FENCE_TRIGGERS,
  CHECKOUT_STAGE_REVISION_TRIGGERS,
} from "#shared/db/migrations/schema/checkout-stage-triggers.ts";
import {
  applySchemaChanges,
  syncTriggers,
} from "#shared/db/migrations/schema-sync.ts";
import { additive, verifyRequirement } from "#shared/db/migrations/verify.ts";
import {
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

type StageState = "pending" | "refunding" | "booked" | "failed";

const insertStage = (
  sessionId: string,
  attendeeId: number,
  state: StageState = "pending",
): Promise<unknown> =>
  getDb().execute({
    args: [sessionId, attendeeId, state],
    sql: `INSERT INTO checkout_stages
      (payment_session_id, attendee_id, provider, ticket_tokens, state, created_at)
      VALUES (?, ?, 'stripe', '["ticket-1"]', ?, '2026-07-16T12:00:00Z')`,
  });

const fenceNames = CHECKOUT_STAGE_PAYMENT_FENCE_TRIGGERS.map(
  (trigger) => trigger.name,
);
const migrationContext = buildMigrationContext({
  additive,
  applySchemaChanges,
  syncTriggers,
  verifyRequirement,
});

describeWithEnv("db > checkout stage payment fences", { db: true }, () => {
  test("rejects a legacy reservation without the staged attendee claim", async () => {
    const sessionId = "cs_legacy_reservation";
    await insertStage(sessionId, 42);

    await expect(
      getDb().execute({
        args: [sessionId],
        sql: `INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at)
          VALUES (?, NULL, '2026-07-16T12:01:00Z')`,
      }),
    ).rejects.toThrow("checkout stage claim does not match");
    expect(await isSessionProcessed(sessionId)).toBeNull();
  });

  test("rejects a reservation with a different staged attendee claim", async () => {
    const sessionId = "cs_wrong_claim";
    await insertStage(sessionId, 42);

    await expect(
      getDb().execute({
        args: [sessionId],
        sql: `INSERT INTO processed_payments
          (payment_session_id, attendee_id, checkout_stage_attendee_id, processed_at)
          VALUES (?, NULL, 43, '2026-07-16T12:01:00Z')`,
      }),
    ).rejects.toThrow("checkout stage claim does not match");
    expect(await isSessionProcessed(sessionId)).toBeNull();
  });

  test("reserveSession records the staged attendee claim", async () => {
    const sessionId = "cs_current_reservation";
    await insertStage(sessionId, 42);

    expect(await reserveSession(sessionId)).toEqual({ reserved: true });
    expect(await isSessionProcessed(sessionId)).toMatchObject({
      attendee_id: null,
      checkout_stage_attendee_id: 42,
      payment_session_id: sessionId,
    });
  });

  test("reserveSession records null when the session has no stage", async () => {
    const sessionId = "cs_unstaged_reservation";

    expect(await reserveSession(sessionId)).toEqual({ reserved: true });
    await getDb().execute(
      "UPDATE processed_payments SET attendee_id = 43 WHERE payment_session_id = ?",
      [sessionId],
    );
    expect(await isSessionProcessed(sessionId)).toMatchObject({
      attendee_id: 43,
      checkout_stage_attendee_id: null,
      payment_session_id: sessionId,
    });
  });

  test("rejects updating an open stage onto another attendee without changing the reservation", async () => {
    const sessionId = "cs_wrong_update";
    await insertStage(sessionId, 42);
    await reserveSession(sessionId);

    await expect(
      getDb().execute(
        "UPDATE processed_payments SET attendee_id = 43 WHERE payment_session_id = ?",
        [sessionId],
      ),
    ).rejects.toThrow("open checkout stage belongs to another attendee");
    expect(await isSessionProcessed(sessionId)).toMatchObject({
      attendee_id: null,
      checkout_stage_attendee_id: 42,
    });
  });

  test("rejects inserting a finalized payment for another attendee", async () => {
    const sessionId = "cs_wrong_insert";
    await insertStage(sessionId, 42);

    await expect(
      getDb().execute({
        args: [sessionId],
        sql: `INSERT INTO processed_payments
          (payment_session_id, attendee_id, checkout_stage_attendee_id, processed_at)
          VALUES (?, 43, 42, '2026-07-16T12:01:00Z')`,
      }),
    ).rejects.toThrow("open checkout stage belongs to another attendee");
    expect(await isSessionProcessed(sessionId)).toBeNull();
  });

  test("allows finalizing an open stage onto its matching attendee", async () => {
    const sessionId = "cs_matching_finalize";
    await insertStage(sessionId, 42);
    await reserveSession(sessionId);

    await getDb().execute(
      "UPDATE processed_payments SET attendee_id = 42 WHERE payment_session_id = ?",
      [sessionId],
    );

    expect(await isSessionProcessed(sessionId)).toMatchObject({
      attendee_id: 42,
      checkout_stage_attendee_id: 42,
    });
  });

  test("allows inserting a finalized payment for the staged attendee", async () => {
    const sessionId = "cs_matching_insert";
    await insertStage(sessionId, 42);

    await getDb().execute({
      args: [sessionId],
      sql: `INSERT INTO processed_payments
        (payment_session_id, attendee_id, checkout_stage_attendee_id, processed_at)
        VALUES (?, 42, 42, '2026-07-16T12:01:00Z')`,
    });

    expect(await isSessionProcessed(sessionId)).toMatchObject({
      attendee_id: 42,
      checkout_stage_attendee_id: 42,
    });
  });

  test("treats refunding stages as open", async () => {
    const sessionId = "cs_refunding_finalize";
    await insertStage(sessionId, 42, "refunding");
    await reserveSession(sessionId);

    await expect(
      getDb().execute(
        "UPDATE processed_payments SET attendee_id = 43 WHERE payment_session_id = ?",
        [sessionId],
      ),
    ).rejects.toThrow("open checkout stage belongs to another attendee");
  });

  for (const state of ["booked", "failed"] as const) {
    test(`allows a different attendee after the stage is ${state}`, async () => {
      const sessionId = `cs_closed_${state}`;
      await insertStage(sessionId, 42, state);
      await reserveSession(sessionId);

      await getDb().execute(
        "UPDATE processed_payments SET attendee_id = 43 WHERE payment_session_id = ?",
        [sessionId],
      );

      expect((await isSessionProcessed(sessionId))?.attendee_id).toBe(43);
    });
  }

  test("the migration installs and verifies the claim column and payment fences", async () => {
    for (const name of fenceNames) {
      await getDb().execute(`DROP TRIGGER ${name}`);
    }
    const migration = checkoutStagePaymentFencesMigration(migrationContext);

    expect(migration.id).toBe("2026-07-16_checkout_stage_payment_fences");
    expect(migration.description).toBe(
      "Claim staged attendees when reserving payments and reject rollback-era mismatches.",
    );
    expect(migration.requires).toEqual({
      columns: {
        processed_payments: ["checkout_stage_attendee_id"],
      },
      triggers: fenceNames,
    });
    await migration.up();
    await migration.verify();

    const columns = await getDb().execute(
      "PRAGMA table_info(processed_payments)",
    );
    expect(
      columns.rows.find(
        (column) => column.name === "checkout_stage_attendee_id",
      ),
    ).toEqual({
      cid: 2,
      dflt_value: null,
      name: "checkout_stage_attendee_id",
      notnull: 0,
      pk: 0,
      type: "INTEGER",
    });
    const triggers = await getDb().execute(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'processed_payments' ORDER BY name",
    );
    expect(triggers.rows.map((row) => row.name)).toEqual(
      [...fenceNames].sort(),
    );
  });

  test("trigger sync waits for checkout stage storage", async () => {
    for (const trigger of [
      ...CHECKOUT_STAGE_REVISION_TRIGGERS,
      ...CHECKOUT_STAGE_PAYMENT_FENCE_TRIGGERS,
    ]) {
      await getDb().execute(`DROP TRIGGER ${trigger.name}`);
    }
    await getDb().execute("DROP TABLE checkout_stages");

    await syncTriggers();

    const triggers = await getDb().execute(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'processed_payments' ORDER BY name",
    );
    expect(triggers.rows).toEqual([]);
  });
});
