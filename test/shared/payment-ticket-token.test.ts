import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  currentPaymentTicketToken,
  currentPaymentTicketTokenOrCreate,
  withPaymentTicketToken,
} from "#shared/payment-ticket-token.ts";

describe("payment ticket token", () => {
  test("uses the supplied token throughout the paid booking", async () => {
    await withPaymentTicketToken("PAIDTOKEN1", async () => {
      await Promise.resolve();
      expect(currentPaymentTicketToken()).toBe("PAIDTOKEN1");
      expect(currentPaymentTicketTokenOrCreate()).toBe("PAIDTOKEN1");
    });
  });

  test("keeps concurrent paid bookings isolated", async () => {
    const tokens = await Promise.all(
      ["PAIDTOKEN1", "PAIDTOKEN2"].map((token) =>
        withPaymentTicketToken(token, async () => {
          await Promise.resolve();
          return currentPaymentTicketTokenOrCreate();
        }),
      ),
    );

    expect(tokens).toEqual(["PAIDTOKEN1", "PAIDTOKEN2"]);
  });

  test("creates a fresh uppercase token outside a paid booking", () => {
    const first = currentPaymentTicketTokenOrCreate();
    const second = currentPaymentTicketTokenOrCreate();

    expect(first).toMatch(/^[0-9A-F]{10}$/);
    expect(second).not.toBe(first);
  });

  test("refuses to finalize outside a paid booking", () => {
    expect(() => currentPaymentTicketToken()).toThrow(
      "Paid booking ticket token was not prepared",
    );
  });
});
