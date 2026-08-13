import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, getDb, queryOne } from "#shared/db/client.ts";
import type { CreateRefundAuthority } from "#shared/db/provider-refund-authority.ts";
import {
  bindRefundCallbackIfChargeExists,
  completeRefundAuthority,
  createOrLoadRefundAuthority,
  loadRefundAuthorityById,
  loadRefundAuthorityByReference,
  markRefundAuthorityRecorded,
  transitionRefundAuthority,
} from "#shared/db/provider-refund-authority.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import {
  armRefundSend,
  markRefundObservationDue,
  readyRefund,
} from "#shared/payment/refund-authority.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { gbp } from "#test-utils/payment-state.ts";

const reference = (
  raw: string,
  provider: TaggedPaymentReference["provider"] = "sumup",
): TaggedPaymentReference => ({ kind: "tagged", provider, reference: raw });

const ready = (capability: "keyed" | "keyless" = "keyless") =>
  readyRefund({
    evidenceRevision: 1,
    nextActionAt: 20,
    now: 10,
    request: capability === "keyed"
      ? {
        capability,
        generation: 1,
        identityIndex: "request-one",
        replayUntil: 500,
      }
      : { capability, generation: 1, identityIndex: "request-one" },
  });

const createInput = (
  paymentReference = reference("tx-one"),
  state = ready(),
): CreateRefundAuthority => ({
  capability: state.request.capability,
  captured: gbp(2_500),
  now: 10,
  reference: paymentReference,
  state,
});

const markerFor = async (index: string): Promise<string | null> =>
  (
    await queryOne<{ provider_refunded_at: string }>(
      `SELECT provider_refunded_at
       FROM processed_payments
      WHERE payment_reference_index = ?`,
      [index],
    )
  )?.provider_refunded_at ?? null;

const addProcessedPayment = async (index: string): Promise<void> => {
  await execute(
    `INSERT INTO processed_payments
      (payment_session_id, processed_at, payment_reference_index)
     VALUES (?, '2026-08-13T00:00:00.000Z', ?)`,
    [`session-${crypto.randomUUID()}`, index],
  );
};

describeWithEnv("provider refund authority persistence", { db: true }, () => {
  test("creates ready authority in one exact upsert", async () => {
    const queries = await runWithQueryLogContext(async () => {
      enableQueryLog();
      await createOrLoadRefundAuthority(createInput());
      return getQueryLog().map(({ sql }) => sql);
    });

    const insert = queries.find((sql) => sql.includes("INTO payment_charges"));
    if (insert === undefined) {
      throw new Error("Authority insert was not logged");
    }
    const columns = insert.match(
      /INSERT INTO payment_charges\s*\(([^)]+)\)\s*VALUES/su,
    )?.[1];
    if (columns === undefined) {
      throw new Error("Authority columns were not logged");
    }
    expect(columns.split(",").map((column) => column.trim())).toEqual([
      "provider",
      "provider_reference",
      "reference_index",
      "callback_replay_index",
      "capability",
      "captured_amount",
      "currency",
      "refunded_amount",
      "refund_state",
      "refund_state_name",
      "refund_local_state",
      "next_refund_action_at",
      "refund_revision",
      "created_at",
      "updated_at",
      "observed_at",
    ]);
    expect(insert).toContain("ON CONFLICT DO UPDATE");
    expect(insert).toContain("RETURNING id, provider, reference_index");
    expect(insert).not.toContain("INSERT OR IGNORE");
    expect(insert.match(/\?/gu)?.length).toBe(16);
    expect(queries.filter((sql) => sql.includes("payment_charges"))).toEqual([
      insert,
    ]);
  });

  test("loads one authority by id or indexed reference", async () => {
    const row = await createOrLoadRefundAuthority(createInput());

    expect(await loadRefundAuthorityById(row.id)).toEqual(row);
    expect(await loadRefundAuthorityByReference(row.referenceIndex)).toEqual(
      row,
    );
    expect(await loadRefundAuthorityById(row.id + 100)).toBeNull();
    expect(await loadRefundAuthorityByReference("missing")).toBeNull();
  });

  test("a duplicate reference returns its one existing authority", async () => {
    const input = createInput();
    const first = await createOrLoadRefundAuthority(input);
    const second = await createOrLoadRefundAuthority(input);

    expect(second).toEqual(first);
    expect(
      await getDb().execute("SELECT id FROM payment_charges"),
    ).toMatchObject({ rows: [{ id: first.id }] });
  });

  test("an existing charge accepts only its exact callback identity", async () => {
    const first = await createOrLoadRefundAuthority(
      createInput(reference("tx-first")),
    );
    const second = await createOrLoadRefundAuthority(
      createInput(reference("tx-second")),
    );

    expect(
      await bindRefundCallbackIfChargeExists(
        {
          callbackReplayIndex: "callback-one",
          referenceIndex: first.referenceIndex,
        },
      ),
    ).toMatchObject({
      callbackReplayIndex: "callback-one",
      id: first.id,
    });
    expect(
      await bindRefundCallbackIfChargeExists(
        {
          callbackReplayIndex: "callback-one",
          referenceIndex: first.referenceIndex,
        },
      ),
    ).toMatchObject({ id: first.id });
    await expect(
      bindRefundCallbackIfChargeExists({
        callbackReplayIndex: "callback-two",
        referenceIndex: first.referenceIndex,
      }),
    ).rejects.toThrow("Refund callback identity belongs to another charge");
    await expect(
      bindRefundCallbackIfChargeExists({
        callbackReplayIndex: "callback-one",
        referenceIndex: second.referenceIndex,
      }),
    ).rejects.toThrow("Refund callback identity belongs to another charge");
  });

  test("a callback identity stays unbound while its charge is absent", async () => {
    expect(
      await bindRefundCallbackIfChargeExists({
        callbackReplayIndex: "callback-one",
        referenceIndex: "missing-charge",
      }),
    ).toBeNull();
  });

  test("callback creation refuses a collision without leaving a charge", async () => {
    const first = await createOrLoadRefundAuthority({
      ...createInput(reference("tx-callback-first")),
      callbackReplayIndex: "callback-one",
    });

    await expect(
      createOrLoadRefundAuthority({
        ...createInput(reference("tx-callback-second")),
        callbackReplayIndex: "callback-one",
      }),
    ).rejects.toThrow("Refund callback identity belongs to another charge");
    expect(await getDb().execute("SELECT id FROM payment_charges"))
      .toMatchObject(
        { rows: [{ id: first.id }] },
      );
  });

  test("transitions exactly the expected revision", async () => {
    const row = await createOrLoadRefundAuthority(createInput());
    const queries = await runWithQueryLogContext(async () => {
      enableQueryLog();
      const changed = await transitionRefundAuthority(
        row,
        30,
        gbp(0),
        (state) => armRefundSend(state, 30, 40),
      );
      return { changed, sql: getQueryLog().map(({ sql }) => sql) };
    });

    expect(queries.changed).toMatchObject({
      revision: row.revision + 1,
      state: { kind: "send_armed" },
    });
    expect(queries.sql).toHaveLength(1);
    expect(queries.sql[0]).toContain("UPDATE payment_charges");
    expect(queries.sql[0]).not.toContain("SELECT");
    expect(
      await transitionRefundAuthority(
        row,
        31,
        gbp(0),
        (state) => armRefundSend(state, 31, 50),
      ),
    ).toBeNull();
  });

  test("the revision transition refuses changed currency", async () => {
    const row = await createOrLoadRefundAuthority(createInput());
    await expect(
      transitionRefundAuthority(
        row,
        30,
        {
          amount: 0,
          currency: "USD",
        },
        (state) => state,
      ),
    ).rejects.toThrow("currency changed");
  });

  test("a later observation cannot forget money already returned", async () => {
    const row = await createOrLoadRefundAuthority(createInput());
    const observed = await transitionRefundAuthority(
      row,
      30,
      gbp(100),
      (state) => armRefundSend(state, 30, 40),
    );
    if (observed === null) throw new Error("setup transition lost");

    await expect(
      transitionRefundAuthority(
        observed,
        31,
        gbp(99),
        (state) => markRefundObservationDue(state, 31, 50),
      ),
    ).rejects.toThrow("amount moved backwards");
  });

  test("completion and every matching legacy marker commit together", async () => {
    const row = await createOrLoadRefundAuthority(createInput());
    await addProcessedPayment(row.referenceIndex);
    await addProcessedPayment(row.referenceIndex);

    const completed = await completeRefundAuthority(
      row,
      gbp(2_500),
      50,
      "provider",
    );

    expect(completed).toMatchObject({
      refunded: gbp(2_500),
      revision: row.revision + 1,
      state: {
        kind: "completed",
        local: { kind: "due", returnedAt: 50 },
      },
    });
    const markers = await getDb().execute({
      args: [row.referenceIndex],
      sql: `SELECT provider_refunded_at
              FROM processed_payments
             WHERE payment_reference_index = ?`,
    });
    expect(markers.rows).toEqual([
      { provider_refunded_at: "1970-01-01T00:00:00.050Z" },
      { provider_refunded_at: "1970-01-01T00:00:00.050Z" },
    ]);
  });

  test("a refused legacy marker rolls completion back", async () => {
    const row = await createOrLoadRefundAuthority(createInput());
    await addProcessedPayment(row.referenceIndex);
    await execute(
      `CREATE TRIGGER refuse_provider_refund_marker
       BEFORE UPDATE OF provider_refunded_at ON processed_payments
       BEGIN
         SELECT RAISE(ABORT, 'marker refused');
       END`,
    );

    await expect(
      completeRefundAuthority(row, gbp(2_500), 50, "provider"),
    ).rejects.toThrow("marker refused");

    expect(await loadRefundAuthorityById(row.id)).toEqual(row);
    expect(await markerFor(row.referenceIndex)).toBe("");
  });

  test("a stale completion changes neither authority nor legacy marker", async () => {
    const row = await createOrLoadRefundAuthority(createInput());
    await addProcessedPayment(row.referenceIndex);

    expect(
      await completeRefundAuthority(
        { ...row, revision: row.revision + 1 },
        gbp(2_500),
        50,
        "provider",
      ),
    ).toBeNull();
    expect(await markerFor(row.referenceIndex)).toBe("");
    expect((await loadRefundAuthorityById(row.id))?.state.kind).toBe("ready");
  });

  test("creation always leaves reachable ready work with zero returned", async () => {
    const row = await createOrLoadRefundAuthority(createInput());

    expect(row.state.kind).toBe("ready");
    expect(row.refunded).toEqual(gbp(0));
  });

  test("a stale completion cannot mark an unrecorded legacy row", async () => {
    const row = await createOrLoadRefundAuthority(createInput());
    const completed = await completeRefundAuthority(
      row,
      gbp(2_500),
      50,
      "provider",
    );
    if (completed === null) throw new Error("setup completion lost");
    await addProcessedPayment(row.referenceIndex);

    expect(
      await completeRefundAuthority(row, gbp(2_500), 50, "provider"),
    ).toBeNull();

    expect(await markerFor(row.referenceIndex)).toBe("");
  });

  test("local recording is revision fenced and cannot skip completion", async () => {
    const row = await createOrLoadRefundAuthority(createInput());
    await expect(
      markRefundAuthorityRecorded(row.id, row.revision, 60),
    ).rejects.toThrow("not waiting for local recording");

    const completed = await completeRefundAuthority(
      row,
      gbp(2_500),
      50,
      "provider",
    );
    if (completed === null) throw new Error("setup completion lost");
    const recorded = await markRefundAuthorityRecorded(
      completed.id,
      completed.revision,
      60,
    );

    expect(recorded).toMatchObject({
      revision: completed.revision + 1,
      state: { kind: "completed", local: { kind: "recorded" } },
    });
    if (recorded === null) throw new Error("setup recording lost");
    expect(
      await markRefundAuthorityRecorded(recorded.id, recorded.revision, 61),
    ).toEqual(recorded);
    expect(
      await markRefundAuthorityRecorded(completed.id, completed.revision, 61),
    ).toBeNull();
  });
});
