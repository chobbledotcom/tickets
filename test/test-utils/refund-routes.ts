import { type Stub, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import type { RowClaim } from "#routes/admin/refunds/provider.ts";
import { settings } from "#shared/db/settings.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import { paymentsApi } from "#shared/payments.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { chargeMoney, fullyRefundedMoney } from "#test-utils/payment-state.ts";

/** What a "was it refunded?" answer looks like as charge money. */
const asChargeMoney = (refunded: boolean): ChargeMoney =>
  refunded ? fullyRefundedMoney() : chargeMoney();

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
type RefundMockOptions = {
  alreadyRefunded?: RefundBehavior;
};

const refundResult = (
  behavior: RefundBehavior,
): ((reference: string) => Promise<boolean>) =>
  typeof behavior === "function" ? behavior : () => Promise.resolve(behavior);

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

/** Run `body` with Stripe configured as the provider and the charge-money read
 *  answering `probe`: true reads as every penny already back, false as a charge
 *  nothing has gone back on. The refresh-payment route only reads refund status
 *  (it never issues a refund), so — unlike {@link withRefundMock} — this stubs
 *  just that one method. Passes the stub to `body` (so a caller can read its call
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
  await settings.update.stripe.secretKey("sk_test_refund_routes");
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
    const mockRefunded = stub(
      provider,
      "readChargeMoneyOrNull",
      async (reference) => asChargeMoney(await probe(reference)),
    );
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
  options: RefundMockOptions = {},
): Promise<void> => {
  await withStripeProvider(async (provider) => {
    const mockRefund = stub(
      provider,
      "refundPayment",
      refundResult(refundBehavior),
    );
    const alreadyRefunded = refundResult(options.alreadyRefunded ?? false);
    const mockRefunded = stub(
      provider,
      "readChargeMoneyOrNull",
      async (reference) => asChargeMoney(await alreadyRefunded(reference)),
    );
    try {
      await fn(mockRefund);
    } finally {
      mockRefunded.restore();
      mockRefund.restore();
    }
  });
};

/**
 * A row claim that always grants and records what it released. Lets the tally
 * and ordering rules be tested without a database; the durable claim's own
 * rules are covered in `test/shared/db/payment-claim.test.ts`.
 */
export const grantingRowClaim = (): RowClaim & {
  released: string[][];
} => {
  const released: string[][] = [];
  return {
    claim: () =>
      Promise.resolve({
        heldSince: "2026-08-10T12:00:00.000Z",
        kind: "claimed",
        sessionIds: [],
      }),
    release: (sessionIds: readonly string[]) => {
      released.push([...sessionIds]);
      return Promise.resolve();
    },
    released,
  };
};
