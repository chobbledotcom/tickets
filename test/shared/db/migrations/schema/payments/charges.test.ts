import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentChargeTable } from "#db/migrations/schema/payments/charges.ts";
import { sql } from "#db/sql.ts";
import { refundAuthorityWorkCondition } from "#payment/refund-authority-lifecycle.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectSchemaColumns } from "#test-utils/schema-columns.ts";
import {
  expectAccepted,
  expectRefused,
  expectRefusedAsRepeat,
} from "./refuses.ts";

const COLUMNS = sql`provider, provider_reference, reference_index, callback_replay_index, capability, captured_amount, currency, refunded_amount, refund_state, refund_state_name, refund_local_state, next_refund_action_at, refund_revision, created_at, updated_at, observed_at`;

const READY_STATE = `{"kind":"ready","request":{"capability":"keyed","generation":1,"identityIndex":"request-one","replayUntil":500},"evidenceRevision":1,"local":{"kind":"not_due"},"nextActionAt":100,"readyAt":1}`;

type ChargeFacts = {
  capability: string;
  localState: string;
  nextActionAt: number | null;
  provider: string;
  state: string;
  stateName: string;
};

const READY_CHARGE: ChargeFacts = {
  capability: "keyed",
  localState: "not_due",
  nextActionAt: 100,
  provider: "stripe",
  state: READY_STATE,
  stateName: "ready",
};

const aCharge = (
  index: string,
  reference = "hyb:1:a:b:c",
  callbackReplay: string | null = null,
  changed: Partial<ChargeFacts> = {},
) => {
  const facts = { ...READY_CHARGE, ...changed };
  return sql`INSERT INTO payment_charges (${COLUMNS})
    VALUES (${facts.provider}, ${reference},
      ${index}, ${callbackReplay}, ${facts.capability}, 100, 'GBP', 0,
      ${facts.state}, ${facts.stateName}, ${facts.localState}, ${facts.nextActionAt}, 1, 1, 1, 1)`;
};

/** Each row is one way a writer could hold a provider's name that the table
 *  must refuse: in the open or in an envelope the decoder turns away. */
const OPEN_PROVIDER_REFERENCES = [
  ["in plain words", "pi_12345"],
  ["behind an upper-case envelope", "ENC:1:a:b"],
  ["wearing an envelope with nothing in it", "enc:1:pi_12345"],
  ["behind the database owner's symmetric key", "enc:1:a:b"],
] as const;

test("is what the money actually taken is made of", () => {
  const [, table] = paymentChargeTable;

  expectSchemaColumns(paymentChargeTable, "payment_charges", [
    "id",
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
  expect(table.indexes).toContainEqual({
    columns: ["id"],
    name: "idx_payment_charges_refund_state",
    where: refundAuthorityWorkCondition(""),
  });
});

describeWithEnv("db > payment charge rules", { db: true }, () => {
  for (const [name, reference] of OPEN_PROVIDER_REFERENCES) {
    test(`refuses money whose provider name is held ${name}`, async () => {
      await expectRefused(aCharge("plain-index", reference));
    });
  }

  test("accepts a provider name hidden for the owner", async () => {
    await expectAccepted(aCharge("owner-index"));
  });

  test("refuses a provider outside the exhaustive provider set", async () => {
    await expectRefused(
      aCharge("unknown-provider-index", undefined, undefined, {
        provider: "paypal",
      }),
    );
  });

  test("refuses a second authority for the same provider money anywhere", async () => {
    await expectAccepted(aCharge("same-money-index"));
    await expectRefusedAsRepeat(aCharge("same-money-index"));
  });

  test("refuses a second authority for the same callback replay", async () => {
    await expectAccepted(aCharge("first-index", undefined, "replay"));
    await expectRefusedAsRepeat(
      aCharge("second-index", "hyb:1:d:e:f", "replay"),
    );
  });

  test("allows admin commands with no callback replay identity", async () => {
    await expectAccepted(aCharge("first-admin-index"));
    await expectAccepted(aCharge("second-admin-index", "hyb:1:d:e:f"));
  });

  test("refuses invalid or dishonest state mirrors", async () => {
    // Each row bends one mirror away from the state the charge claims.
    for (const [index, changed] of [
      ["bad-json-index", { nextActionAt: null, state: "{}" }],
      ["bad-kind-index", { stateName: "observing" }],
      ["bad-local-index", { localState: "due" }],
      ["bad-capability-index", { capability: "keyless" }],
    ] as const) {
      await expectRefused(aCharge(index, undefined, undefined, changed));
    }
  });
});
