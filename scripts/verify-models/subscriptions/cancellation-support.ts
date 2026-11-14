/** Shared provider observations and stored-ledger projections for cancellation. */
import { pick } from "@std/collections";
import { eventGroup } from "#accounting/refs.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { CancellationFault } from "#scripts/verify-models/subscriptions/cancellation-facts.ts";
import { stripeApi } from "#shared/stripe.ts";

export type CancellationProbe = {
  cancels: number;
  requestId: string;
  reads: number;
  readRequestId: string;
  readIdentityKept: boolean;
  invoiceReads: number;
  invoiceRequestId: string;
  invoiceIdentityKept: boolean;
};

export type CancellationProvider<Sample, Probe> = <Result>(
  sample: Sample,
  fault: CancellationFault,
  run: (probe: Probe) => Promise<Result>,
) => Promise<Result>;

export const cancellationProbe = (): CancellationProbe => ({
  cancels: 0,
  invoiceIdentityKept: true,
  invoiceReads: 0,
  invoiceRequestId: "",
  readIdentityKept: true,
  readRequestId: "",
  reads: 0,
  requestId: "",
});

const readFields = {
  invoice: ["invoiceReads", "invoiceRequestId", "invoiceIdentityKept"],
  subscription: ["reads", "readRequestId", "readIdentityKept"],
} as const;

/** Keep the subscription and invoice targets independent, including on replay. */
export const observeCancellationRead = (
  probe: CancellationProbe,
  boundary: keyof typeof readFields,
  id: string,
  expectedId: string,
): void => {
  const [count, request, identity] = readFields[boundary];
  probe[count]++;
  probe[request] = id;
  probe[identity] &&= id === expectedId;
};

/* jscpd:ignore-start -- a list of strings, not code */
const PROBE_FIELDS = [
  "cancels",
  "invoiceIdentityKept",
  "invoiceReads",
  "invoiceRequestId",
  "readIdentityKept",
  "readRequestId",
  "reads",
  "requestId",
] as const satisfies readonly (keyof CancellationProbe)[];
/* jscpd:ignore-end */

/** Keeps only the shared probe fields of an owner or checkout probe. */
export const cancellationProbeFacts = (
  probe: CancellationProbe,
): CancellationProbe => pick(probe, PROBE_FIELDS);

/** Capture before installing faults; restore every touched provider boundary. */
export const restoreCancellationProvider = (): (() => void) => {
  const previous = {
    cancelSubscription: stripeApi.cancelSubscription,
    readPaidInvoices: stripeApi.readPaidInvoices,
    readPaymentIntent: stripeApi.readPaymentIntent,
    readSubscription: stripeApi.readSubscription,
    refundCharge: stripeApi.refundCharge,
  };
  return () => Object.assign(stripeApi, previous);
};

/** Runs one observation with its probe, then restores the provider boundaries. */
export const withRestoredProvider = async <Probe, Result>(
  restore: () => void,
  probe: Probe,
  run: (probe: Probe) => Promise<Result>,
): Promise<Result> => {
  try {
    return await run(probe);
  } finally {
    restore();
  }
};

const refusedReads = [
  {
    refusal: { reason: "rejected_request", status: "invalid" },
    suffix: "refused",
  },
  { refusal: { status: "missing" }, suffix: "missing" },
  {
    refusal: { reason: "timeout", status: "unavailable" },
    suffix: "unavailable",
  },
] as const satisfies readonly {
  refusal: ProviderRead<never>;
  suffix: string;
}[];

/** The same invalid, missing, and unavailable outcomes reach both entrypoints. */
export const cancellationRefusalCases = <Flags extends object>(
  prefix: string,
  flags: Flags,
) =>
  refusedReads.map(({ refusal, suffix }) => ({
    ...flags,
    refusal,
    scenario: `${prefix}-${suffix}`,
  }));

type CancellationLeg = {
  amount: number;
  kind: string;
  event_group?: string;
};

/** Count all selected group legs separately from the requested cash kind. */
export const cancellationLedgerSummary = (
  rows: readonly CancellationLeg[],
  kind: string,
  group?: string,
) => {
  let cash = 0;
  let matching = 0;
  let legs = 0;
  for (const row of rows) {
    if (group !== undefined && row.event_group !== group) continue;
    legs++;
    if (row.kind !== kind) continue;
    matching++;
    cash += row.amount;
  }
  return { cash, legs, matching };
};

export const cancellationInvoiceEvidence = async (
  rows: readonly CancellationLeg[],
  invoice: string,
) => {
  const group = await eventGroup(["renewal", invoice]);
  return {
    ...cancellationLedgerSummary(rows, "payment", group),
    group,
    invoice,
  };
};
