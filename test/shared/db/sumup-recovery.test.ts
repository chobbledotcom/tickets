/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { SCAN_LIMIT } from "#db/schema-anomaly-scan.ts";
import {
  applySumupRecoveryEvent,
  type DueSumupCheckout,
  delaySumupRecoveryCheck,
  getDueSumupCheckouts,
  listUnansweredSumupMoney,
} from "#db/sumup-recovery.ts";
import { SUMUP_RECOVERY_BATCH } from "#shared/limits.ts";
import { nowIso } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { plantSumupRecoveryRow, sumupRecoveryRow } from "#test-utils/sumup.ts";

/* jscpd:ignore-end */

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

describeWithEnv("db > sumup recovery queue", { db: true }, () => {
  test("takes a row whose check time has come", async () => {
    await plantSumupRecoveryRow("co_due", "waiting", PAST);

    expect(await getDueSumupCheckouts()).toEqual([
      {
        checkedAt: PAST,
        referenceIndex: "idx_co_due",
        state: "waiting",
        sumupId: "co_due",
      },
    ]);
  });

  test("leaves a row whose check time is still ahead", async () => {
    await plantSumupRecoveryRow("co_later", "waiting", FUTURE);

    expect(await getDueSumupCheckouts()).toEqual([]);
  });

  test("never takes a row nothing will ask about again", async () => {
    // staged has no checkout id to ask about; the closed states have an answer.
    await plantSumupRecoveryRow("", "staged", null);
    await plantSumupRecoveryRow("co_unpaid", "unpaid", null);
    await plantSumupRecoveryRow("co_finished", "finished", null);

    expect(await getDueSumupCheckouts()).toEqual([]);
  });

  test("takes a row that is still owed money", async () => {
    await plantSumupRecoveryRow("co_owed", "owed", PAST);

    expect((await getDueSumupCheckouts())[0]?.state).toBe("owed");
  });

  test("takes the checkouts due longest first", async () => {
    await plantSumupRecoveryRow(
      "co_second",
      "waiting",
      "2000-01-02T00:00:00.000Z",
    );
    await plantSumupRecoveryRow(
      "co_first",
      "waiting",
      "2000-01-01T00:00:00.000Z",
    );

    expect((await getDueSumupCheckouts()).map((one) => one.sumupId)).toEqual([
      "co_first",
      "co_second",
    ]);
  });

  test("takes no more than one run's worth", async () => {
    for (let index = 0; index <= SUMUP_RECOVERY_BATCH; index++) {
      await plantSumupRecoveryRow(`co_many_${index}`, "waiting", PAST);
    }

    expect(await getDueSumupCheckouts()).toHaveLength(SUMUP_RECOVERY_BATCH);
  });

  test("does not act on a row whose state the machine does not have", async () => {
    // The queue reads only known states. The live scan reports this row instead.
    await plantSumupRecoveryRow("co_bogus", "abandoned", PAST);
    await plantSumupRecoveryRow("co_real", "waiting", PAST);

    expect((await getDueSumupCheckouts()).map((one) => one.sumupId)).toEqual([
      "co_real",
    ]);
  });

  const due = (id: string, state: string): DueSumupCheckout => ({
    checkedAt: PAST,
    referenceIndex: `idx_${id}`,
    state: state as DueSumupCheckout["state"],
    sumupId: id,
  });

  test("moves a row on and books its next check", async () => {
    await plantSumupRecoveryRow("co_move", "waiting", PAST);

    expect(
      await applySumupRecoveryEvent(due("co_move", "waiting"), "read_pending"),
    ).toBe(true);

    const row = await sumupRecoveryRow("co_move");
    expect(row.state).toBe("waiting");
    expect(Date.parse(row.nextCheckAt ?? "")).toBeGreaterThan(Date.now());
  });

  test("gives a closed row no next check at all", async () => {
    await plantSumupRecoveryRow("co_close", "waiting", PAST);

    await applySumupRecoveryEvent(
      due("co_close", "waiting"),
      "read_paid_booked",
    );

    expect(await sumupRecoveryRow("co_close")).toEqual({
      nextCheckAt: null,
      state: "finished",
    });
  });

  test("writes nothing when the row moved since it was read", async () => {
    await plantSumupRecoveryRow(
      "co_moved",
      "waiting",
      "2000-01-05T00:00:00.000Z",
    );

    // The caller read it at a check time it no longer has.
    expect(
      await applySumupRecoveryEvent(due("co_moved", "waiting"), "read_pending"),
    ).toBe(false);
    expect((await sumupRecoveryRow("co_moved")).nextCheckAt).toBe(
      "2000-01-05T00:00:00.000Z",
    );
  });

  test("writes only its own row when two rows share a checkout id", async () => {
    // The provider reusing an id must not let one row's move write the
    // other's clock too — the write names the row by its own index.
    await plantSumupRecoveryRow("co_twin", "waiting", PAST);
    await plantSumupRecoveryRow("co_other", "waiting", PAST);
    await execute(
      "UPDATE sumup_checkouts SET sumup_id = 'co_twin' WHERE reference_index = 'idx_co_other'",
    );

    expect(
      await applySumupRecoveryEvent(due("co_twin", "waiting"), "read_pending"),
    ).toBe(true);

    // The twin kept the check time it was read with.
    const twin = await execute(
      "SELECT next_check_at FROM sumup_checkouts WHERE reference_index = 'idx_co_other'",
    );
    expect(String(twin.rows[0]!.next_check_at)).toBe(PAST);
  });

  test("refuses a move the machine does not allow", async () => {
    await plantSumupRecoveryRow("co_shut", "finished", null);

    await expect(
      applySumupRecoveryEvent(due("co_shut", "finished"), "read_pending"),
    ).rejects.toThrow("A finished SumUp checkout refuses read_pending");
  });

  test("delays a failed row's next check without moving its state", async () => {
    await plantSumupRecoveryRow("co_delay", "waiting", PAST);

    await delaySumupRecoveryCheck(due("co_delay", "waiting"));

    const row = await sumupRecoveryRow("co_delay");
    expect(row.state).toBe("waiting");
    expect(Date.parse(row.nextCheckAt ?? "")).toBeGreaterThan(Date.now());
  });

  test("delays nothing when the row moved since it was read", async () => {
    await plantSumupRecoveryRow(
      "co_delay_moved",
      "waiting",
      "2000-01-05T00:00:00.000Z",
    );

    // The caller read it at a check time it no longer has.
    await delaySumupRecoveryCheck(due("co_delay_moved", "waiting"));

    expect((await sumupRecoveryRow("co_delay_moved")).nextCheckAt).toBe(
      "2000-01-05T00:00:00.000Z",
    );
  });
});

describeWithEnv("db > unanswered sumup money", { db: true }, () => {
  test("answers all-clear on a clean database", async () => {
    expect(await listUnansweredSumupMoney()).toEqual({ rows: [], total: 0 });
  });

  test("lists an owed row however young it is", async () => {
    const createdAt = nowIso();
    await plantSumupRecoveryRow("co_owed_now", "owed", FUTURE, createdAt);

    expect(await listUnansweredSumupMoney()).toEqual({
      rows: [{ createdAt, referenceIndex: "idx_co_owed_now", state: "owed" }],
      total: 1,
    });
  });

  test("lists a waiting row only once it is old", async () => {
    await plantSumupRecoveryRow("co_wait_young", "waiting", FUTURE, nowIso());
    await plantSumupRecoveryRow("co_wait_old", "waiting", FUTURE);

    expect(await listUnansweredSumupMoney()).toEqual({
      rows: [
        {
          createdAt: "2026-08-01T00:00:00.000Z",
          referenceIndex: "idx_co_wait_old",
          state: "waiting",
        },
      ],
      total: 1,
    });
  });

  test("never lists a row with a clear answer, however old", async () => {
    await plantSumupRecoveryRow("", "staged", null);
    await plantSumupRecoveryRow("co_no_pay", "unpaid", null);
    await plantSumupRecoveryRow("co_done", "finished", null);

    expect(await listUnansweredSumupMoney()).toEqual({ rows: [], total: 0 });
  });

  test("counts every row but lists only the oldest sample", async () => {
    const values = Array.from(
      { length: SCAN_LIMIT + 1 },
      (_, index) =>
        `('idx_bulk_${String(index).padStart(2, "0")}', '', '', 'co_bulk_${index}',
          '2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z', 'owed', '${FUTURE}')`,
    );
    await execute(
      `INSERT INTO sumup_checkouts
         (reference_index, wrapped_key, metadata, sumup_id, created_at,
          recovery_state, next_check_at)
       VALUES ${values.join(", ")}`,
    );

    const unanswered = await listUnansweredSumupMoney();
    expect(unanswered.total).toBe(SCAN_LIMIT + 1);
    expect(unanswered.rows).toHaveLength(SCAN_LIMIT);
    // Oldest first: the newest row is the one the bound leaves out.
    expect(unanswered.rows[0]?.referenceIndex).toBe("idx_bulk_00");
    expect(
      unanswered.rows.some(
        (row) => row.referenceIndex === `idx_bulk_${SCAN_LIMIT}`,
      ),
    ).toBe(false);
  });

  test("refuses a stored word the machine does not have", async () => {
    // An unknown word in a listed row means the database and this code
    // disagree — raised, never shown as a state the operator can trust.
    await plantSumupRecoveryRow("co_owed_ok", "owed", FUTURE);
    await execute(
      "UPDATE sumup_checkouts SET recovery_state = 'owing' WHERE sumup_id = 'co_owed_ok'",
    );
    // The unknown word is outside the listed states, so it is simply not
    // counted — the live check reports it as an anomaly instead.
    expect(await listUnansweredSumupMoney()).toEqual({ rows: [], total: 0 });
  });
});
