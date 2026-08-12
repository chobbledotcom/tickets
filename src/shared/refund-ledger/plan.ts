/** Decide which ledger groups an observed provider refund may reverse. */

/* jscpd:ignore-start -- imports */
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  bookingEventGroup,
  mapRefund,
  refundEventGroup,
} from "#shared/accounting/mappers.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import { legMatches } from "#shared/ledger/legs.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";
import {
  type RefundLedgerResult,
  type RefundReferences,
  referenceIndexesOutside,
  refundLedgerResult,
} from "./result.ts";
/* jscpd:ignore-end */

export type ComputedRefund = {
  readonly groups: TransferInput[][];
  readonly postFailureResult: RefundLedgerResult;
  readonly result: RefundLedgerResult;
};

const computedRefund = (
  groups: TransferInput[][],
  result: RefundLedgerResult,
  postFailureResult: RefundLedgerResult = result,
): ComputedRefund => ({ groups, postFailureResult, result });

type RefundPlanInput = {
  readonly attendeeId: number;
  readonly memo?: string;
  readonly references: RefundReferences;
};

const isRefundLeg = (kind: string | undefined): boolean =>
  kind?.startsWith("refund_") ?? false;

const isProviderPaymentLeg = legMatches({ from: WORLD, kind: KIND.payment });

const isOperatorMoneyLeg = (leg: Transfer): boolean =>
  leg.kind === KIND.adjustment || leg.kind?.startsWith("manual_") === true;

type AccountRefundGroup = {
  readonly eventGroup: string;
  readonly legs: Transfer[];
};

/** A group containing provider cash and nothing else. */
const isPaymentOnlyGroup = (group: AccountRefundGroup): boolean =>
  group.legs.every(isProviderPaymentLeg);

/** The original account event groups that a returned charge may reverse. */
const accountRefundGroups = (legs: Transfer[]): AccountRefundGroup[] =>
  [
    ...Map.groupBy(
      legs.filter((leg) => !isRefundLeg(leg.kind)),
      (leg) => leg.eventGroup,
    ).entries(),
  ].map(([eventGroup, legs]) => ({ eventGroup, legs }));

/** Whether every original order group contains only provider cash. */
export const isPaymentOnlyAccount = (legs: Transfer[]): boolean => {
  const groups = accountRefundGroups(legs);
  return groups.length > 0 && groups.every(isPaymentOnlyGroup);
};

type ReferencePlacement = {
  readonly eventGroups: readonly string[];
  readonly index: string;
  readonly named: boolean;
};

const referencePlacements = (
  references: RefundReferences,
): Promise<ReferencePlacement[]> =>
  Promise.all(
    references.map(async (reference) => ({
      eventGroups: (
        await Promise.all(
          reference.sessionIds.map((sessionId) =>
            Promise.all([
              bookingEventGroup(sessionId),
              balanceEventGroup(sessionId),
            ]),
          ),
        )
      ).flat(),
      index: reference.index,
      named: reference.sessionIds.length > 0,
    })),
  );

const hasProviderPayment = (group: AccountRefundGroup): boolean =>
  group.legs.some(isProviderPaymentLeg);

const hasOperatorMoney = (group: AccountRefundGroup): boolean =>
  group.legs.some(isOperatorMoneyLeg);

type ReturnedGroups = {
  readonly groups: AccountRefundGroup[];
  readonly kind: "subset" | "whole_account";
  readonly placements: readonly ReferencePlacement[];
  readonly unplaced: ReadonlySet<string>;
};

/** Place returned references onto the provider-funded groups they name. */
const returnedRefundGroups = async (
  groups: AccountRefundGroup[],
  references: RefundReferences,
): Promise<ReturnedGroups> => {
  const providerGroups = new Set(
    groups.filter(hasProviderPayment).map(({ eventGroup }) => eventGroup),
  );
  const placements = (await referencePlacements(references)).map(
    (placement) => ({
      ...placement,
      eventGroups: placement.eventGroups.filter((eventGroup) =>
        providerGroups.has(eventGroup),
      ),
    }),
  );
  const returned = new Set(
    placements.flatMap(({ eventGroups }) => eventGroups),
  );
  const cameBack = (group: AccountRefundGroup): boolean =>
    returned.has(group.eventGroup);
  const namedUnplaced = placements.filter(
    ({ eventGroups, named }) => named && eventGroups.length === 0,
  );
  const unnamed = groups.filter(
    (group) => hasProviderPayment(group) && !cameBack(group),
  );
  const legacyCount = placements.filter(({ named }) => !named).length;
  if (unnamed.length === legacyCount) {
    return {
      groups,
      kind: "whole_account",
      placements,
      unplaced: new Set(namedUnplaced.map(({ index }) => index)),
    };
  }
  return {
    groups: groups.filter(cameBack),
    kind: "subset",
    placements,
    unplaced: new Set([
      ...namedUnplaced.map(({ index }) => index),
      ...placements.filter(({ named }) => !named).map(({ index }) => index),
    ]),
  };
};

type ReversalGroups = {
  readonly alreadyRecorded: AccountRefundGroup[];
  readonly toRecord: AccountRefundGroup[];
};

/** Separate durable reversals from the groups whose reversal still must land. */
const reversalGroups = async (
  legs: Transfer[],
  groups: AccountRefundGroup[],
): Promise<ReversalGroups> => {
  const reversed = new Set(
    legs.filter((leg) => isRefundLeg(leg.kind)).map((leg) => leg.eventGroup),
  );
  const alreadyRecorded = await Promise.all(
    groups.map(async (group) =>
      reversed.has(await refundEventGroup(group.eventGroup)),
    ),
  );
  return {
    alreadyRecorded: groups.filter((_, index) => alreadyRecorded[index]),
    toRecord: groups.filter((_, index) => alreadyRecorded[index] === false),
  };
};

type PlacementMatch = (
  eventGroups: readonly string[],
  groupIds: ReadonlySet<string>,
) => boolean;

const indexesMatchingGroups =
  (matches: PlacementMatch) =>
  (
    placements: readonly ReferencePlacement[],
    groups: readonly AccountRefundGroup[],
  ): ReadonlySet<string> => {
    const ids = new Set(groups.map(({ eventGroup }) => eventGroup));
    return new Set(
      placements
        .filter(({ eventGroups }) => matches(eventGroups, ids))
        .map(({ index }) => index),
    );
  };

const indexesNamedByGroups = indexesMatchingGroups((eventGroups, groupIds) =>
  eventGroups.some((eventGroup) => groupIds.has(eventGroup)),
);

const indexesWhollyInGroups = indexesMatchingGroups(
  (eventGroups, groupIds) =>
    eventGroups.length > 0 &&
    eventGroups.every((eventGroup) => groupIds.has(eventGroup)),
);

type RefundGroupFacts = {
  readonly hasOperatorMoney: boolean;
  readonly hasProviderPayment: boolean;
  readonly paymentOnly: boolean;
  readonly settled: boolean;
};

const refundGroupFacts = (
  account: ReturnType<typeof attendeeAccount>,
  group: AccountRefundGroup,
): RefundGroupFacts => ({
  hasOperatorMoney: hasOperatorMoney(group),
  hasProviderPayment: hasProviderPayment(group),
  paymentOnly: isPaymentOnlyGroup(group),
  settled: balanceOf(account)(group.legs) === 0,
});

const canReverseReturnedGroup = (facts: RefundGroupFacts): boolean =>
  facts.hasProviderPayment &&
  !facts.hasOperatorMoney &&
  (facts.paymentOnly || facts.settled);

const hasUnsettledObligation = (facts: RefundGroupFacts): boolean =>
  facts.hasProviderPayment && !facts.paymentOnly && !facts.settled;

/** Compute the exact reversals and reference outcomes without posting them. */
export const computeAttendeeRefund = async (
  input: RefundPlanInput,
): Promise<ComputedRefund> => {
  const { attendeeId, memo, references } = input;
  const account = attendeeAccount(attendeeId);
  const legs = await transfersByAccount(account);
  const groups = accountRefundGroups(legs);
  const returned = await returnedRefundGroups(groups, references);
  const factsFor = (group: AccountRefundGroup): RefundGroupFacts =>
    refundGroupFacts(account, group);
  const reversesWholeAccount =
    returned.kind === "whole_account" &&
    !groups.some(hasOperatorMoney) &&
    (isPaymentOnlyAccount(legs) || balanceOf(account)(legs) === 0);
  const reviewGroups = reversesWholeAccount
    ? []
    : returned.groups.filter((group) =>
        hasUnsettledObligation(factsFor(group)),
      );
  const eligible = reversesWholeAccount
    ? returned.groups
    : returned.groups.filter((group) =>
        canReverseReturnedGroup(factsFor(group)),
      );
  const reviewReferenceIndexes = indexesNamedByGroups(
    returned.placements,
    reviewGroups,
  );
  const recorded = reversesWholeAccount
    ? referenceIndexesOutside(references, returned.unplaced)
    : indexesWhollyInGroups(returned.placements, eligible);
  const result = refundLedgerResult(
    references,
    recorded,
    reviewReferenceIndexes,
  );
  const { alreadyRecorded, toRecord } = await reversalGroups(legs, eligible);
  const postFailureResult = refundLedgerResult(
    references,
    indexesWhollyInGroups(returned.placements, alreadyRecorded),
    reviewReferenceIndexes,
  );
  if (toRecord.length === 0) return computedRefund([], result);
  const occurredAt = nowIso();
  return computedRefund(
    await Promise.all(
      toRecord.map((order) =>
        mapRefund({ memo, occurredAt, orderLegs: order.legs }),
      ),
    ),
    result,
    postFailureResult,
  );
};
