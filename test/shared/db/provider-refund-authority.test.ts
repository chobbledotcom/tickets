import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb, queryOne } from "#db/client.ts";
import {
  bindRefundCallbackIfChargeExists,
  type CreateRefundAuthority,
  createOrLoadRefundAuthority,
  loadRefundAuthorityById,
  loadRefundAuthorityByReference,
  prepareRefundAuthority,
} from "#db/provider-refund-authority.ts";
import {
  completeRefundAuthority,
  markRefundAuthorityRecorded,
  transitionRefundAuthority,
} from "#db/provider-refund-authority-change.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#db/query-log.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import {
  armRefundSend,
  markRefundObservationDue,
  readyRefund,
} from "#payment/refund-authority.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
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
    request:
      capability === "keyed"
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
  captured: gbp(2_500),
  now: 10,
  reference: paymentReference,
  state,
});

describeWithEnv("provider refund authority persistence", { db: true }, () => {
  test("creates ready authority in one exact upsert", async () => {
    const input = createInput();
    const prepared = await prepareRefundAuthority(input);
    expect(prepared.statement.args).toHaveLength(14);

    const { authority, queries } = await runWithQueryLogContext(async () => {
      enableQueryLog();
      const authority = await createOrLoadRefundAuthority(input);
      return { authority, queries: getQueryLog().map(({ sql }) => sql) };
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
    expect(
      await queryOne<{
        created_at: number;
        observed_at: number;
        updated_at: number;
      }>(
        `SELECT created_at, updated_at, observed_at
           FROM payment_charges WHERE id = ?`,
        [authority.id],
      ),
    ).toEqual({
      created_at: input.now,
      observed_at: input.now,
      updated_at: input.now,
    });
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

  test("an empty upsert result recovers only an exact existing authority", async () => {
    const plainInput = createInput(reference("tx-plain-recovery"));
    const plain = await createOrLoadRefundAuthority(plainInput);
    const callbackInput = {
      ...createInput(reference("tx-callback-recovery")),
      callbackReplayIndex: "callback-recovery",
    };
    const callback = await createOrLoadRefundAuthority(callbackInput);
    const realExecute = getDb().execute.bind(getDb());
    using _execute = stub(getDb(), "execute", async (...args) => {
      const statement: unknown = args[0];
      const sql = (() => {
        if (typeof statement === "string") return statement;
        if (
          typeof statement === "object" &&
          statement !== null &&
          "sql" in statement &&
          typeof statement.sql === "string"
        ) {
          return statement.sql;
        }
        throw new Error("Database statement has no SQL");
      })();
      return sql.includes("INSERT INTO payment_charges")
        ? emptyResultSet()
        : await realExecute(...args);
    });

    expect(await createOrLoadRefundAuthority(plainInput)).toEqual(plain);
    expect(await createOrLoadRefundAuthority(callbackInput)).toEqual(callback);
    await expect(
      createOrLoadRefundAuthority(
        createInput(reference("tx-missing-recovery")),
      ),
    ).rejects.toThrow("Created refund authority is missing");
  });

  test("creation refuses a provider with the wrong refund capability", async () => {
    await expect(
      createOrLoadRefundAuthority(
        createInput(reference("pi-wrong-capability", "stripe"), ready()),
      ),
    ).rejects.toThrow("Refund authority facts disagree");
  });

  test("one charge identity cannot be reused with different captured money", async () => {
    const input = createInput(reference("tx-changed-money"));
    await createOrLoadRefundAuthority(input);

    await expect(
      createOrLoadRefundAuthority({ ...input, captured: gbp(2_501) }),
    ).rejects.toThrow("Refund identity belongs to different charge facts");
  });

  test("an existing charge accepts only its exact callback identity", async () => {
    const first = await createOrLoadRefundAuthority(
      createInput(reference("tx-first")),
    );
    const second = await createOrLoadRefundAuthority(
      createInput(reference("tx-second")),
    );

    expect(
      await bindRefundCallbackIfChargeExists({
        callbackReplayIndex: "callback-one",
        referenceIndex: first.referenceIndex,
      }),
    ).toMatchObject({
      callbackReplayIndex: "callback-one",
      id: first.id,
    });
    expect(
      await bindRefundCallbackIfChargeExists({
        callbackReplayIndex: "callback-one",
        referenceIndex: first.referenceIndex,
      }),
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
    expect(
      await getDb().execute("SELECT id FROM payment_charges"),
    ).toMatchObject({ rows: [{ id: first.id }] });
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
      await transitionRefundAuthority(row, 31, gbp(0), (state) =>
        armRefundSend(state, 31, 50),
      ),
    ).toBeNull();
  });

  test("the revision transition refuses changed currency", async () => {
    const row = await createOrLoadRefundAuthority(createInput());
    await expect(
      transitionRefundAuthority(
        row,
        30,
        { amount: 0, currency: "USD" },
        (state) => state,
      ),
    ).rejects.toThrow("currency changed");
  });

  test("the revision transition refuses more returned than captured", async () => {
    const row = await createOrLoadRefundAuthority(createInput());
    await expect(
      transitionRefundAuthority(row, 30, gbp(2_501), (state) => state),
    ).rejects.toThrow("refunded amount exceeds its capture");
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
      transitionRefundAuthority(observed, 31, gbp(99), (state) =>
        markRefundObservationDue(state, 31, 50),
      ),
    ).rejects.toThrow("amount moved backwards");
  });

  test("completion changes the canonical authority once", async () => {
    const row = await createOrLoadRefundAuthority(createInput());

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
  });

  test("a stale completion leaves the authority unchanged", async () => {
    const row = await createOrLoadRefundAuthority(createInput());

    expect(
      await completeRefundAuthority(
        { ...row, revision: row.revision + 1 },
        gbp(2_500),
        50,
        "provider",
      ),
    ).toBeNull();
    expect(await loadRefundAuthorityById(row.id)).toEqual(row);
  });

  test("creation always leaves reachable ready work with zero returned", async () => {
    const row = await createOrLoadRefundAuthority(createInput());

    expect(row.state.kind).toBe("ready");
    expect(row.refunded).toEqual(gbp(0));
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
