/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { getDb, update } from "#shared/db/client.ts";
import { storePaymentReference } from "#shared/db/payment-reference-store.ts";
import { resolveProviderRefundCase } from "#shared/db/provider-refund-case-resolution.ts";
import {
  listProviderRefundCases,
  loadProviderRefundCase,
} from "#shared/db/provider-refund-cases.ts";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundLocalRecorded,
  markRefundObservationDue,
} from "#shared/payment/refund-authority.ts";
import { markRefundProviderConflict } from "#shared/payment/refund-authority-choice.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { historicalPaymentReferenceStorage } from "#test-utils/historical-payment-references.ts";
import {
  addProviderRefundTestCase,
  ownerRefundChoiceTestState,
  readyRefundTestState,
} from "#test-utils/provider-refund-cases.ts";

/* jscpd:ignore-end */

type CorruptibleCaseColumn =
  | "capability"
  | "captured_amount"
  | "currency"
  | "provider"
  | "provider_reference"
  | "reference_index"
  | "refund_local_state"
  | "refund_revision"
  | "refund_state_name"
  | "refunded_amount"
  | "updated_at";

const createdIds = new Set<number>();

const addCase = async (
  ...input: Parameters<typeof addProviderRefundTestCase>
): Promise<number> => {
  const id = await addProviderRefundTestCase(...input);
  createdIds.add(id);
  return id;
};

const discardCase = async (id: number): Promise<void> => {
  await getDb().execute({
    args: [id],
    sql: "DELETE FROM payment_charges WHERE id = ?",
  });
  createdIds.delete(id);
};

const corruptCase = async (
  id: number,
  column: CorruptibleCaseColumn,
  value: number | string,
): Promise<void> => {
  const db = getDb();
  await db.execute("PRAGMA ignore_check_constraints = true");
  try {
    await db.execute(update("payment_charges", { [column]: value }, { id }));
  } finally {
    await db.execute("PRAGMA ignore_check_constraints = false");
  }
};

type ReadCorruptCase = (id: number) => Promise<unknown>;

const expectCorruptCaseFailure = async (
  column: CorruptibleCaseColumn,
  value: number | string,
  message: string,
  read: ReadCorruptCase,
): Promise<void> => {
  const id = await addCase(`bad-${column}`);
  try {
    await corruptCase(id, column, value);
    await expect(read(id)).rejects.toThrow(message);
  } finally {
    await discardCase(id);
  }
};

const expectQueueFailure = (
  column: CorruptibleCaseColumn,
  value: number | string,
  message: string,
): Promise<void> =>
  expectCorruptCaseFailure(
    column,
    value,
    message,
    () => listProviderRefundCases(),
  );

const expectDetailFailure = (
  column: CorruptibleCaseColumn,
  value: number | string,
  message: string,
): Promise<void> =>
  expectCorruptCaseFailure(
    column,
    value,
    message,
    async (id) => await loadProviderRefundCase(id, await getTestPrivateKey()),
  );

describeWithEnv("provider refund case validation", { db: true }, () => {
  afterEach(async () => {
    await Promise.all([...createdIds].map(discardCase));
  });

  test("accepts every owner-work state named by the lifecycle", async () => {
    const ready = readyRefundTestState("valid-ready");
    const armed = armRefundSend(ready, 11, 20);
    const states = [
      ready,
      armed,
      markRefundObservationDue(armed, 12, 30),
      markRefundCompleted(ready, 13, "provider"),
      ownerRefundChoiceTestState("valid-owner-choice"),
      markRefundProviderConflict(ready, 14, {
        captured: { amount: 2_500, currency: "GBP" },
        kind: "wait",
        refunded: { amount: 0, currency: "GBP" },
      }),
    ];
    await Promise.all(
      states.map((state, index) => addCase(`valid-state-${index}`, state)),
    );

    expect(
      new Set(
        (await listProviderRefundCases()).cases.map(({ state }) => state),
      ),
    ).toEqual(
      new Set([
        "ready",
        "send_armed",
        "observing",
        "completed",
        "needs_owner_choice",
        "needs_provider_check",
      ]),
    );
  });

  test("rejects fractional or negative whole-number columns", async () => {
    await expectQueueFailure(
      "refund_revision",
      1.5,
      "payment_charges.refund_revision is not a safe whole number",
    );
    await expectQueueFailure(
      "updated_at",
      -1,
      "payment_charges.updated_at is not a safe whole number",
    );
  });

  test("the database driver refuses an integer JavaScript cannot represent", async () => {
    const id = await addCase("unsafe-integer");
    await corruptCase(id, "refund_revision", Number.MAX_SAFE_INTEGER + 1);

    await expect(listProviderRefundCases()).rejects.toThrow(
      "Received integer which cannot be safely represented as a JavaScript number",
    );
  });

  test("rejects invalid summary facts", async () => {
    await expectQueueFailure(
      "provider",
      "paypal",
      "payment_charges.provider is invalid",
    );
    await expectQueueFailure(
      "currency",
      "GB",
      "payment_charges captured money is invalid",
    );
  });

  test("the owner-work query excludes an unknown state name", async () => {
    const id = await addCase("unknown-state");
    await corruptCase(id, "refund_state_name", "lost");

    expect(
      (await listProviderRefundCases()).cases.some((entry) => entry.id === id),
    ).toBe(false);
  });

  for (
    const [name, column, value, message] of [
      [
        "state name",
        "refund_state_name",
        "ready",
        "Payment charge refund-state mirrors do not match",
      ],
      [
        "local state",
        "refund_local_state",
        "due",
        "Payment charge refund-state mirrors do not match",
      ],
      [
        "request capability",
        "capability",
        "keyed",
        "Payment charge refund-state mirrors do not match",
      ],
      [
        "provider capability",
        "provider",
        "stripe",
        "Payment charge refund capability does not match provider",
      ],
    ] as const
  ) {
    test(`rejects a ${name} mirror which disagrees with state`, async () => {
      await expectDetailFailure(column, value, message);
    });
  }

  test("rejects an old unqualified owner-key reference", async () => {
    const id = await addCase("old-reference");
    const old = await historicalPaymentReferenceStorage("old-reference");
    await corruptCase(id, "provider_reference", old.encrypted);
    await corruptCase(id, "reference_index", old.index);

    await expect(
      loadProviderRefundCase(id, await getTestPrivateKey()),
    ).rejects.toThrow("Payment charge reference is not provider-qualified");
  });

  test("rejects a reference encrypted for a different provider", async () => {
    const id = await addCase("wrong-provider-reference");
    const wrong = await storePaymentReference({
      kind: "tagged",
      provider: "stripe",
      reference: "wrong-provider-reference",
    });
    await corruptCase(id, "provider_reference", wrong.encrypted);

    await expect(
      loadProviderRefundCase(id, await getTestPrivateKey()),
    ).rejects.toThrow(
      "Payment charge reference does not match its blind index",
    );
  });

  test("rejects a reference whose blind identity changed", async () => {
    const id = await addCase("wrong-reference-index");
    await corruptCase(id, "reference_index", "not-the-reference-index");

    await expect(
      loadProviderRefundCase(id, await getTestPrivateKey()),
    ).rejects.toThrow(
      "Payment charge reference does not match its blind index",
    );
  });

  test("treats malformed detail ids as absent", async () => {
    const privateKey = await getTestPrivateKey();
    expect(await loadProviderRefundCase(0, privateKey)).toBeNull();
    expect(await loadProviderRefundCase(Number.NaN, privateKey)).toBeNull();
  });

  test("rejects malformed resolution identities before querying", async () => {
    const privateKey = await getTestPrivateKey();
    for (
      const input of [
        { id: 0, revision: 1 },
        { id: Number.NaN, revision: 1 },
        { id: 1, revision: 0 },
        { id: 1, revision: Number.NaN },
      ]
    ) {
      await expect(
        resolveProviderRefundCase({
          ...input,
          activityMessage: "Invalid refund case identity",
          choice: "provider_confirmed_returned",
          privateKey,
        }),
      ).rejects.toThrow(
        "Refund-case id and revision must be positive safe integers",
      );
    }
  });

  test("rejects an owner decision without an audit message", async () => {
    await expect(
      resolveProviderRefundCase({
        activityMessage: " ",
        choice: "provider_confirmed_returned",
        id: 1,
        privateKey: await getTestPrivateKey(),
        revision: 1,
      }),
    ).rejects.toThrow("Refund-case activity message must not be empty");
  });

  test("rejects invalid returned money in a current case", async () => {
    const id = await addCase("invalid-refunded-money");
    await corruptCase(id, "refunded_amount", -1);

    await expect(
      resolveProviderRefundCase({
        activityMessage: "Invalid returned money",
        choice: "provider_confirmed_returned",
        id,
        privateKey: await getTestPrivateKey(),
        revision: 1,
      }),
    ).rejects.toThrow("payment_charges refunded money is invalid");
  });

  test("a provider choice cannot rewrite ready or retired work", async () => {
    const ready = await addCase(
      "wrong-ready-choice",
      readyRefundTestState("wrong-ready-choice-request"),
    );
    const retired = await addCase(
      "wrong-retired-choice",
      markRefundLocalRecorded(
        markRefundCompleted(
          readyRefundTestState("wrong-retired-choice-request"),
          30,
          "provider",
        ),
        31,
      ),
    );
    const privateKey = await getTestPrivateKey();

    for (const id of [ready, retired]) {
      expect(
        await resolveProviderRefundCase({
          activityMessage: "Choice does not apply",
          choice: "provider_confirmed_not_sent",
          id,
          privateKey,
          revision: 1,
        }),
      ).toBe("changed");
    }
  });
});
