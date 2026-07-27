import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, inPlaceholders, resultRows } from "#shared/db/client.ts";
import {
  openPaymentCaseData,
  paymentStoredJson,
} from "#shared/db/payments/codecs.ts";
import type { PreparedLegacyPayment } from "#shared/db/payments/legacy-copy.ts";
import { sameJson } from "#shared/same-json.ts";

type CopiedSession = {
  account_id: null;
  attendee_id: number | null;
  booking_intent: null;
  completion_state: string;
  created_at: number;
  expected_amount: null;
  expected_currency: null;
  id: string;
  legacy_runtime: EnvKeyEncrypted;
  mode: null;
  origin: string;
  provider: string | null;
  result: string | null;
  result_state: string;
  state: string;
  ticket_state: string;
  ticket_tokens: string | null;
  updated_at: number;
};

type CopiedCharge = {
  captured_amount: null;
  currency: null;
  origin: string;
  payment_id: string;
  provider: null;
  provider_reference: string;
  provider_refunded_at: string | null;
  reference_index: null;
  refund_state: string;
  refunded_amount: null;
  resource_kind: null;
  legacy_source: string;
  created_at: number;
  updated_at: number;
  observed_at: number;
};

type CopiedCase = {
  evidence: EnvKeyEncrypted;
  payment_id: string;
  reason: string;
  resource: EnvKeyEncrypted;
  state: string;
};

const queryPayments = (ids: string[], sql: string) => execute(sql, ids);

const verifyPayment = async (
  payment: PreparedLegacyPayment,
  session: CopiedSession | undefined,
  charge: CopiedCharge | undefined,
  cases: Map<string, CopiedCase>,
): Promise<void> => {
  const runtime =
    session === undefined
      ? null
      : await paymentStoredJson.legacyRuntime.open(
          session.legacy_runtime,
          `payment_sessions.legacy_runtime for ${payment.id}`,
        );
  const fields = payment.fields;
  const sessionMatches =
    session?.origin === "legacy" &&
    session.mode === null &&
    session.account_id === null &&
    session.expected_amount === null &&
    session.expected_currency === null &&
    session.booking_intent === null &&
    session.created_at === fields.createdAt &&
    session.updated_at === fields.updatedAt &&
    session.attendee_id === fields.attendeeId &&
    session.completion_state === fields.completionState &&
    session.provider === fields.provider &&
    session.result === fields.result &&
    session.result_state === fields.resultState &&
    session.state === fields.state &&
    session.ticket_state === fields.ticketState &&
    session.ticket_tokens === fields.ticketTokens &&
    sameJson(runtime, payment.runtime);
  const processed = payment.runtime.processedPayment;
  const attendee = payment.runtime.attendeePayment;
  const sourceReference =
    processed?.paymentReference || attendee?.paymentReference;
  const sourceTime = processed?.processedAt ?? attendee?.createdAt;
  const sourceName =
    processed === null ? attendee?.source : "processed_payments";
  const chargeMatches =
    sourceReference === undefined || sourceReference === ""
      ? charge === undefined
      : charge?.origin === "legacy" &&
        charge.provider === null &&
        charge.resource_kind === null &&
        charge.provider_reference === sourceReference &&
        charge.reference_index === null &&
        charge.captured_amount === null &&
        charge.currency === null &&
        charge.refunded_amount === null &&
        charge.refund_state === "unknown" &&
        charge.legacy_source === sourceName &&
        charge.created_at === Date.parse(sourceTime!) &&
        charge.updated_at === Date.parse(sourceTime!) &&
        charge.observed_at === Date.parse(sourceTime!) &&
        charge.provider_refunded_at === (processed?.providerRefundedAt || null);
  const actionsMatch = await Promise.all(
    payment.actions.map(async (expected) => {
      const copied = cases.get(`${payment.id}:${expected.reason}`);
      if (copied === undefined || copied.state !== expected.state) return false;
      const { resource, evidence } = await openPaymentCaseData(
        copied.resource,
        copied.evidence,
        payment.id,
      );
      return (
        sameJson(resource, expected.resource) &&
        sameJson(evidence, expected.evidence)
      );
    }),
  );
  if (!sessionMatches || !chargeMatches || actionsMatch.includes(false)) {
    throw new Error(
      `Legacy payment ${payment.id} was not copied exactly ` +
        `(session=${sessionMatches}, charge=${chargeMatches}, cases=${actionsMatch.join(",")})`,
    );
  }
};

export const verifyLegacyPayments = async (
  payments: PreparedLegacyPayment[],
): Promise<void> => {
  const ids = payments.map((payment) => payment.id);
  const placeholders = inPlaceholders(ids);
  const [sessionResult, chargeResult, caseResult] = await Promise.all([
    queryPayments(
      ids,
      `SELECT id, origin, provider, mode, account_id, expected_amount,
              expected_currency, booking_intent, state, created_at, updated_at,
              attendee_id, result_state, result, ticket_state, ticket_tokens,
              completion_state, legacy_runtime
            FROM payment_sessions WHERE id IN (${placeholders})`,
    ),
    queryPayments(
      ids,
      `SELECT payment_id, origin, provider, resource_kind,
              provider_reference, reference_index, captured_amount, currency,
              refunded_amount, refund_state, provider_refunded_at,
              legacy_source, created_at, updated_at, observed_at
            FROM payment_charges
            WHERE origin = 'legacy' AND payment_id IN (${placeholders})`,
    ),
    queryPayments(
      ids,
      `SELECT payment_id, resource, reason, state, evidence
            FROM payment_cases WHERE payment_id IN (${placeholders})`,
    ),
  ]);
  const sessions = new Map(
    resultRows<CopiedSession>(sessionResult).map((session) => [
      session.id,
      session,
    ]),
  );
  const charges = new Map(
    resultRows<CopiedCharge>(chargeResult).map((charge) => [
      charge.payment_id,
      charge,
    ]),
  );
  const cases = new Map(
    resultRows<CopiedCase>(caseResult).map((paymentCase) => [
      `${paymentCase.payment_id}:${paymentCase.reason}`,
      paymentCase,
    ]),
  );
  await Promise.all(
    payments.map((payment) =>
      verifyPayment(
        payment,
        sessions.get(payment.id),
        charges.get(payment.id),
        cases,
      ),
    ),
  );
};
