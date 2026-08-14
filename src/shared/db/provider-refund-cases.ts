/* jscpd:ignore-start -- imports */
import { queryAll, queryOnePrimary } from "#shared/db/client.ts";
import {
  loadPaymentReference,
  paymentReferenceIndex,
} from "#shared/db/payment-reference-store.ts";
import { type Money, money } from "#shared/payment/money.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import {
  type RefundAuthorityState,
  type RefundAuthorityStateName,
  type RefundOwnerChoiceReason,
  readRefundAuthorityState,
  refundLocalMirror,
  refundStateMirror,
} from "#shared/payment/refund-authority.ts";
import { refundAuthorityWorkSql } from "#shared/payment/refund-authority-lifecycle.ts";
import type { RefundOwnerDecision } from "#shared/payment/refund-conflict-decision.ts";
import { REFUND_PROVIDER_CAPABILITIES } from "#shared/payment/refund-provider-authorization.ts";
import { writeProviderRefundCursor } from "#shared/provider-refund-cursor.ts";
import { isPaymentProvider, type PaymentProviderType } from "#shared/types.ts";

/* jscpd:ignore-end */

const PAGE_SIZE = 20;
const CASE_SQL = refundAuthorityWorkSql("charge.");

type ProviderRefundCaseState = RefundAuthorityStateName;

export interface ProviderRefundCaseSummary {
  readonly captured: Money;
  readonly id: number;
  readonly provider: PaymentProviderType;
  readonly revision: number;
  readonly state: ProviderRefundCaseState;
  readonly updatedAt: number;
}

interface ProviderRefundCaseDetail extends ProviderRefundCaseSummary {
  readonly reference: TaggedPaymentReference;
}

interface OwnerChoiceProviderRefundCase extends ProviderRefundCaseDetail {
  readonly decision: RefundOwnerDecision;
  readonly reason: RefundOwnerChoiceReason;
  readonly state: "needs_owner_choice";
}

interface AutomaticProviderRefundCase extends ProviderRefundCaseDetail {
  readonly decision: null;
  readonly reason: null;
  readonly state: Exclude<ProviderRefundCaseState, "needs_owner_choice">;
}

export type ProviderRefundCase =
  | AutomaticProviderRefundCase
  | OwnerChoiceProviderRefundCase;

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
  return {
    captured,
    id: refundCaseWholeNumber(row.id, "id", 1),
    provider: providerFrom(row.provider),
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
  if (state.request.capability !== REFUND_PROVIDER_CAPABILITIES[provider]) {
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
  return state.kind === "needs_owner_choice"
    ? {
        ...summary,
        decision: state.decision,
        reason: state.reason,
        reference,
        state: state.kind,
      }
    : {
        ...summary,
        decision: null,
        reason: null,
        reference,
        state: state.kind,
      };
};
