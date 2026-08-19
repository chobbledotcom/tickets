import { type Spy, spy, stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#payment/refund-attempt.ts";
import type { ChargeMoney } from "#payment/resources.ts";
import type { PaymentReviewReason } from "#payment/review.ts";
import type { PaymentReviewChange } from "#payment/row-transitions.ts";
import { handleRequest } from "#routes";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import { paymentsApi } from "#shared/payments.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import {
  mockFormRequest,
  mockProviderType,
  withMocks,
} from "#test-utils/mocks.ts";
import {
  acceptedRefund,
  chargeMoney,
  completedRefund,
  foundCharge,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";
import type { Attendee, Listing } from "#types";

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

type RefundBehavior = (request: RefundRequest) => Promise<RefundAttemptResult>;
type RefundSpy = Spy<unknown, [RefundRequest], Promise<RefundAttemptResult>>;
type RefundCheck = (mockRefund: RefundSpy) => Promise<void> | void;
type ChargeBehavior =
  | ChargeMoney
  | ((reference: string) => Promise<ChargeMoney>);
type RefundMockOptions = {
  charge?: ChargeBehavior;
};

const chargeResult = (
  behavior: ChargeBehavior,
): ((reference: string) => Promise<ChargeMoney>) =>
  typeof behavior === "function" ? behavior : () => Promise.resolve(behavior);

/** A provider that completes the exact refund it was asked to send. */
export const refundCompletes = (
  request: RefundRequest,
): Promise<RefundAttemptResult> =>
  Promise.resolve(completedRefund(request.charge));

/** A provider that accepts the exact refund but has not settled it yet. */
export const refundStaysPending = (
  request: RefundRequest,
): Promise<RefundAttemptResult> =>
  Promise.resolve(acceptedRefund(request.charge));

/** A provider that refuses the refund without moving money. */
export const refundIsRejected = (
  _request: RefundRequest,
): Promise<RefundAttemptResult> =>
  Promise.resolve({ kind: "rejected", reason: "failed" });

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
  checkRefund: RefundCheck,
): Promise<void> => {
  await withRefundMock(refundCompletes, async (mockRefund) => {
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
  fn: (mockRefund: RefundSpy) => Promise<void>,
  options: RefundMockOptions = {},
): Promise<void> => {
  await withStripeProvider(async (provider) => {
    const mockRefund = spy(refundBehavior);
    const refundCharge = stub(
      provider,
      "refundCharge",
      (request: RefundRequest): Promise<RefundAttemptResult> =>
        mockRefund(request),
    );
    const readMoney = chargeResult(options.charge ?? chargeMoney());
    const readCharge = stub(provider, "readCharge", async (reference) =>
      foundCharge(await readMoney(reference)),
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
  existingUnrecorded: ReadonlyMap<number, readonly string[]> = new Map(),
  existingReviews: ReadonlyMap<string, PaymentReviewReason> = new Map(),
): RowClaim & {
  recorded: string[][];
  released: string[][];
  reviewChanges: ReadonlyMap<string, PaymentReviewChange>[];
  unrecorded: string[][];
} => {
  const recorded: string[][] = [];
  const released: string[][] = [];
  const reviewChanges: ReadonlyMap<string, PaymentReviewChange>[] = [];
  const unrecorded: string[][] = [];
  return {
    claim: (attendees, admit) => {
      const returned = new Set(
        attendees.flatMap(({ references }) =>
          references.flatMap((reference) =>
            reference.refundState === "completed" ? [reference.index] : [],
          ),
        ),
      );
      if (admit !== undefined && !admit({ attendees, returned })) {
        return Promise.resolve({ kind: "not_admitted" as const });
      }
      return Promise.resolve({
        commandId: "test-command",
        held,
        heldSince: "2026-08-10T12:00:00.000Z",
        kind: "claimed",
        phases: new Map(
          [...held.values()]
            .flat()
            .map((sessionId) => [sessionId, "checking" as const]),
        ),
        returned,
        reviews: existingReviews,
        shared: new Map(),
        unrecorded: existingUnrecorded,
      });
    },
    recorded,
    released,
    reviewChanges,
    settle: ({ rows }) => {
      released.push(
        [...rows]
          .filter(([, change]) => change.claim === "release")
          .map(([sessionId]) => sessionId),
      );
      reviewChanges.push(
        new Map(
          [...rows].flatMap(([sessionId, change]) =>
            change.review === undefined
              ? []
              : [[sessionId, change.review] as const],
          ),
        ),
      );
      recorded.push(
        [...rows]
          .filter(([, change]) => change.books === "recorded")
          .map(([sessionId]) => sessionId),
      );
      unrecorded.push(
        [...rows]
          .filter(([, change]) => change.books === "unrecorded")
          .map(([sessionId]) => sessionId),
      );
      return Promise.resolve();
    },
    unrecorded,
  };
};
