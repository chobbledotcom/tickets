/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import {
  applySumupRecoveryEvent,
  type DueSumupCheckout,
  delaySumupRecoveryCheck,
  getDueSumupCheckouts,
} from "#db/sumup-recovery.ts";
import { SUMUP_RECOVERY_BATCH } from "#shared/limits.ts";
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
