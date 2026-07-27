import { isBuilderEnabled } from "#shared/config.ts";
import { addMonthsIso } from "#shared/dates.ts";
import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import {
  assignBuiltSiteForPayment,
  findBuiltSiteByIdPrimary,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import {
  getEmailConfig,
  getHostEmailConfig,
  requireMatchingEmailConfig,
  sendEmailStrict,
} from "#shared/email.ts";
import { nowIso } from "#shared/now.ts";
import type {
  PreparedPaymentCompletionDelivery,
  SiteAssignmentDelivery,
  SiteAssignmentEmailDelivery,
  SiteAssignmentFacts,
} from "#shared/payment-completion-delivery.ts";
import {
  generateRenewalToken,
  pushSiteSecrets,
  renewalUrlFor,
  type SiteAssignment,
  type SiteAssignmentEntry,
  siteAssignmentEmailMessage,
  validateSiteAssignmentConfig,
} from "#shared/site-assignment.ts";
import { buildAssignableSite } from "#shared/site-build.ts";
import { parseEmail } from "#shared/validation/email.ts";

const paidSiteEntries = (
  entries: SiteAssignmentEntry[],
): SiteAssignmentEntry[] =>
  entries.filter((entry) => entry.listing.assign_built_site);

const requirePaidBuilderEnabled = (): void => {
  if (!isBuilderEnabled()) {
    throw new Error("Site assignment settings changed after payment");
  }
};

const requirePaidSiteAssignmentConfig = async (
  entries: SiteAssignmentEntry[],
): Promise<void> => {
  requirePaidBuilderEnabled();
  const config = await validateSiteAssignmentConfig(entries);
  if (!config.ok) {
    throw new Error(`Paid site assignment is not available: ${config.reason}`);
  }
};

/** Persist one row per site before assignment starts. The key includes the
 * payment, attendee, listing, and unit, so every retry asks for the same site. */
export const preparePaidSiteAssignmentDeliveries = async (
  paymentId: string,
  entries: SiteAssignmentEntry[],
): Promise<PreparedPaymentCompletionDelivery[]> => {
  const needsSite = paidSiteEntries(entries);
  if (needsSite.length === 0) return [];
  await requirePaidSiteAssignmentConfig(needsSite);
  const deliveries: PreparedPaymentCompletionDelivery[] = [];
  const assignmentKeys: string[] = [];
  const seen = new Map<string, number>();
  for (const { attendee, listing } of needsSite) {
    const base = `${paymentId}:${attendee.id}:${listing.id}`;
    const start = seen.get(base) ?? 0;
    for (let index = 0; index < attendee.quantity; index += 1) {
      const unit = start + index;
      const key = `site-assignment:${attendee.id}:${listing.id}:${unit}`;
      assignmentKeys.push(key);
      deliveries.push({
        data: {
          attendeeId: attendee.id,
          effectId: `${paymentId}:${key}`,
          initialSiteMonths: listing.initial_site_months,
          kind: "site_assignment",
          listingId: listing.id,
          listingName: listing.name,
          site: null,
        },
        key,
      });
    }
    seen.set(base, start + attendee.quantity);
  }
  const recipient = parseEmail(needsSite[0]!.attendee.email);
  const config = getEmailConfig() ?? getHostEmailConfig();
  if (recipient !== null && config !== null) {
    deliveries.push({
      data: {
        assignmentKeys,
        config: {
          fromAddress: config.fromAddress,
          provider: config.provider,
        },
        kind: "site_assignment_email",
        recipient,
      },
      key: "site-assignment-email",
    });
  }
  return deliveries;
};

const requireAssignedSiteFacts = (
  site: BuiltSite,
  delivery: SiteAssignmentDelivery,
  facts: SiteAssignmentFacts,
): void => {
  if (
    site.assignmentEffect !== delivery.effectId ||
    site.assignedAttendeeId !== delivery.attendeeId ||
    site.assignedListingId !== delivery.listingId ||
    site.hostingId !== facts.hostingId ||
    site.hostingProvider !== facts.hostingProvider
  ) {
    throw new Error("Paid site assignment facts changed after payment");
  }
};

const siteHasRenewalState = (
  site: BuiltSite,
  readOnlyFrom: string,
  renewalTokenIndex: string | null,
): boolean =>
  site.readOnlyFrom === readOnlyFrom &&
  site.renewalTokenIndex === renewalTokenIndex;

const reservePaidSite = async (
  delivery: SiteAssignmentDelivery,
): Promise<BuiltSite> => {
  const assign = (): Promise<BuiltSite | null> =>
    assignBuiltSiteForPayment(
      delivery.effectId,
      delivery.attendeeId,
      delivery.listingId,
    );
  let site = await assign();
  if (site === null) {
    const built = await buildAssignableSite();
    if (built === null)
      throw new Error("Could not build a site for this payment");
    site = await assign();
  }
  if (site === null)
    throw new Error("Could not reserve a site for this payment");
  return site;
};

/** Writes down what a site assignment has reserved, so a retry reuses it. */
type PersistSiteAssignment = (
  delivery: SiteAssignmentDelivery,
) => Promise<void>;

/** Reserve a site for this payment, write down what was reserved so a retry
 *  reuses it, and hand back those facts. Only called before one is reserved. */
const reserveSiteFacts = async (
  delivery: SiteAssignmentDelivery,
  persist: PersistSiteAssignment,
): Promise<SiteAssignmentFacts> => {
  const site = await reservePaidSite(delivery);
  const token = await generateRenewalToken();
  const facts: SiteAssignmentFacts = {
    hostingId: site.hostingId,
    hostingProvider: site.hostingProvider,
    previousReadOnlyFrom: site.readOnlyFrom,
    previousRenewalTokenIndex: site.renewalTokenIndex,
    readOnlyFrom: addMonthsIso(nowIso(), delivery.initialSiteMonths),
    renewalToken: token.token,
    renewalTokenIndex: token.index,
    renewalUrl: renewalUrlFor(token.token),
    siteId: site.id,
    siteName: site.name,
    siteUrl: site.siteUrl,
  };
  await persist({ ...delivery, site: facts });
  return facts;
};

export const applyPaidSiteAssignment = async (
  initial: SiteAssignmentDelivery,
  persist: PersistSiteAssignment,
): Promise<void> => {
  requirePaidBuilderEnabled();
  const facts = initial.site ?? (await reserveSiteFacts(initial, persist));
  const site = await findBuiltSiteByIdPrimary(facts.siteId);
  if (site === null)
    throw new Error(`Assigned site ${facts.siteId} was removed`);
  requireAssignedSiteFacts(site, initial, facts);
  if (siteHasRenewalState(site, facts.readOnlyFrom, facts.renewalTokenIndex)) {
    return;
  }
  if (
    !siteHasRenewalState(
      site,
      facts.previousReadOnlyFrom,
      facts.previousRenewalTokenIndex,
    )
  ) {
    throw new Error("Assigned site renewal facts changed after payment");
  }
  const pushed = await pushSiteSecrets(site, {
    readOnlyFrom: facts.readOnlyFrom,
    renewalUrl: facts.renewalUrl,
  });
  if (!pushed.ok) {
    throw new Error(`Paid site assignment failed: ${pushed.error}`);
  }
  const updated = await updateBuiltSiteRenewalState(site.id, {
    readOnlyFrom: facts.readOnlyFrom,
    renewalToken: facts.renewalToken,
    renewalTokenIndex: facts.renewalTokenIndex,
  });
  if (updated === null) throw new Error(`Assigned site ${site.id} was removed`);
};

export const sendPreparedSiteAssignmentEmail = async (
  delivery: SiteAssignmentEmailDelivery,
  assignments: SiteAssignment[],
): Promise<void> => {
  await sendEmailStrict(
    requireMatchingEmailConfig(delivery.config),
    siteAssignmentEmailMessage(delivery.recipient, assignments),
  );
};

export const paidSiteAssignment = (
  delivery: SiteAssignmentDelivery,
): SiteAssignment => {
  if (delivery.site === null) {
    throw new Error(`Site assignment ${delivery.effectId} has no site facts`);
  }
  return {
    listingName: delivery.listingName,
    siteUrl: delivery.site.siteUrl,
  };
};
