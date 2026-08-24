/* jscpd:ignore-start -- imports */
import { queryAll, queryOnePrimary } from "#db/client.ts";
import {
  loadPaymentReference,
  paymentReferenceIndex,
} from "#db/payment-reference-store.ts";
import { type Money, money } from "#payment/money.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import {
  type RefundOwnerChoices,
  refundOwnerChoices,
} from "#payment/refund-authority-choice.ts";
import { refundAuthorityWorkSql } from "#payment/refund-authority-lifecycle.ts";
import {
  type RefundAuthorityState,
  type RefundAuthorityStateName,
  type RefundOwnerChoiceReason,
  readRefundAuthorityState,
  refundLocalMirror,
  refundStateMirror,
} from "#payment/refund-authority-state.ts";
import type {
  RefundConflictDecision,
  RefundOwnerDecision,
} from "#payment/refund-conflict-decision.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import { writeProviderRefundCursor } from "#shared/provider-refund-cursor.ts";
import { isPaymentProvider, type PaymentProviderType } from "#types";

/* jscpd:ignore-end */

const PAGE_SIZE = 20;
const CASE_SQL = refundAuthorityWorkSql("charge.");

type ProviderRefundCaseState = RefundAuthorityStateName;

export interface ProviderRefundCaseSummary {
  readonly captured: Money;
  readonly id: number;
  readonly provider: PaymentProviderType;
  readonly refunded: Money;
  readonly revision: number;
  readonly state: ProviderRefundCaseState;
  readonly updatedAt: number;
}

interface ProviderRefundCaseDetail extends ProviderRefundCaseSummary {
  readonly reference: TaggedPaymentReference;
}

interface OwnerChoiceProviderRefundCase extends ProviderRefundCaseDetail {
  readonly choices: RefundOwnerChoices;
  readonly decision: RefundOwnerDecision;
  readonly reason: RefundOwnerChoiceReason;
  readonly state: "needs_owner_choice";
}

interface ProviderCheckRefundCase extends ProviderRefundCaseDetail {
  readonly choices: null;
  readonly decision: RefundConflictDecision;
  readonly reason: "provider_conflict";
  readonly state: "needs_provider_check";
}

interface AutomaticProviderRefundCase extends ProviderRefundCaseDetail {
  readonly choices: null;
  readonly decision: null;
  readonly reason: null;
  readonly state: Exclude<
    ProviderRefundCaseState,
    "needs_owner_choice" | "needs_provider_check"
  >;
}

export type ProviderRefundCase =
  | AutomaticProviderRefundCase
  | OwnerChoiceProviderRefundCase
  | ProviderCheckRefundCase;

type RefundAttentionState = Extract<
  RefundAuthorityState,
  { kind: "needs_owner_choice" | "needs_provider_check" }
>;

const refundAttentionDetail = <State extends RefundAttentionState>(
  detail: ProviderRefundCaseDetail,
  state: State,
): ProviderRefundCaseDetail & Pick<State, "decision" | "reason"> => ({
  ...detail,
  decision: state.decision,
  reason: state.reason,
});

export interface ProviderRefundCasePage {
  readonly cases: readonly ProviderRefundCaseSummary[];
  readonly nextCursor: string | null;
}

type Whole = number | bigint;

interface SummaryRow {
  readonly captured_amount: Whole;
  readonly currency: string;
  readonly id: Whole;
  readonly provider: string;
  readonly refunded_amount: Whole;
  readonly revision: Whole;
  readonly state: ProviderRefundCaseState;
  readonly updated_at: Whole;
}

export interface StoredProviderRefundCase extends SummaryRow {
  readonly capability: string;
  readonly provider_reference: string;
  readonly reference_index: string;
  readonly refund_local_state: string;
  readonly refund_state: string;
}

export const refundCaseWholeNumber = (
  value: Whole,
  name: string,
  minimum: number,
): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`payment_charges.${name} is not a safe whole number`);
  }
  return number;
};

const providerFrom = (value: string): PaymentProviderType => {
  if (!isPaymentProvider(value)) {
    throw new Error("payment_charges.provider is invalid");
  }
  return value;
};

export const providerRefundCaseSummary = (
  row: SummaryRow,
): ProviderRefundCaseSummary => {
  const captured = money(row.captured_amount, row.currency);
  if (captured === null) {
    throw new Error("payment_charges captured money is invalid");
  }
  const refunded = money(row.refunded_amount, row.currency);
  if (refunded === null) {
    throw new Error("payment_charges refunded money is invalid");
  }
  return {
    captured,
    id: refundCaseWholeNumber(row.id, "id", 1),
    provider: providerFrom(row.provider),
    refunded,
    revision: refundCaseWholeNumber(row.revision, "refund_revision", 1),
    state: row.state,
    updatedAt: refundCaseWholeNumber(row.updated_at, "updated_at", 0),
  };
};

export const readProviderRefundCaseState = (
  row: StoredProviderRefundCase,
): RefundAuthorityState => {
  const state = readRefundAuthorityState(
    row.refund_state,
    "payment_charges.refund_state",
  );
  if (
    refundStateMirror(state) !== row.state ||
    refundLocalMirror(state) !== row.refund_local_state ||
    state.request.capability !== row.capability
  ) {
    throw new Error("Payment charge refund-state mirrors do not match");
  }
  const provider = providerFrom(row.provider);
  if (
    state.request.capability !== PAYMENT_PROVIDERS[provider].refundCapability
  ) {
    throw new Error("Payment charge refund capability does not match provider");
  }
  return state;
};

export const loadProviderRefundCaseReference = async (
  row: StoredProviderRefundCase,
  privateKey: CryptoKey,
): Promise<TaggedPaymentReference> => {
  const reference = await loadPaymentReference(
    row.provider_reference,
    privateKey,
    "payment_charges.provider_reference",
  );
  if (reference.kind !== "tagged") {
    throw new Error("Payment charge reference is not provider-qualified");
  }
  if (
    reference.provider !== providerFrom(row.provider) ||
    (await paymentReferenceIndex(reference)) !== row.reference_index
  ) {
    throw new Error("Payment charge reference does not match its blind index");
  }
  return reference;
};

export const listProviderRefundCases = async (
  after?: number,
): Promise<ProviderRefundCasePage> => {
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 1)) {
    throw new Error("Refund-case boundary must be a positive safe integer");
  }
  const rows = await queryAll<SummaryRow>(
    `SELECT charge.id,
            charge.provider,
            charge.captured_amount,
            charge.currency,
            charge.refunded_amount,
            charge.refund_revision AS revision,
            charge.refund_state_name AS state,
            charge.updated_at
       FROM payment_charges AS charge
      WHERE ${CASE_SQL}
        ${after === undefined ? "" : "AND charge.id > ?"}
      ORDER BY charge.id
      LIMIT ?`,
    after === undefined ? [PAGE_SIZE + 1] : [after, PAGE_SIZE + 1],
  );
  const page = rows.slice(0, PAGE_SIZE).map(providerRefundCaseSummary);
  return {
    cases: page,
    nextCursor:
      rows.length > PAGE_SIZE
        ? await writeProviderRefundCursor(page[page.length - 1]!.id)
        : null,
  };
};

const detailRow = (id: number): Promise<StoredProviderRefundCase | null> =>
  queryOnePrimary<StoredProviderRefundCase>(
    `SELECT charge.id,
            charge.provider,
            charge.provider_reference,
            charge.reference_index,
            charge.capability,
            charge.captured_amount,
            charge.currency,
            charge.refunded_amount,
            charge.refund_state,
            charge.refund_state_name AS state,
            charge.refund_local_state,
            charge.refund_revision AS revision,
            charge.updated_at
       FROM payment_charges AS charge
      WHERE charge.id = ?
         AND ${CASE_SQL}
      LIMIT 1`,
    [id],
  );

export const loadProviderRefundCase = async (
  id: number,
  privateKey: CryptoKey,
): Promise<ProviderRefundCase | null> => {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = await detailRow(id);
  if (row === null) return null;
  const summary = providerRefundCaseSummary(row);
  const state = readProviderRefundCaseState(row);
  const reference = await loadProviderRefundCaseReference(row, privateKey);
  const detail = { ...summary, reference };
  if (state.kind === "needs_owner_choice") {
    return {
      ...refundAttentionDetail(detail, state),
      choices: refundOwnerChoices(state),
      state: state.kind,
    };
  }
  if (state.kind === "needs_provider_check") {
    return {
      ...refundAttentionDetail(detail, state),
      choices: null,
      state: state.kind,
    };
  }
  return {
    ...detail,
    choices: null,
    decision: null,
    reason: null,
    state: state.kind,
  };
};
