import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handlePaymentSuccess } from "#routes/api/payment-success.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

describeWithEnv(
  "the success route with no usable callback",
  { db: true },
  () => {
    const errors = setupErrorSpy();

    test("names each stray parameter in the log", async () => {
      const response = await handlePaymentSuccess(
        new Request("http://localhost/payment/success?foo=1&bar=2"),
      );

      expect(response.status).toBe(400);
      expect(errors.contains("params=[foo,bar]")).toBe(true);
    });

    test("logs none when no parameter arrived", async () => {
      const response = await handlePaymentSuccess(
        new Request("http://localhost/payment/success"),
      );

      expect(response.status).toBe(400);
      expect(errors.contains("params=[none]")).toBe(true);
    });

    test("logs none for a missing referer", async () => {
      await handlePaymentSuccess(
        new Request("http://localhost/payment/success"),
      );

      expect(errors.contains("referer=none")).toBe(true);
    });

    test("logs an empty referer header as empty", async () => {
      await handlePaymentSuccess(
        new Request("http://localhost/payment/success", {
          headers: { referer: "" },
        }),
      );

      expect(errors.contains('referer="')).toBe(true);
    });
  },
);
