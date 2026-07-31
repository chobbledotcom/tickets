import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  describeSumup,
  sumupCheckoutSnapshot,
  sumupTransactionResource,
} from "./fixtures.ts";

describeSumup("SumUp without a merchant code", () => {
  beforeEach(() => {
    setEffectiveDomainForTest("example.com");
    // The operator saved an API key but never the merchant code, so every
    // call that has to name the merchant cannot be made at all.
    settings.setForTest({ sumup_merchant_code: "" });
  });

  test("cannot start a checkout", async () => {
    expect(await sumupApi.createCheckout(await sumupCheckoutSnapshot())).toBe(
      null,
    );
  });

  test("cannot say what happened to a transaction", async () => {
    expect(
      await sumupApi.getTransactionStatus(sumupTransactionResource.id),
    ).toEqual({ status: "unavailable" });
  });

  test("cannot ask for a refund", async () => {
    expect(
      await sumupApi.refundTransaction(sumupTransactionResource.id),
    ).toEqual({ status: "unavailable" });
  });
});
