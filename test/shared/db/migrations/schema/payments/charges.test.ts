import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentChargeTable } from "#db/migrations/schema/payments/charges.ts";
import { refundAuthorityWorkSql } from "#payment/refund-authority-lifecycle.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectAccepted,
  expectRefused,
  expectRefusedAsRepeat,
} from "./refuses.ts";

const COLUMNS =
  "provider, provider_reference, reference_index, callback_replay_index, capability, captured_amount, currency, refunded_amount, refund_state, refund_state_name, refund_local_state, next_refund_action_at, refund_revision, created_at, updated_at, observed_at";

const READY_STATE = `{"kind":"ready","request":{"capability":"keyed","generation":1,"identityIndex":"request-one","replayUntil":500},"evidenceRevision":1,"local":{"kind":"not_due"},"nextActionAt":100,"readyAt":1}`;

const aCharge = (
  index: string,
  reference = "'hyb:1:a:b:c'",
  callbackReplay = "NULL",
) =>
  `INSERT INTO payment_charges (${COLUMNS})
    VALUES ('stripe', ${reference},
      '${index}', ${callbackReplay}, 'keyed', 100, 'GBP', 0,
      '${READY_STATE}', 'ready', 'not_due', 100, 1, 1, 1, 1)`;

test("is what the money actually taken is made of", () => {
  const [name, table] = paymentChargeTable;

  expect(name).toBe("payment_charges");
  expect(table.columns.map(([held]) => held)).toEqual([
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
    where: refundAuthorityWorkSql("").slice(1, -1),
  });
});

describeWithEnv("db > payment charge rules", { db: true }, () => {
  for (const [name, reference] of [
    ["in plain words", "'pi_12345'"],
    ["behind an upper-case envelope", "'ENC:1:a:b'"],
    ["wearing an envelope with nothing in it", "'enc:1:pi_12345'"],
    ["behind the database owner's symmetric key", "'enc:1:a:b'"],
  ] as const) {
    test(`refuses money whose provider name is held ${name}`, async () => {
      await expectRefused(aCharge("plain-index", reference));
    });
  }

  test("accepts a provider name hidden for the owner", async () => {
    await expectAccepted(aCharge("owner-index"));
  });

  test("refuses a provider outside the exhaustive provider set", async () => {
    await expectRefused(
      aCharge("unknown-provider-index").replace(
        "VALUES ('stripe'",
        "VALUES ('paypal'",
      ),
    );
  });

  test("refuses a second authority for the same provider money anywhere", async () => {
    await expectAccepted(aCharge("same-money-index"));
    await expectRefusedAsRepeat(aCharge("same-money-index"));
  });

  test("refuses a second authority for the same callback replay", async () => {
    await expectAccepted(aCharge("first-index", undefined, "'replay'"));
    await expectRefusedAsRepeat(
      aCharge("second-index", "'hyb:1:d:e:f'", "'replay'"),
    );
  });

  test("allows admin commands with no callback replay identity", async () => {
    await expectAccepted(aCharge("first-admin-index"));
    await expectAccepted(aCharge("second-admin-index", "'hyb:1:d:e:f'"));
  });

  test("refuses invalid or dishonest state mirrors", async () => {
    await expectRefused(
      aCharge("bad-json-index")
        .replace(`'${READY_STATE}'`, "'{}'")
        .replace("'ready', 'not_due', 100", "'ready', 'not_due', NULL"),
    );
    await expectRefused(
      aCharge("bad-kind-index").replace(
        "'ready', 'not_due'",
        "'observing', 'not_due'",
      ),
    );
    await expectRefused(
      aCharge("bad-local-index").replace(
        "'ready', 'not_due'",
        "'ready', 'due'",
      ),
    );
    await expectRefused(
      aCharge("bad-capability-index").replace("'keyed', 100", "'keyless', 100"),
    );
  });
});
