import { sumOf } from "#fp";
import { logActivity } from "#shared/db/activityLog.ts";
import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import {
  findBuiltSiteByIdPrimary,
  getBuiltSiteByRenewalTokenIndex,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import type { EmailEntry } from "#shared/email.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type {
  PreparedPaymentCompletionDelivery,
  RenewalDelivery,
} from "#shared/payment-completion-delivery.ts";
import {
  addMonthsToRenewalDeadline,
  isQualifyingTierListing,
  pushSiteSecrets,
  reportSiteSecretError,
  syncReadOnlyFrom,
} from "#shared/site-assignment.ts";

interface RenewalFacts {
  listingId: number;
  months: number;
  site: BuiltSite;
  siteTokenIndex: string;
}

interface RenewalIssue {
  detail: string;
  listingId?: number;
}

const renewalFactsForEntries = async (
  entries: EmailEntry[],
  siteTokenIndex: string | undefined,
  invalid: (issue: RenewalIssue) => void,
): Promise<RenewalFacts | null> => {
  if (siteTokenIndex === undefined) return null;
  const invalidEntry = entries.find(
    ({ listing }) => !isQualifyingTierListing(listing),
  );
  if (invalidEntry !== undefined) {
    invalid({
      detail: `Renewal rejected: listing ${invalidEntry.listing.id} is not an active hidden purchase-only renewal tier`,
      listingId: invalidEntry.listing.id,
    });
    return null;
  }
  const site = await getBuiltSiteByRenewalTokenIndex(siteTokenIndex);
  if (site === null) {
    invalid({
      detail: `Renewal site not found for token index ${siteTokenIndex.slice(0, 8)}...`,
    });
    return null;
  }
  const months = sumOf(
    (entry: EmailEntry) =>
      entry.attendee.quantity * entry.listing.months_per_unit,
  )(entries);
  if (months <= 0) return null;
  return {
    listingId: entries[0]!.listing.id,
    months,
    site,
    siteTokenIndex,
  };
};

export const applyRenewalsForEntries = async (
  entries: EmailEntry[],
  siteTokenIndex: string | undefined,
): Promise<void> => {
  const facts = await renewalFactsForEntries(
    entries,
    siteTokenIndex,
    ({ detail, listingId }) =>
      logError({ code: ErrorCode.DATA_INVALID, detail, listingId }),
  );
  if (facts === null) return;
  const result = await syncReadOnlyFrom(
    facts.site,
    addMonthsToRenewalDeadline(facts.site, facts.months),
  );
  if (!result.ok) {
    reportSiteSecretError(
      `Failed to push READ_ONLY_FROM for renewal of '${facts.site.name}'`,
      result.error,
    );
    return;
  }
  await logActivity(
    `Renewal of '${facts.site.name}' for ${facts.months} month(s)`,
    facts.listingId,
  );
};

export const paidRenewalDeliveriesFor =
  (siteTokenIndex: string | undefined) =>
  async (
    entries: EmailEntry[],
  ): Promise<PreparedPaymentCompletionDelivery[]> => {
    const facts = await renewalFactsForEntries(
      entries,
      siteTokenIndex,
      ({ detail }) => {
        throw new Error(detail);
      },
    );
    if (facts === null) return [];
    return [
      {
        data: {
          hostingId: facts.site.hostingId,
          hostingProvider: facts.site.hostingProvider,
          kind: "renewal",
          listingId: facts.listingId,
          months: facts.months,
          previousReadOnlyFrom: facts.site.readOnlyFrom,
          readOnlyFrom: addMonthsToRenewalDeadline(facts.site, facts.months),
          renewalTokenIndex: facts.siteTokenIndex,
          siteId: facts.site.id,
          siteName: facts.site.name,
        },
        key: `renewal:${facts.site.id}`,
      },
    ];
  };

export interface PaidRenewalActivity {
  listingId: number;
  message: string;
}

export const applyPaidRenewal = async (
  delivery: RenewalDelivery,
): Promise<PaidRenewalActivity> => {
  const site = await findBuiltSiteByIdPrimary(delivery.siteId);
  if (site === null)
    throw new Error(`Renewal site ${delivery.siteId} was removed`);
  if (
    site.renewalTokenIndex !== delivery.renewalTokenIndex ||
    site.hostingId !== delivery.hostingId ||
    site.hostingProvider !== delivery.hostingProvider
  ) {
    throw new Error("Renewal site facts changed after payment");
  }
  if (site.readOnlyFrom !== delivery.readOnlyFrom) {
    if (site.readOnlyFrom !== delivery.previousReadOnlyFrom) {
      throw new Error("Renewal deadline changed after payment");
    }
    const pushed = await pushSiteSecrets(site, {
      readOnlyFrom: delivery.readOnlyFrom,
    });
    if (!pushed.ok) throw new Error(`Paid renewal failed: ${pushed.error}`);
    const updated = await updateBuiltSiteRenewalState(site.id, {
      readOnlyFrom: delivery.readOnlyFrom,
    });
    if (updated === null)
      throw new Error(`Renewal site ${site.id} was removed`);
  }
  return {
    listingId: delivery.listingId,
    message: `Renewal of '${delivery.siteName}' for ${delivery.months} month(s)`,
  };
};
