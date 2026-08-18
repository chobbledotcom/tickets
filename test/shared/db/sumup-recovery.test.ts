/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import {
  applySumupRecoveryEvent,
  type DueSumupCheckout,
  delaySumupRecoveryCheck,
  getDueSumupCheckouts,
} from "#shared/db/sumup-recovery.ts";
import { SUMUP_RECOVERY_BATCH } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { sumupRecoveryRow } from "#test-utils/sumup.ts";

/* jscpd:ignore-end */

/** A staged row written straight to the table — this suite is about the queue
 * and the fenced write, not about how a row comes to exist. */
const seedRow = (
  id: string,
  state: string,
  nextCheckAt: string | null,
): Promise<unknown> =>
  execute(
    `INSERT INTO sumup_checkouts
       (reference_index, wrapped_key, metadata, sumup_id, created_at,
        recovery_state, next_check_at)
     VALUES (?, '', '', ?, '2026-08-01T00:00:00.000Z', ?, ?)`,
    [`idx_${id}`, id, state, nextCheckAt],
  );

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

describeWithEnv("db > sumup recovery queue", { db: true }, () => {
  test("takes a row whose check time has come", async () => {
    await seedRow("co_due", "waiting", PAST);

    expect(await getDueSumupCheckouts()).toEqual([
      { checkedAt: PAST, state: "waiting", sumupId: "co_due" },
    ]);
  });

  test("leaves a row whose check time is still ahead", async () => {
    await seedRow("co_later", "waiting", FUTURE);

    expect(await getDueSumupCheckouts()).toEqual([]);
  });

  test("never takes a row nothing will ask about again", async () => {
    // staged has no checkout id to ask about; the closed states have an answer.
    await seedRow("", "staged", null);
    await seedRow("co_unpaid", "unpaid", null);
    await seedRow("co_finished", "finished", null);

    expect(await getDueSumupCheckouts()).toEqual([]);
  });

  test("takes a row that is still owed money", async () => {
    await seedRow("co_owed", "owed", PAST);

    expect((await getDueSumupCheckouts())[0]?.state).toBe("owed");
  });

  test("takes the checkouts due longest first", async () => {
    await seedRow("co_second", "waiting", "2000-01-02T00:00:00.000Z");
    await seedRow("co_first", "waiting", "2000-01-01T00:00:00.000Z");

    expect((await getDueSumupCheckouts()).map((one) => one.sumupId)).toEqual([
      "co_first",
      "co_second",
    ]);
  });

  test("takes no more than one run's worth", async () => {
    for (let index = 0; index <= SUMUP_RECOVERY_BATCH; index++) {
      await seedRow(`co_many_${index}`, "waiting", PAST);
    }

    expect(await getDueSumupCheckouts()).toHaveLength(SUMUP_RECOVERY_BATCH);
  });

  test("does not act on a row whose state the machine does not have", async () => {
    // The queue asks for the states it knows, so a word nothing here wrote is
    // never picked up and acted on. It is not deleted either — pruning names
    // the same known states — so it waits to be found rather than being
    // guessed at. Surfacing it to the operator is the live check's job, which
    // is the next slice; the parse on the way in is what keeps the stored
    // word a typed state rather than an unchecked string.
    await seedRow("co_bogus", "abandoned", PAST);
    await seedRow("co_real", "waiting", PAST);

    expect((await getDueSumupCheckouts()).map((one) => one.sumupId)).toEqual([
      "co_real",
    ]);
  });

  const due = (id: string, state: string): DueSumupCheckout => ({
    checkedAt: PAST,
    state: state as DueSumupCheckout["state"],
    sumupId: id,
  });

  test("moves a row on and books its next check", async () => {
    await seedRow("co_move", "waiting", PAST);

    expect(
      await applySumupRecoveryEvent(due("co_move", "waiting"), "read_pending"),
    ).toBe(true);

    const row = await sumupRecoveryRow("co_move");
    expect(row.state).toBe("waiting");
    expect(Date.parse(row.nextCheckAt ?? "")).toBeGreaterThan(Date.now());
  });

  test("gives a closed row no next check at all", async () => {
    await seedRow("co_close", "waiting", PAST);

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
    await seedRow("co_moved", "waiting", "2000-01-05T00:00:00.000Z");

    // The caller read it at a check time it no longer has.
    expect(
      await applySumupRecoveryEvent(due("co_moved", "waiting"), "read_pending"),
    ).toBe(false);
    expect((await sumupRecoveryRow("co_moved")).nextCheckAt).toBe(
      "2000-01-05T00:00:00.000Z",
    );
  });

  test("refuses a move the machine does not allow", async () => {
    await seedRow("co_shut", "finished", null);

    await expect(
      applySumupRecoveryEvent(due("co_shut", "finished"), "read_pending"),
    ).rejects.toThrow("A finished SumUp checkout refuses read_pending");
  });

  test("delays a failed row's next check without moving its state", async () => {
    await seedRow("co_delay", "waiting", PAST);

    await delaySumupRecoveryCheck(due("co_delay", "waiting"));

    const row = await sumupRecoveryRow("co_delay");
    expect(row.state).toBe("waiting");
    expect(Date.parse(row.nextCheckAt ?? "")).toBeGreaterThan(Date.now());
  });

  test("delays nothing when the row moved since it was read", async () => {
    await seedRow("co_delay_moved", "waiting", "2000-01-05T00:00:00.000Z");

    // The caller read it at a check time it no longer has.
    await delaySumupRecoveryCheck(due("co_delay_moved", "waiting"));

    expect((await sumupRecoveryRow("co_delay_moved")).nextCheckAt).toBe(
      "2000-01-05T00:00:00.000Z",
    );
  });
});
