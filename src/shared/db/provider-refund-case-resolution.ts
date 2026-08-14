/* jscpd:ignore-start -- imports */
import { logActivity } from "#shared/db/activity-log.ts";
import {
  resultRows,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import type { RefundAuthorityVersion } from "#shared/db/provider-refund-authority.ts";
import {
  type RefundAuthorityMoney,
  resolveRefundAuthorityMoney,
} from "#shared/db/provider-refund-authority-change.ts";
import {
  loadProviderRefundCaseReference,
  providerRefundCaseSummary,
  readProviderRefundCaseState,
  refundCaseWholeNumber,
  type StoredProviderRefundCase,
} from "#shared/db/provider-refund-cases.ts";
import { nowMs } from "#shared/now.ts";
import { money } from "#shared/payment/money.ts";
import { markRefundLocalRecorded } from "#shared/payment/refund-authority.ts";
import {
  type RefundOwnerChoice,
  type RefundOwnerChoiceName,
  refundOwnerChoices,
  resolveRefundOwnerChoice,
} from "#shared/payment/refund-authority-choice.ts";
import { refundLifecycleFor } from "#shared/payment/refund-authority-lifecycle.ts";
import type {
  NeedsOwnerChoiceRefundState,
  RefundAuthorityState,
} from "#shared/payment/refund-authority-state.ts";
import { refundReplayUntil } from "#shared/payment/refund-replay-window.ts";
import { refundRequestIdentityIndex } from "#shared/payment/refund-request-identity.ts";
/* jscpd:ignore-end */

export type ProviderRefundOwnerChoice =
  | "money_recorded"
  | RefundOwnerChoiceName;

interface ResolveProviderRefundCaseInput {
  readonly activityMessage: string;
  readonly choice: ProviderRefundOwnerChoice;
  readonly id: number;
  readonly privateKey: CryptoKey;
  readonly revision: number;
}

type ResolveProviderRefundCaseResult = "changed" | "missing" | "resolved";

interface ResolutionRow extends StoredProviderRefundCase {
  readonly refunded_amount: number | bigint;
}

const resolutionRow = async (
  transaction: TxScope,
  id: number,
): Promise<ResolutionRow | null> => {
  const rows = resultRows<ResolutionRow>(
    await transaction.execute({
      args: [id],
      sql: `SELECT charge.id,
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
    }),
  );
  return rows[0] ?? null;
};

const notSentChoice = async (
  state: NeedsOwnerChoiceRefundState,
  row: ResolutionRow,
  privateKey: CryptoKey,
  decidedAt: number,
): Promise<
  Exclude<RefundOwnerChoice, { kind: "provider_confirmed_returned" }>
> => {
  const reference = await loadProviderRefundCaseReference(row, privateKey);
  const generation = state.request.generation + 1;
  const common = {
    decidedAt,
    evidenceRevision: state.evidenceRevision + 1,
    kind: "provider_confirmed_not_sent" as const,
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

const decisionMoney = (
  authority: RefundAuthorityVersion,
  state: NeedsOwnerChoiceRefundState,
  choice: RefundOwnerChoiceName,
): RefundAuthorityMoney =>
  state.reason === "provider_conflict"
    ? {
        captured: state.decision.captured,
        refunded: state.decision.refunded,
      }
    : {
        captured: authority.captured,
        refunded:
          choice === "provider_confirmed_returned"
            ? authority.captured
            : authority.refunded,
      };

const applyDecision = async (
  transaction: TxScope,
  authority: RefundAuthorityVersion,
  state: RefundAuthorityState,
  row: ResolutionRow,
  input: ResolveProviderRefundCaseInput,
  decidedAt: number,
): Promise<boolean> => {
  if (input.choice === "money_recorded") {
    if (state.kind !== "completed" || state.local.kind !== "due") return false;
    return (
      (await resolveRefundAuthorityMoney({
        money: {
          captured: authority.captured,
          refunded: authority.refunded,
        },
        now: decidedAt,
        row: authority,
        transaction,
        transition: () => markRefundLocalRecorded(state, decidedAt),
      })) !== null
    );
  }
  if (state.kind !== "needs_owner_choice") return false;
  const providerChoice = input.choice;
  if (!refundOwnerChoices(state).includes(providerChoice)) return false;
  const choice: RefundOwnerChoice =
    providerChoice === "provider_confirmed_returned"
      ? { decidedAt, kind: providerChoice }
      : await notSentChoice(state, row, input.privateKey, decidedAt);
  return (
    (await resolveRefundAuthorityMoney({
      money: decisionMoney(authority, state, providerChoice),
      now: decidedAt,
      row: authority,
      transaction,
      transition: () => resolveRefundOwnerChoice(state, choice),
    })) !== null
  );
};

const resolveInTransaction = async (
  transaction: TxScope,
  input: ResolveProviderRefundCaseInput,
): Promise<ResolveProviderRefundCaseResult> => {
  const row = await resolutionRow(transaction, input.id);
  if (row === null) return "missing";
  const revision = refundCaseWholeNumber(row.revision, "refund_revision", 1);
  const state = readProviderRefundCaseState(row);
  if (revision !== input.revision || refundLifecycleFor(state).prunable) {
    return "changed";
  }
  const summary = providerRefundCaseSummary(row);
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
  if (
    !(await applyDecision(transaction, authority, state, row, input, decidedAt))
  ) {
    return "changed";
  }
  await logActivity(input.activityMessage, undefined, undefined, transaction);
  return "resolved";
};

/** Commit an owner decision and the encrypted audit entry that proves it as
 * one revision-fenced database change. */
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
  if (input.activityMessage.trim().length === 0) {
    throw new Error("Refund-case activity message must not be empty");
  }
  return await withTransaction((transaction) =>
    resolveInTransaction(transaction, input),
  );
};
