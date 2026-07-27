import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("payment runtime account", { encryptionKey: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("resolves each configured provider mode and stable account context", async () => {
    settings.setForTest({
      payment_provider: "stripe",
      stripe_secret_key: "sk_test_account",
    });
    const stripe = await resolvePaymentAccount("stripe");

    settings.setForTest({
      payment_provider: "square",
      square_access_token: "square-token",
      square_location_id: "location-one",
      square_sandbox: false,
    });
    const square = await resolvePaymentAccount("square");

    settings.setForTest({
      payment_provider: "sumup",
      sumup_api_key: "sk_live_account",
      sumup_merchant_code: "merchant-one",
    });
    const sumup = await resolvePaymentAccount("sumup");

    expect(stripe).toMatchObject({ mode: "test", provider: "stripe" });
    expect(square).toMatchObject({ mode: "live", provider: "square" });
    expect(sumup).toMatchObject({ mode: "live", provider: "sumup" });
    expect(stripe.accountId).not.toContain("sk_test_account");
    expect(square.accountId).not.toContain("square-token");
    expect(sumup.accountId).not.toContain("merchant-one");
  });

  test("keeps stable accounts across credential rotation", async () => {
    using _stripeAccount = stub(stripeApi, "retrieveAccount", () =>
      Promise.resolve({ id: "acct_same" }),
    );
    settings.setForTest({ stripe_secret_key: "sk_test_rotation_first" });
    const firstStripe = await resolvePaymentAccount("stripe");
    settings.setForTest({ stripe_secret_key: "sk_test_rotation_second" });
    const secondStripe = await resolvePaymentAccount("stripe");

    settings.setForTest({
      payment_provider: "square",
      square_access_token: "first-token",
      square_location_id: "location-one",
      square_sandbox: true,
    });
    const firstSquare = await resolvePaymentAccount("square");
    settings.setForTest({ square_access_token: "rotated-token" });
    const secondSquare = await resolvePaymentAccount("square");

    settings.setForTest({
      payment_provider: "sumup",
      sumup_api_key: "sk_test_first",
      sumup_merchant_code: "merchant-one",
    });
    const firstSumup = await resolvePaymentAccount("sumup");
    settings.setForTest({ sumup_api_key: "sk_test_rotated" });
    const secondSumup = await resolvePaymentAccount("sumup");

    expect(secondStripe.accountId).toBe(firstStripe.accountId);
    expect(secondSquare.accountId).toBe(firstSquare.accountId);
    expect(secondSumup.accountId).toBe(firstSumup.accountId);
  });

  test("separates different stable accounts", async () => {
    let stripeAccountId = "acct_one";
    using _stripeAccount = stub(stripeApi, "retrieveAccount", () =>
      Promise.resolve({ id: stripeAccountId }),
    );
    settings.setForTest({ stripe_secret_key: "sk_test_account_one" });
    const firstStripe = await resolvePaymentAccount("stripe");
    stripeAccountId = "acct_two";
    settings.setForTest({ stripe_secret_key: "sk_test_account_two" });
    const secondStripe = await resolvePaymentAccount("stripe");

    settings.setForTest({
      payment_provider: "square",
      square_access_token: "same-token",
      square_location_id: "location-one",
      square_sandbox: true,
    });
    const firstSquare = await resolvePaymentAccount("square");
    settings.setForTest({ square_location_id: "location-two" });
    const secondSquare = await resolvePaymentAccount("square");

    settings.setForTest({
      payment_provider: "sumup",
      sumup_api_key: "sk_test_same",
      sumup_merchant_code: "merchant-one",
    });
    const firstSumup = await resolvePaymentAccount("sumup");
    settings.setForTest({ sumup_merchant_code: "merchant-two" });
    const secondSumup = await resolvePaymentAccount("sumup");

    expect(secondStripe.accountId).not.toBe(firstStripe.accountId);
    expect(secondSquare.accountId).not.toBe(firstSquare.accountId);
    expect(secondSumup.accountId).not.toBe(firstSumup.accountId);
  });

  test("rejects incomplete provider identity", async () => {
    settings.setForTest({ stripe_secret_key: "" });
    await expect(resolvePaymentAccount("stripe")).rejects.toThrow(
      "Stripe payment credentials is missing",
    );

    settings.setForTest({
      payment_provider: "stripe",
      stripe_secret_key: "unclassified-key",
    });
    await expect(resolvePaymentAccount("stripe")).rejects.toThrow(
      "Stripe payment mode",
    );

    using _unavailableStripe = stub(stripeApi, "retrieveAccount", () =>
      Promise.resolve(null),
    );
    settings.setForTest({ stripe_secret_key: "sk_test_unavailable" });
    await expect(resolvePaymentAccount("stripe")).rejects.toThrow(
      "Stripe payment account is unavailable",
    );

    settings.setForTest({
      payment_provider: "square",
      square_access_token: "",
      square_location_id: "location-one",
    });
    await expect(resolvePaymentAccount("square")).rejects.toThrow(
      "Square payment credentials is missing",
    );

    settings.setForTest({
      payment_provider: "square",
      square_access_token: "square-token",
      square_location_id: "",
    });
    await expect(resolvePaymentAccount("square")).rejects.toThrow(
      "Square payment account",
    );

    settings.setForTest({
      payment_provider: "sumup",
      sumup_api_key: "",
      sumup_merchant_code: "merchant-one",
    });
    await expect(resolvePaymentAccount("sumup")).rejects.toThrow(
      "SumUp payment credentials is missing",
    );

    settings.setForTest({
      payment_provider: "sumup",
      sumup_api_key: "sk_test_account",
      sumup_merchant_code: "",
    });
    await expect(resolvePaymentAccount("sumup")).rejects.toThrow(
      "SumUp payment account",
    );
  });
});
