import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  confirmChargesFullyRefunded,
  getPaymentCharges,
} from "#shared/db/payments/charges.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { savePaymentCharges } from "#test-utils/payment-aggregate.ts";
import {
  chargeLeg,
  PAYMENT_ID,
  PAYMENT_TIME,
  SESSION_RESOURCE,
} from "./fixtures.ts";

const savedCharge = async () => {
  await savePaymentCharges(
    PAYMENT_ID,
    SESSION_RESOURCE,
    [chargeLeg()],
    PAYMENT_TIME,
  );
  const [charge] = await getPaymentCharges(PAYMENT_ID);
  if (charge === undefined || !("captured" in charge)) {
    throw new Error("Expected one current payment charge");
  }
  return charge;
};

describeWithEnv("db > payment charge confirmation", { db: true }, () => {
  test("records exact full-refund evidence at the observed time", async () => {
    const charge = await savedCharge();

    await confirmChargesFullyRefunded(
      PAYMENT_ID,
      [{ captured: charge.captured, chargeId: charge.id }],
      PAYMENT_TIME + 1,
    );

    const [confirmed] = await getPaymentCharges(PAYMENT_ID);
    expect(confirmed).toMatchObject({
      observedAt: PAYMENT_TIME + 1,
      refunded: charge.captured,
      refundState: "completed",
      updatedAt: PAYMENT_TIME + 1,
    });
  });

  test("rolls back confirmation when the expected charge facts changed", async () => {
    const charge = await savedCharge();

    await expect(
      confirmChargesFullyRefunded(
        PAYMENT_ID,
        [
          {
            captured: {
              ...charge.captured,
              amount: charge.captured.amount + 1,
            },
            chargeId: charge.id,
          },
        ],
        PAYMENT_TIME + 1,
      ),
    ).rejects.toThrow(
      `Payment charge ${charge.id} changed before confirmation`,
    );
    expect((await getPaymentCharges(PAYMENT_ID))[0]).toMatchObject({
      refunded: { amount: 0, currency: "GBP" },
      refundState: "none",
    });
  });

  test("requires at least one charge to confirm", async () => {
    await expect(confirmChargesFullyRefunded(PAYMENT_ID, [])).rejects.toThrow(
      `Payment ${PAYMENT_ID} has no charges to confirm`,
    );
  });
});
