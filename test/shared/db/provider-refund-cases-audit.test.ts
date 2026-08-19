import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#db/activity-log.ts";
import { execute, queryOne } from "#db/client.ts";
import { resolveProviderRefundCase } from "#db/provider-refund-case-resolution.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { addProviderRefundTestCase } from "#test-utils/provider-refund-cases.ts";
import { withTestSession } from "#test-utils/session.ts";

type StoredCase = {
  readonly refund_revision: number;
  readonly refund_state: string;
};

const storedCase = (id: number): Promise<StoredCase | null> =>
  queryOne<StoredCase>(
    `SELECT refund_revision, refund_state
       FROM payment_charges
      WHERE id = ?`,
    [id],
  );

const resolveReturned = async (id: number): Promise<void> => {
  expect(
    await resolveProviderRefundCase({
      activityMessage: `Refund recovery ${id}: owner confirmed return`,
      choice: "provider_confirmed_returned",
      id,
      privateKey: await getTestPrivateKey(),
      revision: 1,
    }),
  ).toBe("resolved");
};

describeWithEnv("provider refund case audit", { db: true }, () => {
  test("commits the owner decision and its audit entry together", async () => {
    const id = await addProviderRefundTestCase("audited-return");

    await resolveReturned(id);

    expect((await storedCase(id))?.refund_revision).toBe(2);
    expect(
      (await withTestSession(() => getAllActivityLog())).map(
        ({ message }) => message,
      ),
    ).toEqual([`Refund recovery ${id}: owner confirmed return`]);
  });

  test("rolls the owner decision back when its audit entry cannot land", async () => {
    const id = await addProviderRefundTestCase("audit-write-fails");
    const before = await storedCase(id);
    await execute(
      `CREATE TRIGGER refuse_refund_case_activity
       BEFORE INSERT ON activity_log
       BEGIN
         SELECT RAISE(ABORT, 'refund audit unavailable');
       END`,
    );

    await expect(resolveReturned(id)).rejects.toThrow(
      "refund audit unavailable",
    );

    expect(await storedCase(id)).toEqual(before);
  });
});
