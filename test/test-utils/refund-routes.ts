import { type Stub, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { type PaymentRefundResult, paymentsApi } from "#shared/payments.ts";
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
type ProviderRefundBehavior =
  | PaymentRefundResult
  | boolean
  | ((reference: string) => Promise<boolean | PaymentRefundResult>);
type RefundMockOptions = {
  alreadyRefunded?: boolean;
};

const providerRefundResult =
  (behavior: ProviderRefundBehavior) =>
  async (reference: string): Promise<PaymentRefundResult> => {
    const value =
      typeof behavior === "function" ? await behavior(reference) : behavior;
    return typeof value === "boolean" ? (value ? "refunded" : "failed") : value;
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

/** Run `body` with Stripe configured as the provider and `isPaymentRefunded`
 *  stubbed to `probe`. The refresh-payment route only reads refund status (it
 *  never issues a refund), so — unlike {@link withRefundMock} — this stubs just
 *  that one method. Passes the stub to `body` (so a caller can read its call
 *  args) and returns whatever `body` returns. */
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
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      await body(stripePaymentProvider);
    },
  );
};

export const withRefreshPaymentProbe = async <T>(
  probe: (reference: string) => Promise<boolean>,
  body: (mockRefunded: Stub) => Promise<T>,
): Promise<T> => {
  let result!: T;
  await withStripeProvider(async (provider) => {
    const mockRefunded = stub(provider, "isPaymentRefunded", probe);
    try {
      result = await body(mockRefunded);
    } finally {
      mockRefunded.restore();
    }
  });
  return result;
};

export const withRefundMock = async (
  refundBehavior: ProviderRefundBehavior,
  fn: (mockRefund: Stub) => Promise<void>,
  options: RefundMockOptions = {},
): Promise<void> => {
  await withStripeProvider(async (provider) => {
    const mockRefund = stub(
      provider,
      "refundPayment",
      providerRefundResult(refundBehavior),
    );
    const mockRefunded = stub(provider, "isPaymentRefunded", () =>
      Promise.resolve(options.alreadyRefunded ?? false),
    );
    try {
      await fn(mockRefund);
    } finally {
      mockRefunded.restore();
      mockRefund.restore();
    }
  });
};
