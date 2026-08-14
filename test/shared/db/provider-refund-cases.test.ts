import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryOne } from "#shared/db/client.ts";
import {
  type ProviderRefundOwnerChoice,
  resolveProviderRefundCase,
} from "#shared/db/provider-refund-case-resolution.ts";
import {
  listProviderRefundCases,
  loadProviderRefundCase,
  type ProviderRefundCase,
  type ProviderRefundCasePage,
} from "#shared/db/provider-refund-cases.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundLocalRecorded,
  readyRefund,
} from "#shared/payment/refund-authority.ts";
import {
  readRefundAuthorityState,
  type RefundAuthorityState,
} from "#shared/payment/refund-authority-state.ts";
import {
  markRefundOwnerChoiceNeeded,
  markRefundProviderConflict,
} from "#shared/payment/refund-authority-choice.ts";
import { readProviderRefundCursor } from "#shared/provider-refund-cursor.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  addProviderRefundTestCase,
  readyRefundTestState,
} from "#test-utils/provider-refund-cases.ts";
import { recordQueries } from "#test-utils/record-queries.ts";

const taggedReference = (
  reference: string,
  provider: PaymentProviderType = "sumup",
): TaggedPaymentReference => ({
  kind: "tagged",
  provider,
  reference,
});

const keyedOwnerChoice = (identity: string): RefundAuthorityState =>
  markRefundOwnerChoiceNeeded(
    armRefundSend(
      readyRefund({
        evidenceRevision: 1,
        nextActionAt: 20,
        now: 10,
        request: {
          capability: "keyed",
          generation: 1,
          identityIndex: identity,
          replayUntil: 20,
        },
      }),
      11,
      20,
    ),
    12,
    "provider_rejected",
  );

type StoredState = {
  refund_revision: number;
  refund_state: string;
  refunded_amount: number;
};

const storedState = (id: number): Promise<StoredState | null> =>
  queryOne<StoredState>(
    `SELECT refund_revision, refund_state, refunded_amount
       FROM payment_charges
      WHERE id = ?`,
    [id],
  );

const resolveCase = async (
  id: number,
  choice: ProviderRefundOwnerChoice,
): Promise<StoredState> => {
  expect(
    await resolveProviderRefundCase({
      activityMessage: `Resolve provider refund case ${id}`,
      choice,
      id,
      privateKey: await getTestPrivateKey(),
      revision: 1,
    }),
  ).toBe("resolved");
  const row = await storedState(id);
  if (row === null) throw new Error("Resolved refund case is missing");
  return row;
};

const expectMoneyChoicesRejected = async (
  id: number,
  privateKey: CryptoKey,
): Promise<void> => {
  const before = await storedState(id);
  for (
    const choice of [
      "provider_confirmed_not_sent",
      "provider_confirmed_returned",
    ] as const
  ) {
    expect(
      await resolveProviderRefundCase({
        activityMessage: `Reject provider refund case ${id}`,
        choice,
        id,
        privateKey,
        revision: 1,
      }),
    ).toBe("changed");
  }
  expect(await storedState(id)).toEqual(before);
};

describeWithEnv("provider refund recovery cases", { db: true }, () => {
  test("includes a ready refund intent in the reachable owner queue", async () => {
    const id = await addProviderRefundTestCase(
      "ready-owner-work",
      readyRefundTestState("ready-owner-request"),
    );

    expect(await listProviderRefundCases()).toMatchObject({
      cases: [{ id, state: "ready" }],
    });
    expect(
      await loadProviderRefundCase(id, await getTestPrivateKey()),
    ).toMatchObject({ id, state: "ready" });
  });

  test("lists one bounded PII-free keyset page", async () => {
    const ids = await Promise.all(
      Array.from(
        { length: 21 },
        (_, index) => addProviderRefundTestCase(`queue-${index}`),
      ),
    );
    const sortedIds = ids.toSorted((left, right) => left - right);
    const queries: string[] = [];
    const restore = recordQueries(queries);
    let first: ProviderRefundCasePage;
    try {
      first = await listProviderRefundCases();
    } finally {
      restore();
    }

    expect(first.cases.map(({ id }) => id)).toEqual(sortedIds.slice(0, 20));
    expect(first.nextCursor).not.toBeNull();
    const queueQuery = queries.find((query) =>
      query.includes("FROM payment_charges AS charge")
    );
    expect(queueQuery).toContain("LIMIT ?");
    expect(queueQuery).not.toContain("provider_reference");
    expect(queueQuery).not.toContain("refund_state,");
    const plan = await getDb().execute({
      args: [21],
      sql: `EXPLAIN QUERY PLAN ${queueQuery}`,
    });
    expect(plan.rows.map((row) => String(row.detail)).join(" ")).toContain(
      "idx_payment_charges_refund_state",
    );

    const after = await readProviderRefundCursor(first.nextCursor!);
    expect(after).not.toBeNull();
    const second = await listProviderRefundCases(after!);
    expect(second.cases.map(({ id }) => id)).toEqual([sortedIds[20]]);
    expect(second.nextCursor).toBeNull();
  });

  test("refuses a malformed opaque cursor", async () => {
    expect(await readProviderRefundCursor("20")).toBeNull();
    await expect(listProviderRefundCases(0)).rejects.toThrow(
      "Refund-case boundary must be a positive safe integer",
    );
  });

  test("loads and decrypts only the selected case", async () => {
    await addProviderRefundTestCase("not-selected");
    const id = await addProviderRefundTestCase("selected-reference");
    const queries: string[] = [];
    const restore = recordQueries(queries);
    let loaded: ProviderRefundCase | null;
    try {
      loaded = await loadProviderRefundCase(id, await getTestPrivateKey());
    } finally {
      restore();
    }

    expect(loaded).toMatchObject({
      choices: [
        "provider_confirmed_returned",
        "provider_confirmed_not_sent",
      ],
      id,
      reason: "possibly_sent",
      reference: taggedReference("selected-reference"),
      revision: 1,
      state: "needs_owner_choice",
    });
    const detailQuery = queries.find((query) =>
      query.includes("FROM payment_charges AS charge")
    );
    expect(detailQuery).toContain("WHERE charge.id = ?");
    expect(detailQuery).toContain("LIMIT 1");
  });

  test("does not expose returned money whose local recording is finished", async () => {
    const id = await addProviderRefundTestCase(
      "finished",
      markRefundLocalRecorded(
        markRefundCompleted(
          readyRefundTestState("finished-request"),
          30,
          "provider",
        ),
        31,
      ),
    );

    expect(
      await loadProviderRefundCase(id, await getTestPrivateKey()),
    ).toBeNull();
  });

  test("exposes returned money until the owner confirms it is recorded", async () => {
    const id = await addProviderRefundTestCase(
      "recording-due",
      markRefundCompleted(
        readyRefundTestState("recording-request"),
        30,
        "provider",
      ),
    );
    expect(
      await loadProviderRefundCase(id, await getTestPrivateKey()),
    ).toMatchObject({ id, reason: null, state: "completed" });

    const row = await resolveCase(id, "money_recorded");
    expect(
      readRefundAuthorityState(row.refund_state, "recorded case"),
    ).toMatchObject({ kind: "completed", local: { kind: "recorded" } });
    expect(
      await loadProviderRefundCase(id, await getTestPrivateKey()),
    ).toBeNull();
  });

  test("records returned money through one revision-fenced transition", async () => {
    const id = await addProviderRefundTestCase("returned");

    const row = await resolveCase(id, "provider_confirmed_returned");
    expect(row.refund_revision).toBe(2);
    expect(row.refunded_amount).toBe(2_500);
    expect(
      readRefundAuthorityState(row.refund_state, "resolved case"),
    ).toMatchObject({
      kind: "completed",
      local: { kind: "due" },
      proof: "owner",
    });
  });

  test("not-sent authorizes a new generation without sending it", async () => {
    const id = await addProviderRefundTestCase("not-sent");

    const row = await resolveCase(id, "provider_confirmed_not_sent");
    expect(row.refund_revision).toBe(2);
    expect(row.refunded_amount).toBe(0);
    expect(
      readRefundAuthorityState(row.refund_state, "rearmed case"),
    ).toMatchObject({
      kind: "ready",
      request: { capability: "keyless", generation: 2 },
    });
  });

  test("a keyed not-sent decision preserves capability and starts a fresh window", async () => {
    const id = await addProviderRefundTestCase(
      "keyed-not-sent",
      keyedOwnerChoice("keyed-request"),
      "stripe",
    );

    const row = await resolveCase(id, "provider_confirmed_not_sent");
    expect(
      readRefundAuthorityState(row.refund_state, "keyed rearmed case"),
    ).toMatchObject({
      kind: "ready",
      request: { capability: "keyed", generation: 2 },
    });
  });

  test("a partial return stays unresolved instead of reversing the full payment", async () => {
    const state = markRefundProviderConflict(
      readyRefundTestState("partial-conflict-request"),
      12,
      {
        captured: { amount: 2_500, currency: "GBP" },
        kind: "returned",
        refunded: { amount: 400, currency: "GBP" },
      },
    );
    const id = await addProviderRefundTestCase(
      "partial-conflict",
      state,
      "sumup",
      400,
    );
    const privateKey = await getTestPrivateKey();

    expect(await loadProviderRefundCase(id, privateKey)).toMatchObject({
      decision: {
        captured: { amount: 2_500, currency: "GBP" },
        kind: "returned",
        refunded: { amount: 400, currency: "GBP" },
      },
      state: "needs_provider_check",
    });
    await expectMoneyChoicesRejected(id, privateKey);
  });

  test("waiting conflict evidence rejects every crafted money answer", async () => {
    const id = await addProviderRefundTestCase(
      "waiting-conflict",
      markRefundProviderConflict(
        readyRefundTestState("waiting-conflict-request"),
        12,
        {
          captured: { amount: 2_500, currency: "GBP" },
          kind: "wait",
          refunded: { amount: 100, currency: "GBP" },
        },
      ),
    );
    const privateKey = await getTestPrivateKey();

    expect(await loadProviderRefundCase(id, privateKey)).toMatchObject({
      decision: { kind: "wait" },
      state: "needs_provider_check",
    });
    await expectMoneyChoicesRejected(id, privateKey);
  });

  test("refuses a choice which does not apply to the current case", async () => {
    const id = await addProviderRefundTestCase("wrong-choice");
    const before = await storedState(id);

    expect(
      await resolveProviderRefundCase({
        activityMessage: `Wrong provider refund choice ${id}`,
        choice: "money_recorded",
        id,
        privateKey: await getTestPrivateKey(),
        revision: 1,
      }),
    ).toBe("changed");
    expect(await storedState(id)).toEqual(before);
  });

  test("a stale owner decision changes nothing", async () => {
    const id = await addProviderRefundTestCase("stale");
    const before = await storedState(id);

    expect(
      await resolveProviderRefundCase({
        activityMessage: `Stale provider refund choice ${id}`,
        choice: "provider_confirmed_returned",
        id,
        privateKey: await getTestPrivateKey(),
        revision: 99,
      }),
    ).toBe("changed");
    expect(await storedState(id)).toEqual(before);
  });

  test("a missing owner case remains missing", async () => {
    expect(
      await resolveProviderRefundCase({
        activityMessage: "Missing provider refund choice",
        choice: "provider_confirmed_returned",
        id: 987_654_321,
        privateKey: await getTestPrivateKey(),
        revision: 1,
      }),
    ).toBe("missing");
  });
});
