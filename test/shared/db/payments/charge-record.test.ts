import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { getDb } from "#shared/db/client.ts";
import {
  getPaymentCharges,
  savePaymentCharges,
} from "#shared/db/payments/charges.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { insertLegacyPaymentCharge } from "./db-fixtures.ts";
import {
  chargeLeg,
  PAYMENT_ID,
  PAYMENT_TIME,
  SESSION_RESOURCE,
} from "./fixtures.ts";

const saveCharge = () =>
  savePaymentCharges(PAYMENT_ID, SESSION_RESOURCE, [chargeLeg()], PAYMENT_TIME);

describeWithEnv("db > payments > stored charge rows", { db: true }, () => {
  test("reads a quarantined legacy charge without decrypting its owner reference", async () => {
    await insertLegacyPaymentCharge();

    expect(await getPaymentCharges("legacy-payment")).toEqual([
      {
        createdAt: 1,
        id: 1,
        observedAt: 3,
        paymentId: "legacy-payment",
        providerReference: "hyb:1:legacy-reference",
        providerRefundedAt: "2026-07-25T10:00:00.000Z",
        refundState: "unknown",
        source: "processed_payments",
        updatedAt: 2,
      },
    ]);
  });

  test("fails loudly when stored provider and resource kind disagree", async () => {
    await saveCharge();
    await getDb().execute(
      "UPDATE payment_charges SET provider = 'square', resource_kind = 'square_payment' WHERE id = 1",
    );

    await expect(getPaymentCharges(PAYMENT_ID)).rejects.toThrow(
      "Invalid stored charge resource",
    );
  });

  test("reads the stored SumUp transaction kind", async () => {
    const session = {
      id: "sumup-checkout",
      kind: "sumup_checkout" as const,
      provider: "sumup" as const,
    };
    const resource = {
      id: "sumup-transaction",
      kind: "sumup_transaction" as const,
      parentId: session.id,
      provider: "sumup" as const,
    };
    await savePaymentCharges(
      "sumup-payment",
      session,
      [{ ...chargeLeg(), resource }],
      PAYMENT_TIME,
    );

    expect(
      (await getPaymentCharges("sumup-payment"))[0]?.providerReference,
    ).toEqual(resource);
  });

  test("fails loudly when a stored provider reference is malformed", async () => {
    await saveCharge();
    await getDb().execute(
      "UPDATE payment_charges SET provider_reference = ? WHERE id = 1",
      [await encrypt('{"provider":"stripe"}')],
    );

    await expect(getPaymentCharges(PAYMENT_ID)).rejects.toThrow(
      "payment_charges.provider_reference",
    );
  });
});
