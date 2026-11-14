/** Synthetic provider replies and persisted readback, not an orchestration copy. */
import { bookingEventGroup, mapBooking } from "#accounting/mappers.ts";
import { postTransferGroups } from "#accounting/store.ts";
import { generateKeyPair } from "#crypto/hybrid.ts";
import { ensureDefaultAttendeeStatus } from "#db/attendee-statuses.ts";
import { execute, queryAll, queryOne } from "#db/client.ts";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import {
  type ProcessedPayment,
  parseSessionFailure,
} from "#db/processed-payments.ts";
import { loadRefundAuthorityByReference } from "#db/provider-refund-authority.ts";
import { ALL_SETTINGS_KEYS, CONFIG_KEYS, settings } from "#db/settings.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import { taggedPaymentReference } from "#payment/provider-reference.ts";
import { findHeldAnchor } from "#routes/api/payment-processing/placeholder-resume.ts";
import type { CancellationFacts } from "#scripts/verify-models/subscriptions/cancellation-facts.ts";
import {
  type CancellationProbe,
  type CancellationProvider,
  cancellationLedgerSummary,
  cancellationProbe,
  observeCancellationRead,
  restoreCancellationProvider,
  withRestoredProvider,
} from "#scripts/verify-models/subscriptions/cancellation-support.ts";
import {
  MODEL_TIME,
  providerSubscription,
  seedBooking,
} from "#scripts/verify-models/subscriptions/environment.ts";
import { signPrice } from "#shared/payment-signature.ts";
import type { SessionMetadata } from "#shared/payments.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStart,
} from "#shared/subscriptions/plan.ts";

export const checkoutStart = (
  status: SubscriptionStart["status"] = "trialing",
): SubscriptionStart => ({
  amount: 600,
  id: "sub_failed",
  interval: "month",
  listingId: 1,
  status,
});
export const checkoutReference = taggedPaymentReference("stripe", "pi_failed");
export const CHECKOUT_SESSION = "cs_failed";

/** The public key belongs only to this synthetic run. The private half is unused. */
export const checkoutPublicKey = async (): Promise<string> =>
  (await generateKeyPair()).publicKey;
export const seedCheckout = async (publicKey: string): Promise<void> => {
  await settings.setRaw(CONFIG_KEYS.PUBLIC_KEY, publicKey);
  await settings.loadKeys(ALL_SETTINGS_KEYS);
  await ensureDefaultAttendeeStatus();
  await seedBooking({ attendeeId: 1, id: 1, listingId: 1, quantity: 0 });
  await execute("DELETE FROM listing_attendees WHERE id = 1");
};

/** A signed unreadable order is still ours, but cannot create plan rows. */
export const checkoutMetadata = (
  shape: "valid" | "unreadable" | "foreign",
): SessionMetadata => {
  const metadata: SessionMetadata = {
    _origin: "",
    address: "",
    allocations: "",
    answer_ids: "",
    balance_attendee_id: "",
    date: "",
    day_count: "",
    email: "model@example.invalid",
    items:
      shape === "unreadable" ? "{" : JSON.stringify([{ e: 1, p: 600, q: 1 }]),
    modifiers: "",
    name: "Synthetic subscriber",
    phone: "",
    price_proof: "",
    reservation_amount: "",
    site_token_index: "",
    special_instructions: "",
    tax_policy: JSON.stringify({ mode: "none" }),
    text_answer_ids: "",
    thank_you_url: "",
  };
  metadata.price_proof = `600.${signPrice(metadata, 600)}`;
  if (shape === "foreign") metadata.price_proof = `600.${"A".repeat(44)}`;
  return metadata;
};

/** A booked row or orphaned sale is durable evidence of a successful purchase. */
export const seedHonouredCheckout = async (
  orphaned: boolean,
): Promise<void> => {
  await seedBooking({
    attendeeId: 1,
    id: 2,
    listingId: 1,
    plan: { ...checkoutStart(), tax: 0 },
    quantity: 1,
  });
  await execute(
    "UPDATE listing_attendees SET ledger_event_group = ? WHERE id = 2",
    [await bookingEventGroup(CHECKOUT_SESSION)],
  );
  await postTransferGroups([
    await mapBooking({
      amountPaid: 600,
      attendeeId: 1,
      bookingFee: 0,
      eventId: CHECKOUT_SESSION,
      lines: [{ gross: 600, listingId: 1 }],
      modifiers: [],
      occurredAt: MODEL_TIME,
    }),
  ]);
  if (orphaned) await execute("DELETE FROM listing_attendees WHERE id = 2");
};

export type CheckoutProbe = CancellationProbe & {
  canEnd: boolean;
  observedStatus: SubscriptionStart["status"];
  providerStatus: SubscriptionStart["status"];
  cancelRefused: boolean;
  readRefused: boolean;
  refusal: ProviderRead<never>;
  confirmed: boolean;
  refunds: number;
  refundBeforeEnd: number;
  order: number;
  endOrder: number;
  refundOrder: number;
  heldAtCancel: number;
  planAtCancel: number;
};

/** Provider calls are observed here. The supplied answers are assumptions. */
export const withCheckoutProvider: CancellationProvider<
  SubscriptionStart,
  CheckoutProbe
> = async (start, fault, run) => {
  const probe: CheckoutProbe = {
    ...cancellationProbe(),
    cancelRefused: false,
    canEnd: true,
    confirmed: SUBSCRIPTION_NODE_OF[start.status] === "ended",
    endOrder: 0,
    heldAtCancel: 0,
    observedStatus: "canceled",
    order: 0,
    planAtCancel: 0,
    providerStatus: start.status,
    readRefused: false,
    refundBeforeEnd: 0,
    refundOrder: 0,
    refunds: 0,
    refusal: { reason: "rejected_request", status: "invalid" },
  };
  const restoreProvider = restoreCancellationProvider();
  const answer = (id: string) => {
    const status = probe.canEnd ? probe.observedStatus : "trialing";
    probe.providerStatus = status;
    if (SUBSCRIPTION_NODE_OF[status] === "ended" && !probe.confirmed) {
      probe.confirmed = true;
      probe.endOrder = ++probe.order;
    }
    return {
      resource: providerSubscription({
        ...start,
        id,
        status,
      }),
      status: "found" as const,
    };
  };
  stripeApi.cancelSubscription = async (id) => {
    probe.order++;
    probe.cancels++;
    probe.requestId = id;
    const held = await findHeldAnchor(checkoutReference, CHECKOUT_SESSION);
    probe.heldAtCancel = held.held === null ? 0 : 1;
    probe.planAtCancel = (
      await queryAll(
        "SELECT id FROM listing_attendees WHERE subscription_id = ? AND quantity = 0",
        [start.id],
      )
    ).length;
    if (fault === "refund-before-confirmed-end") {
      // Inject the missing ordering guard at the provider boundary. This sends
      // through the real durable refund authority before cancellation answers.
      await requestProviderRefund({
        callbackSessionId: CHECKOUT_SESSION,
        evidence: { kind: "read_provider" },
        mode: "send",
        reference: checkoutReference,
      });
    }
    return probe.cancelRefused ? probe.refusal : answer(id);
  };
  const readSubscription: typeof stripeApi.readSubscription = (id) => {
    probe.order++;
    observeCancellationRead(probe, "subscription", id, start.id);
    return Promise.resolve(probe.readRefused ? probe.refusal : answer(id));
  };
  stripeApi.readSubscription = (id) =>
    readSubscription(
      fault === "wrong-checkout-subscription-read" ? "sub_wrong" : id,
    );
  stripeApi.readPaidInvoices = (id) => {
    observeCancellationRead(probe, "invoice", id, start.id);
    return Promise.resolve({ resource: [], status: "found" as const });
  };
  stripeApi.readPaymentIntent = (id) =>
    Promise.resolve({
      resource: {
        id,
        latest_charge: {
          amount_captured: 600,
          amount_refunded: probe.refunds > 0 ? 600 : 0,
          captured: true,
          currency: "gbp",
          paid: true,
          status: "succeeded" as const,
        },
      },
      status: "found" as const,
    });
  stripeApi.refundCharge = (request) => {
    probe.refunds++;
    probe.refundOrder = ++probe.order;
    if (!probe.confirmed) probe.refundBeforeEnd++;
    return Promise.resolve({
      amount: request.charge.captured,
      kind: "completed" as const,
      proof: {
        kind: "named_refund" as const,
        refund: {
          id: "re_failed",
          kind: "stripe_refund" as const,
          parentId: request.paymentReference,
          provider: "stripe" as const,
        },
      },
    });
  };
  return withRestoredProvider(restoreProvider, probe, run);
};

type Readback = Pick<
  CancellationFacts["checkouts"][number],
  | "bookingId"
  | "attendeeId"
  | "listingId"
  | "after"
  | "quantity"
  | "planRows"
  | "planKept"
  | "held"
  | "authorityRows"
  | "authorityReturned"
  | "authorityLocal"
  | "refundLegs"
  | "refundCash"
  | "paymentLegs"
  | "durableRefunded"
  | "failureStored"
>;

export const checkoutReadback = async (
  start: SubscriptionStart,
): Promise<Readback> => {
  const plans = await queryAll<{
    id: number;
    attendee_id: number;
    listing_id: number;
    subscription_id: string;
    subscription_status: string;
    quantity: number;
    recurring_price: number;
    recurring_tax: number;
    recurring_interval: string;
  }>(
    "SELECT id, attendee_id, listing_id, subscription_id, subscription_status, quantity, recurring_price, recurring_tax, recurring_interval FROM listing_attendees WHERE subscription_id != ''",
  );
  const plan = plans[0];
  const anchors = await findHeldAnchor(checkoutReference, CHECKOUT_SESSION);
  const authority = await loadRefundAuthorityByReference(
    await paymentReferenceIndex(checkoutReference),
  );
  const legs = await queryAll<{ amount: number; kind: string }>(
    "SELECT amount, kind FROM transfers",
  );
  const callback = await queryOne<ProcessedPayment>(
    "SELECT * FROM processed_payments WHERE payment_session_id = ?",
    [CHECKOUT_SESSION],
  );
  const failure =
    callback === null ? null : await parseSessionFailure(callback.failure_data);
  const refund = cancellationLedgerSummary(legs, "refund_cash");
  return {
    after: plan?.subscription_status ?? "absent",
    attendeeId: plan?.attendee_id ?? -1,
    authorityLocal:
      authority?.state.kind === "completed"
        ? authority.state.local.kind
        : "absent",
    authorityReturned: authority?.refunded.amount ?? 0,
    authorityRows: authority === null ? 0 : 1,
    bookingId: plan?.id ?? -1,
    durableRefunded: failure?.refunded === true,
    failureStored: failure !== null,
    held: anchors.held === null ? 0 : 1,
    listingId: plan?.listing_id ?? -1,
    paymentLegs: legs.filter((leg) => leg.kind === "payment").length,
    planKept:
      plan !== undefined &&
      plan.subscription_id === start.id &&
      plan.recurring_price === start.amount &&
      plan.recurring_tax === 0 &&
      plan.recurring_interval === start.interval,
    planRows: plans.length,
    quantity: plan?.quantity ?? -1,
    refundCash: refund.cash,
    refundLegs: refund.matching,
  };
};
