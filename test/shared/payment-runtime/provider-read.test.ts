import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import * as v from "valibot";
import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  assembleCheckoutMetadata,
  ProviderMetadataSchema,
} from "#shared/payment-helpers.ts";
import {
  metadataForStoredPayment,
  signedBookingIntentFromMetadata,
} from "#shared/payment-runtime/metadata.ts";
import {
  checkProviderValue,
  foundProviderRead,
  makeProviderValueReader,
  missingProviderRead,
  providerFactDetails,
  readProviderOrInvalid,
  unavailableProviderRead,
} from "#shared/payment-runtime/provider-read.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  PAYMENT_ID,
  PAYMENT_INTENT,
  PAYMENT_TIME,
  paymentSessionInput,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { paymentProviderRead } from "./fixtures.ts";

describeWithEnv("provider read helpers", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("distinguishes missing, mismatched, and matching provider values", async () => {
    const payment = await createPaymentSession(
      paymentSessionInput(),
      PAYMENT_TIME,
    );
    const readValue = makeProviderValueReader(
      (id: string) => Promise.resolve(id === "missing" ? null : { id }),
      (value) => value.id,
    );

    expect(
      checkProviderValue(
        null,
        "expected",
        (value: { id: string }) => value.id,
        payment,
        SESSION_RESOURCE,
      ),
    ).toMatchObject({ read: { status: "unavailable" } });
    expect(
      checkProviderValue(
        { id: "other" },
        "expected",
        (value) => value.id,
        payment,
        SESSION_RESOURCE,
      ),
    ).toMatchObject({ read: { reason: "mismatched_id", status: "invalid" } });
    expect(await readValue("matching", payment, SESSION_RESOURCE)).toEqual({
      value: { id: "matching" },
    });
    expect(await readValue("missing", null, SESSION_RESOURCE)).toMatchObject({
      read: { status: "unavailable" },
    });
  });

  test("validates shared provider facts and optional details", async () => {
    const payment = await createPaymentSession(
      paymentSessionInput(),
      PAYMENT_TIME,
    );
    const found = paymentProviderRead();
    if (found.status !== "found") throw new Error("Expected provider facts");

    expect(
      await foundProviderRead(payment, SESSION_RESOURCE, {
        createdAt: "2026-07-26T12:00:00.000Z",
        providerTotal: found.observation.providerTotal,
        session: found.observation.session,
        status: "pending",
      }),
    ).toMatchObject({ observation: { status: "pending" }, status: "found" });
    expect(
      await foundProviderRead(
        payment,
        {
          id: "wrong-session",
          kind: "stripe_checkout_session",
          provider: "stripe",
        },
        {
          createdAt: "2026-07-26T12:00:00.000Z",
          providerTotal: found.observation.providerTotal,
          session: found.observation.session,
          status: "pending",
        },
      ),
    ).toMatchObject({ reason: "mismatched_parent", status: "invalid" });
    expect(
      await foundProviderRead(null, SESSION_RESOURCE, {
        createdAt: "2026-07-26T12:00:00.000Z",
        providerTotal: found.observation.providerTotal,
        session: found.observation.session,
        status: "pending",
      }),
    ).toMatchObject({ reason: "malformed_response", status: "invalid" });
  });

  test("rejects provider facts without a creation time", () => {
    expect(() => providerFactDetails(undefined, undefined)).toThrow();
  });

  test("returns a valid provider read unchanged", async () => {
    const read = missingProviderRead(null, SESSION_RESOURCE);

    expect(
      await readProviderOrInvalid(null, SESSION_RESOURCE, () =>
        Promise.resolve(read),
      ),
    ).toEqual(read);
  });

  test("maps provider validation failures to malformed data", async () => {
    const invalidRead = async (): Promise<ProviderRead> => {
      v.parse(v.string(), 42);
      return missingProviderRead(null, SESSION_RESOURCE);
    };

    expect(
      await readProviderOrInvalid(null, SESSION_RESOURCE, invalidRead),
    ).toMatchObject({
      reason: "malformed_response",
      status: "invalid",
    });
  });

  test("does not hide non-validation provider failures", async () => {
    await expect(
      readProviderOrInvalid(null, SESSION_RESOURCE, () =>
        Promise.reject(new Error("Provider failed")),
      ),
    ).rejects.toThrow("Provider failed");
  });

  test("binds the local payment id into signed metadata", async () => {
    settings.setForTest({ stripe_secret_key: "sk_test_signed_metadata" });
    using _stripeAccount = stub(stripeApi, "retrieveAccount", () =>
      Promise.resolve({ id: "acct_signed_metadata" }),
    );
    const metadata = await metadataForStoredPayment(
      "stripe",
      PAYMENT_INTENT,
      1_000,
      PAYMENT_ID,
    );

    expect(await signedBookingIntentFromMetadata(metadata)).toMatchObject({
      localPaymentId: PAYMENT_ID,
      total: 1_000,
    });
    const proof = metadata.price_proof;
    if (proof === undefined) throw new Error("Expected signed metadata");
    expect(
      await signedBookingIntentFromMetadata({
        ...metadata,
        price_proof: proof.replace(PAYMENT_ID, "another-id"),
      }),
    ).toBeNull();

    expect(
      await foundProviderRead(null, SESSION_RESOURCE, {
        createdAt: "2026-07-26T12:00:00.000Z",
        metadata,
        providerTotal: { amount: 1_000, currency: "GBP" },
        session: SESSION_RESOURCE,
        status: "pending",
      }),
    ).toMatchObject({
      observation: { ownership: { localPaymentId: PAYMENT_ID } },
      status: "found",
    });
  });

  test("keeps signed pre-aggregate metadata adoptable", async () => {
    const metadata = v.parse(
      ProviderMetadataSchema,
      await assembleCheckoutMetadata("stripe", 1_000)(PAYMENT_INTENT),
    );

    expect(await signedBookingIntentFromMetadata(metadata)).toMatchObject({
      localPaymentId: null,
      total: 1_000,
    });
  });

  test("attaches ownership only when an aggregate has a provider session", async () => {
    const payment = await createPaymentSession(
      paymentSessionInput(),
      PAYMENT_TIME,
    );
    const unstaged = await createPaymentSession(
      paymentSessionInput("unstaged-payment", null),
      PAYMENT_TIME,
    );

    expect(unavailableProviderRead(payment, SESSION_RESOURCE)).toMatchObject({
      ownership: { localPaymentId: payment.id },
      status: "unavailable",
    });
    expect(missingProviderRead(unstaged, SESSION_RESOURCE)).toEqual({
      reason: "not_found",
      requested: SESSION_RESOURCE,
      status: "missing",
    });
  });
});
