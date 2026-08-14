/* jscpd:ignore-start -- imports */
import { queryAll, queryOnePrimary } from "#shared/db/client.ts";
import {
  loadPaymentReference,
  paymentReferenceIndex,
} from "#shared/db/payment-reference-store.ts";
import {
  completeRefundAuthority,
  markRefundAuthorityRecorded,
  type RefundAuthorityVersion,
  transitionRefundAuthority,
} from "#shared/db/provider-refund-authority.ts";
import { nowMs } from "#shared/now.ts";
import { type Money, money } from "#shared/payment/money.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import {
  type NeedsOwnerChoiceRefundState,
  type RefundAuthorityState,
  type RefundAuthorityStateName,
  type RefundOwnerChoiceReason,
  readRefundAuthorityState,
  refundLocalMirror,
  refundStateMirror,
} from "#shared/payment/refund-authority.ts";
import {
  type RefundOwnerChoice,
  resolveRefundOwnerChoice,
} from "#shared/payment/refund-authority-choice.ts";
import {
  refundAuthorityWorkSql,
  refundLifecycleFor,
} from "#shared/payment/refund-authority-lifecycle.ts";
import { REFUND_PROVIDER_CAPABILITIES } from "#shared/payment/refund-provider-authorization.ts";
import { refundReplayUntil } from "#shared/payment/refund-replay-window.ts";
import { refundRequestIdentityIndex } from "#shared/payment/refund-request-identity.ts";
import { writeProviderRefundCursor } from "#shared/provider-refund-cursor.ts";
import { isPaymentProvider, type PaymentProviderType } from "#shared/types.ts";

/* jscpd:ignore-end */

const PAGE_SIZE = 20;
const CASE_SQL = refundAuthorityWorkSql("charge.");

export type ProviderRefundCaseState = RefundAuthorityStateName;

export interface ProviderRefundCaseSummary {
  readonly captured: Money;
  readonly id: number;
  readonly provider: PaymentProviderType;
  readonly revision: number;
  readonly state: ProviderRefundCaseState;
  readonly updatedAt: number;
}

export interface ProviderRefundCase extends ProviderRefundCaseSummary {
  readonly reason: RefundOwnerChoiceReason | null;
  readonly reference: TaggedPaymentReference;
}

export interface ProviderRefundCasePage {
  readonly cases: readonly ProviderRefundCaseSummary[];
  readonly nextCursor: string | null;
}

export type ProviderRefundOwnerChoice =
  | "money_recorded"
  | "provider_confirmed_not_sent"
  | "provider_confirmed_returned";

export interface ResolveProviderRefundCaseInput {
  readonly choice: ProviderRefundOwnerChoice;
  readonly id: number;
  readonly privateKey: CryptoKey;
  readonly revision: number;
}

export type ResolveProviderRefundCaseResult =
  | "changed"
  | "missing"
  | "resolved";

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

interface DetailRow extends SummaryRow {
  readonly capability: string;
  readonly provider_reference: string;
  readonly reference_index: string;
  readonly refund_local_state: string;
  readonly refund_state: string;
}

interface ResolutionRow extends DetailRow {
  readonly refunded_amount: Whole;
}

const wholeNumber = (value: Whole, name: string, minimum: number): number => {
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

const summaryFrom = (row: SummaryRow): ProviderRefundCaseSummary => {
  const captured = money(row.captured_amount, row.currency);
  if (captured === null) {
    throw new Error("payment_charges captured money is invalid");
  }
  return {
    captured,
    id: wholeNumber(row.id, "id", 1),
    provider: providerFrom(row.provider),
    revision: wholeNumber(row.revision, "refund_revision", 1),
    state: row.state,
    updatedAt: wholeNumber(row.updated_at, "updated_at", 0),
  };
};

const stateFrom = (row: DetailRow): RefundAuthorityState => {
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

const isCurrentCase = (state: RefundAuthorityState): boolean =>
  !refundLifecycleFor(state).prunable;

const taggedReferenceFrom = async (
  row: DetailRow,
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
  const page = rows.slice(0, PAGE_SIZE).map(summaryFrom);
  return {
    cases: page,
    nextCursor:
      rows.length > PAGE_SIZE
        ? await writeProviderRefundCursor(page[page.length - 1]!.id)
        : null,
  };
};

const detailRow = (id: number): Promise<DetailRow | null> =>
  queryOnePrimary<DetailRow>(
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
  const summary = summaryFrom(row);
  const state = stateFrom(row);
  return {
    ...summary,
    reason: state.kind === "needs_owner_choice" ? state.reason : null,
    reference: await taggedReferenceFrom(row, privateKey),
  };
};

const resolutionRow = (id: number): Promise<ResolutionRow | null> =>
  queryOnePrimary<ResolutionRow>(
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
      LIMIT 1`,
    [id],
  );

const notSentChoice = async (
  state: NeedsOwnerChoiceRefundState,
  row: ResolutionRow,
  privateKey: CryptoKey,
  decidedAt: number,
): Promise<
  Exclude<RefundOwnerChoice, { kind: "provider_confirms_returned" }>
> => {
  const reference = await taggedReferenceFrom(row, privateKey);
  const generation = state.request.generation + 1;
  const common = {
    decidedAt,
    evidenceRevision: state.evidenceRevision + 1,
    kind: "provider_confirms_not_sent" as const,
    nextActionAt: decidedAt,
    requestIndex: await refundRequestIdentityIndex(reference, generation),
  };
  return state.request.capability === "keyless"
    ? { ...common, capability: "keyless" }
    : {
        ...common,
        capability: "keyed",
        replayUntil: refundReplayUntil(reference.provider, decidedAt),
      };
};

const applyDecision = async (
  authority: RefundAuthorityVersion,
  state: RefundAuthorityState,
  row: ResolutionRow,
  input: ResolveProviderRefundCaseInput,
  decidedAt: number,
): Promise<boolean> => {
  if (input.choice === "money_recorded") {
    if (state.kind !== "completed" || state.local.kind !== "due") return false;
    return (
      (await markRefundAuthorityRecorded(
        input.id,
        input.revision,
        decidedAt,
      )) !== null
    );
  }
  if (state.kind !== "needs_owner_choice") return false;
  if (input.choice === "provider_confirmed_returned") {
    return (
      (await completeRefundAuthority(
        authority,
        authority.captured,
        decidedAt,
        "owner",
      )) !== null
    );
  }
  const choice = await notSentChoice(state, row, input.privateKey, decidedAt);
  return (
    (await transitionRefundAuthority(
      authority,
      decidedAt,
      authority.refunded,
      () => resolveRefundOwnerChoice(state, choice),
    )) !== null
  );
};

export const resolveProviderRefundCase = async (
  input: ResolveProviderRefundCaseInput,
): Promise<ResolveProviderRefundCaseResult> => {
  if (
    !Number.isSafeInteger(input.id) ||
    input.id < 1 ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1
  ) {
    throw new Error(
      "Refund-case id and revision must be positive safe integers",
    );
  }
  const row = await resolutionRow(input.id);
  if (row === null) return "missing";
  const revision = wholeNumber(row.revision, "refund_revision", 1);
  const state = stateFrom(row);
  if (revision !== input.revision || !isCurrentCase(state)) return "changed";
  const summary = summaryFrom(row);
  const refunded = money(row.refunded_amount, row.currency);
  if (refunded === null) {
    throw new Error("payment_charges refunded money is invalid");
  }
  const authority: RefundAuthorityVersion = {
    captured: summary.captured,
    id: summary.id,
    referenceIndex: row.reference_index,
    refunded,
    revision,
    state,
  };
  const decidedAt = nowMs();
  if (await applyDecision(authority, state, row, input, decidedAt)) {
    return "resolved";
  }
  return "changed";
};
