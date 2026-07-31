import type {
  PaymentCharge,
  StoredPaymentCharge,
} from "#shared/db/payments/types.ts";

/**
 * The charges a fixture says have money on them.
 *
 * A payment's charges can also have come across from the old payment tables,
 * and those carry no captured money. A fixture that builds its own payment
 * never makes one, so getting one back means the fixture is set up wrong.
 */
export const currentCharges = (
  charges: readonly StoredPaymentCharge[],
): PaymentCharge[] =>
  charges.map((charge) => {
    if (!("captured" in charge)) {
      throw new Error(`Charge ${charge.id} has no money on it`);
    }
    return charge;
  });
