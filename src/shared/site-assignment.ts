/**
 * Built site assignment — assigns pre-built sites to attendees after booking
 * completion, and sends the notification email with site URLs. Sites come
 * from the pool the operator stocks; assignment never builds one. All of it
 * is gated behind CAN_BUILD_SITES.
 */

/* jscpd:ignore-start */
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import { getAssignableBuiltSites } from "#db/built-sites.ts";
import { settings } from "#db/settings.ts";
import { sumOf, unique } from "#fp";
import { runWithSiteBuildScope } from "#shared/builder-dry-run.ts";
import { isBuilderEnabled } from "#shared/config.ts";
import {
  type EmailEntry,
  getEmailConfig,
  hostEmail,
  sendEmail,
} from "#shared/email.ts";
import { pickTierListing } from "#shared/renewal-tier.ts";
import { siteBaseUrl } from "#shared/site-address.ts";
import {
  type MissedBuyer,
  reportOutOfStockBuyers,
  reportSiteAssignmentFailure,
  type SiteAssignmentConfigValidation,
} from "#shared/site-assignment-failure.ts";
import {
  completeUnfinishedRenewal,
  provisionSiteRenewal,
} from "#shared/site-renewal.ts";
import { parseEmail, type ValidEmail } from "#shared/validation/email.ts";

/* jscpd:ignore-end */

/** Info about an assigned site for email rendering */
type SiteAssignment = {
  siteUrl: string;
  listingName: string;
};

/** A listing selection being checked before payment/booking. */
type SiteAssignmentConfigEntry = {
  listing: {
    assign_built_site: boolean;
    id: number;
    initial_site_months: number;
    name: string;
  };
};

/** Validate selected site-assignment listings before taking payment/booking. */
export const validateSiteAssignmentConfig = async (
  entries: SiteAssignmentConfigEntry[],
): Promise<SiteAssignmentConfigValidation> => {
  const needsSite = entries.filter((e) => e.listing.assign_built_site);
  if (needsSite.length === 0) return { ok: true };

  if (!isBuilderEnabled()) {
    return {
      message:
        "Site assignment is not configured. Please contact the administrator.",
      ok: false,
      reason: "builder_disabled",
    };
  }

  const invalidInitialMonths = needsSite.find(
    (e) => e.listing.initial_site_months <= 0,
  );
  if (invalidInitialMonths) {
    return {
      listingId: invalidInitialMonths.listing.id,
      message:
        "Site assignment is not configured. Please contact the administrator.",
      ok: false,
      reason: "initial_months",
    };
  }

  if (!(await pickTierListing())) {
    return {
      message:
        "Site assignment is not configured. Please contact the administrator.",
      ok: false,
      reason: "missing_tier",
    };
  }

  return { ok: true };
};

/** Every buyer's outcome from one assignment run. */
type SiteAssignmentOutcome = {
  assignments: SiteAssignment[];
  missedBuyers: MissedBuyer[];
};

/** Assign built sites to the entries that need them. Sites come only from the
 * pool of assignable sites the operator has stocked. */
const assignSitesForEntries = async (
  entries: EmailEntry[],
): Promise<SiteAssignmentOutcome> => {
  const missedBuyers: MissedBuyer[] = [];
  const needsSite = entries.filter(
    (e: EmailEntry) => e.listing.assign_built_site,
  );
  if (needsSite.length === 0) return { assignments: [], missedBuyers };

  // Keep async assignment aligned with the pre-checkout validation gate.
  const config = await validateSiteAssignmentConfig(needsSite);
  if (!config.ok) {
    reportSiteAssignmentFailure(config, needsSite.length);
    return { assignments: [], missedBuyers };
  }

  const assignments: SiteAssignment[] = [];
  // Reversed so pop() hands sites out in their original order without
  // reindexing the array on every take.
  const available = [...(await getAssignableBuiltSites())].reverse();

  // One buyer's plan listings combine into one site: a 12-month listing plus
  // a 3-month listing buy one site with 15 months, never two sites.
  const plansByBuyer = Map.groupBy(needsSite, (e) => e.attendee.id);
  for (const buyerPlans of plansByBuyer.values()) {
    // A no-quantity line books nothing; a refunded plan row bought
    // nothing that lasts.
    const booked = buyerPlans.filter(
      (e: EmailEntry) => e.attendee.quantity >= 1 && !e.attendee.refunded,
    );
    if (booked.length === 0) continue;
    const first = booked[0]!;
    const months = sumOf(
      (e: EmailEntry) => e.listing.initial_site_months * e.attendee.quantity,
    )(booked);

    // The claim may sit on a listing later refunded, and a refund does not
    // unassign its site, so the served check spans every plan row of this
    // run — refunded ones included — while months count only the rest.
    const servedListingIds = unique(buyerPlans.map((e) => e.listing.id));
    const listingName = unique(booked.map((e) => e.listing.name)).join(" + ");
    const take = await takePooledSiteForBuyer(
      available,
      first.attendee.id,
      servedListingIds,
      first.listing.id,
    );
    if (take.kind === "served") {
      await completeUnfinishedRenewal(
        first.attendee.id,
        servedListingIds,
        months,
      );
      continue;
    }
    if (take.kind === "empty") {
      missedBuyers.push({ attendee: first.attendee, listingName });
      continue;
    }
    const site = take.site;
    await provisionSiteRenewal(
      site,
      months,
      `Failed to push initial renewal secrets for site ${site.id}`,
    );
    assignments.push({ listingName, siteUrl: site.siteUrl });
  }

  return { assignments, missedBuyers };
};

/** Absolute /setup/ link for a site — siteUrl may be a bare hostname. */
const siteSetupUrl = (siteUrl: string): string =>
  `${siteBaseUrl(siteUrl)}/setup/`;

/** Send site assignment notification email */
const sendSiteAssignmentEmail = async (
  to: ValidEmail,
  assignments: SiteAssignment[],
): Promise<void> => {
  const config = getEmailConfig() ?? hostEmail.getHostConfig();
  if (!config) return;

  const plural = assignments.length > 1;
  const subject = plural
    ? `Your ${assignments.length} new sites are ready`
    : "Your new site is ready";

  const greeting = `Your new site${plural ? "s are" : " is"} ready!`;
  const activationNote = plural
    ? "Visit the setup links below to activate your sites:"
    : "Visit the setup link below to activate your site:";

  const htmlList = assignments
    .map((a) => {
      const url = siteSetupUrl(a.siteUrl);
      return `<li>${a.listingName}: <a href="${url}">${url}</a></li>`;
    })
    .join("");

  const textList = assignments
    .map((a) => `- ${a.listingName}: ${siteSetupUrl(a.siteUrl)}`)
    .join("\n");

  const replyTo = parseEmail(settings.businessEmail) ?? undefined;
  await sendEmail(config, {
    html: `<p>${greeting}</p><p>${activationNote}</p><ul>${htmlList}</ul>`,
    replyTo,
    subject,
    text: `${greeting}\n\n${activationNote}\n\n${textList}`,
    to,
  });
};

/** Assign pooled sites and send the notification email. Designed to be called
 * via addPendingWork. No-ops when CAN_BUILD_SITES is not enabled.
 *
 * The whole pipeline runs inside the site-build scope: the automated machine
 * steps a SITE_BUILD_DRY_RUN demo answers as one unit — the claim, the
 * renewal-secret pushes, and the emails. A human's live admin action on an
 * existing site sits outside it. */
export const assignAndNotifyBuiltSites = async (
  entries: EmailEntry[],
): Promise<void> => {
  if (!isBuilderEnabled()) return;

  await runWithSiteBuildScope(async () => {
    const { assignments, missedBuyers } = await assignSitesForEntries(entries);
    await reportOutOfStockBuyers(missedBuyers);
    if (assignments.length === 0) return;

    const email = parseEmail(entries[0]!.attendee.email);
    if (!email) return;
    await sendSiteAssignmentEmail(email, assignments);
  });
};
