import { type Spy, spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { settings } from "#shared/db/settings.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { RefundCapability } from "#shared/payment/row-state.ts";
import { paymentsApi } from "#shared/payments.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import {
  mockFormRequest,
  mockProviderType,
  withMocks,
} from "#test-utils/mocks.ts";
import {
  chargeMoney,
  completedRefund,
  foundCharge,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

/** What a "was it refunded?" answer looks like as charge money. */
const asChargeMoney = (refunded: boolean): ChargeMoney =>
  refunded ? fullyRefundedMoney() : chargeMoney();

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

type RefundCheck = (mockRefund: Spy) => Promise<void> | void;
type RefundAnswer = boolean | RefundAttemptResult;
type RefundBehavior =
  | RefundAnswer
  | ((reference: string) => Promise<RefundAnswer>);
type AlreadyRefundedBehavior =
  | boolean
  | ((reference: string) => Promise<boolean>);
type RefundMockOptions = {
  alreadyRefunded?: AlreadyRefundedBehavior;
};

const refundResult = (
  behavior: RefundBehavior,
): ((reference: string) => Promise<RefundAnswer>) =>
  typeof behavior === "function" ? behavior : () => Promise.resolve(behavior);

const refundedResult = (
  behavior: AlreadyRefundedBehavior,
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

/** Runs the refresh-payment route against a provider that reports exactly the
 *  money each reference names. Use this when the answer is more than "was it
 *  refunded" — a part-returned charge, say. */
export const withRefreshPaymentMoney = async <T>(
  probe: (reference: string) => Promise<ChargeMoney>,
  body: (mockRefunded: Spy) => Promise<T>,
): Promise<T> => {
  let result!: T;
  await withStripeProvider(async (provider) => {
    const mockRefunded = spy(probe);
    const readCharge = stub(provider, "readCharge", async (reference) =>
      foundCharge(await mockRefunded(reference)),
    );
    try {
      result = await body(mockRefunded);
    } finally {
      readCharge.restore();
    }
  });
  return result;
};

/** The refresh-payment route only reads refund status, so `probe` answers a
 *  plain "was it refunded": true reads as every penny back, false as a charge
 *  nothing has gone back on. */
export const withRefreshPaymentProbe = <T>(
  probe: (reference: string) => Promise<boolean>,
  body: (mockRefunded: Spy) => Promise<T>,
): Promise<T> =>
  withRefreshPaymentMoney(
    async (reference) => asChargeMoney(await probe(reference)),
    body,
  );

export const withRefundMock = async (
  refundBehavior: RefundBehavior,
  fn: (mockRefund: Spy) => Promise<void>,
  options: RefundMockOptions = {},
): Promise<void> => {
  await withStripeProvider(async (provider) => {
    const mockRefund = spy(refundResult(refundBehavior));
    const refundCharge = stub(
      provider,
      "refundCharge",
      async (request: RefundRequest): Promise<RefundAttemptResult> => {
        const answer = await mockRefund(request.paymentReference);
        return typeof answer === "boolean"
          ? answer
            ? completedRefund(request.charge)
            : { kind: "rejected", reason: "failed" }
          : answer;
      },
    );
    const alreadyRefunded = refundedResult(options.alreadyRefunded ?? false);
    const readCharge = stub(provider, "readCharge", async (reference) =>
      foundCharge(asChargeMoney(await alreadyRefunded(reference))),
    );
    try {
      await fn(mockRefund);
    } finally {
      readCharge.restore();
      refundCharge.restore();
    }
  });
};

/** A row claim that always grants, holding exactly the rows it is told the run
 *  loaded, and recording every release and every row it marked as money the
 *  ledger has not caught up with. The durable claim's own rules are covered in
 *  `test/shared/db/payment-claim.test.ts`. */
export const grantingRowClaim = (
  held: ReadonlyMap<number, readonly string[]> = new Map(),
  inherited: ReadonlyMap<number, RefundCapability> = new Map(),
): RowClaim & { released: string[][]; unrecorded: string[][] } => {
  const released: string[][] = [];
  const unrecorded: string[][] = [];
  return {
    claim: () =>
      Promise.resolve({
        held,
        heldSince: "2026-08-10T12:00:00.000Z",
        inherited,
        kind: "claimed",
        returned: new Set<string>(),
      }),
    release: ({ sessionIds, unrecorded: marked = new Set() }) => {
      released.push([...sessionIds]);
      unrecorded.push([...marked]);
      return Promise.resolve();
    },
    released,
    unrecorded,
  };
};
