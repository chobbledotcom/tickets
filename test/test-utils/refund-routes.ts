import { type Stub, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { paymentsApi } from "#shared/payments.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import {
  mockFormRequest,
  mockProviderType,
  withMocks,
} from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

export const refundUrl = (attendeeId: number) =>
  `/admin/attendees/${attendeeId}/refund`;

export const refundAllUrl = (listingId: number) =>
  `/admin/listing/${listingId}/refund-all`;

type RefundRouteCtx = {
  attendee: Pick<Attendee, "id">;
  cookie: string;
  csrfToken: string;
  listing: Pick<Listing, "id" | "name">;
};

type RefundCheck = (mockRefund: Stub) => Promise<void> | void;
type RefundBehavior = boolean | ((reference: string) => Promise<boolean>);
const refundResult =
  (behavior: RefundBehavior) =>
  async (
    charge: import("#shared/db/payments/types.ts").PaymentCharge,
  ): Promise<import("#shared/payment-state/resources.ts").RefundResolution> => {
    const refunded =
      typeof behavior === "function"
        ? await behavior(charge.providerReference.id)
        : behavior;
    return refunded
      ? { amount: charge.captured, status: "completed" }
      : {
          amount: charge.refunded,
          reason: "provider_failed",
          status: "failed",
        };
  };

/** POST the refund-all confirmation form for a listing as the owner. */
export const postRefundAll = async (listing: {
  id: number;
  name: string;
}): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      refundAllUrl(listing.id),
      { confirm_identifier: listing.name, csrf_token: await testCsrfToken() },
      await testCookie(),
    ),
  );

/** POST the single-attendee refund form. Defaults to John Doe + ctx csrf. */
export const submitRefund = (
  { attendee, csrfToken, cookie }: RefundRouteCtx,
  overrides: Record<string, string> = {},
) =>
  handleRequest(
    mockFormRequest(
      refundUrl(attendee.id),
      { confirm_identifier: "John Doe", csrf_token: csrfToken, ...overrides },
      cookie,
    ),
  );

/** POST the refund-all form. Defaults to listing name + ctx csrf. */
export const submitRefundAll = (
  { listing, csrfToken, cookie }: RefundRouteCtx,
  overrides: Record<string, string> = {},
) =>
  handleRequest(
    mockFormRequest(
      refundAllUrl(listing.id),
      { confirm_identifier: listing.name, csrf_token: csrfToken, ...overrides },
      cookie,
    ),
  );

export const expectSingleRefundIssued = async (
  ctx: RefundRouteCtx,
  checkRefund: RefundCheck = () => {},
): Promise<void> => {
  await withRefundMock(true, async (mockRefund) => {
    const response = await submitRefund(ctx);
    await expectFlashRedirect(
      `/admin/attendees/${ctx.attendee.id}/actions`,
      "Refund issued",
    )(response);
    await checkRefund(mockRefund);
  });
};

/** Run `body` with Stripe configured and a typed charge refund result. */
type StripeProvider =
  typeof import("#shared/stripe-provider.ts")["stripePaymentProvider"];

/** Configure Stripe as the active provider and hand its provider object to
 *  `body`, which stubs whichever methods it needs. Centralises the
 *  getConfiguredProvider stub + dynamic stripePaymentProvider import that every
 *  refund/refresh route helper below builds on. */
const withStripeProvider = async (
  body: (provider: StripeProvider) => Promise<void>,
): Promise<void> => {
  await withMocks(
    () =>
      stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      ),
    async () => {
      const { settings } = await import("#shared/db/settings.ts");
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const { stripeApi } = await import("#shared/stripe.ts");
      // Only stand in an account when the test has not set Stripe up itself.
      // A payment made by a fixture belongs to the account that was configured
      // when it was made, and a refund only goes out on its own account, so
      // swapping the account here would refuse every one of those refunds.
      const previousKey = settings.stripe.secretKey;
      const standInAccount = previousKey === "";
      const account = standInAccount
        ? stub(stripeApi, "retrieveAccount", () =>
            Promise.resolve({ id: "acct_admin_refunds" }),
          )
        : null;
      if (standInAccount) {
        settings.setForTest({ stripe_secret_key: "sk_test_admin_refunds" });
      }
      try {
        await body(stripePaymentProvider);
      } finally {
        account?.restore();
        if (standInAccount) settings.clearTestOverride("stripe_secret_key");
      }
    },
  );
};

export const withRefreshPaymentProbe = async <T>(
  probe: (reference: string) => Promise<boolean>,
  body: (mockRefunded: Stub) => Promise<T>,
): Promise<T> => {
  let result!: T;
  await withStripeProvider(async (provider) => {
    const mockRefunded = stub(provider, "refundCharge", refundResult(probe));
    try {
      result = await body(mockRefunded);
    } finally {
      mockRefunded.restore();
    }
  });
  return result;
};

export const withRefundMock = async (
  refundBehavior: RefundBehavior,
  fn: (mockRefund: Stub) => Promise<void>,
): Promise<void> => {
  await withStripeProvider(async (provider) => {
    const mockRefund = stub(
      provider,
      "refundCharge",
      refundResult(refundBehavior),
    );
    try {
      await fn(mockRefund);
    } finally {
      mockRefund.restore();
    }
  });
};
