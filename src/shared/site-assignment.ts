/**
 * Built site assignment — assigns sites to attendees after booking completion.
 * Sends a separate notification email with site URLs.
 * All assignment logic is gated behind CAN_BUILD_SITES.
 */

import { sort } from "#fp";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { builderApi, resolveHostingProvider } from "#shared/builder.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { addMonthsIso } from "#shared/dates.ts";
import {
  assignBuiltSite,
  type BuiltSite,
  builtSitesCrudTable,
  getAllBuiltSites,
  getAssignableBuiltSites,
  siteBaseUrl,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { getAllListings } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import {
  getEmailConfig,
  getHostEmailConfig,
  sendEmail,
} from "#shared/email.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { parseEmail, type ValidEmail } from "#shared/validation/email.ts";

/** Entry with the fields needed for site assignment */
type SiteAssignmentEntry = {
  listing: {
    id: number;
    name: string;
    assign_built_site: boolean;
    initial_site_months: number;
  };
  attendee: { id: number; email: string; quantity: number };
};

/** Info about an assigned site for email rendering */
type SiteAssignment = {
  siteUrl: string;
  listingName: string;
};

type AssignmentContext = {
  attendee: SiteAssignmentEntry["attendee"];
  listing: SiteAssignmentEntry["listing"];
  site: BuiltSite;
};

export type TierListing = Awaited<ReturnType<typeof getAllListings>>[number];
export type RenewalTierListing = Pick<
  TierListing,
  "active" | "hidden" | "months_per_unit" | "purchase_only"
>;
export type CdnPushResult = { ok: true } | { ok: false; error: string };
type RenewalTokenData = { token: string; index: string };
type SiteAssignmentConfigEntry = {
  listing: {
    assign_built_site: boolean;
    id: number;
    initial_site_months: number;
    name: string;
  };
};
export type SiteAssignmentConfigValidation =
  | { ok: true }
  | {
      ok: false;
      reason: "builder_disabled" | "initial_months" | "missing_tier";
      message: string;
      listingId?: number;
    };

/** Compute the next sequential site name based on total site count, zero-padded to 5 digits. */
const nextSiteName = async (): Promise<string> =>
  String((await getAllBuiltSites()).length + 1).padStart(5, "0");

/** Build a new site on-demand and insert it as an assignable record. */
const buildSiteForAssignment = async (): Promise<BuiltSite | null> => {
  const name = await nextSiteName();
  const result = await builderApi.buildSite({ siteName: name });
  if (!result.ok) {
    logError({
      code: ErrorCode.CDN_REQUEST,
      detail: `Failed to auto-build site '${name}': ${result.error}`,
    });
    return null;
  }
  return builtSitesCrudTable.insert({
    assignable: true,
    dbProvider: result.dbProvider,
    dbToken: result.dbToken,
    dbUrl: result.dbUrl,
    hostingId: result.hostingId,
    hostingProvider: result.hostingProvider,
    name,
    siteUrl: result.defaultHostname,
  });
};

/** Pick the cheapest qualifying tier listing (purchase_only=1, hidden=1, months_per_unit>0, active=1). */
export const isQualifyingTierListing = (listing: RenewalTierListing): boolean =>
  listing.purchase_only &&
  listing.hidden &&
  listing.months_per_unit > 0 &&
  listing.active;

/** All listings that qualify as renewal tiers. */
export const getQualifyingTierListings = async (): Promise<TierListing[]> => {
  const listings = await getAllListings();
  return listings.filter(isQualifyingTierListing);
};

/** Pick the cheapest qualifying tier listing. */
export const pickTierListing = async (): Promise<TierListing | null> => {
  const qualifying = await getQualifyingTierListings();
  if (qualifying.length === 0) return null;
  const sorted = sort(
    (a: (typeof qualifying)[number], b: (typeof qualifying)[number]) =>
      a.unit_price - b.unit_price,
  )(qualifying);
  return sorted[0]!;
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

/** Generate a renewal token + its HMAC blind index. */
export const generateRenewalToken = async (): Promise<RenewalTokenData> => {
  const token = generateSecureToken();
  const index = await hmacHash(token);
  return { index, token };
};

/** Parse a site's stored read-only deadline as milliseconds, or null when empty/invalid. */
export const parseReadOnlyFromMs = (
  site: Pick<BuiltSite, "readOnlyFrom">,
): number | null => {
  if (!site.readOnlyFrom) return null;
  const ms = Date.parse(site.readOnlyFrom);
  return Number.isNaN(ms) ? null : ms;
};

/** Stack-forward base: max(now, existing deadline). Falls back to now when missing. */
export const renewalDeadlineBaseMs = (
  site: Pick<BuiltSite, "readOnlyFrom">,
): number => Math.max(nowMs(), parseReadOnlyFromMs(site) ?? 0);

export const addMonthsToRenewalDeadline = (
  site: Pick<BuiltSite, "readOnlyFrom">,
  months: number,
): string =>
  addMonthsIso(new Date(renewalDeadlineBaseMs(site)).toISOString(), months);

/** Build the renewal URL for a given token. */
export const renewalUrlFor = (token: string): string =>
  `https://${getEffectiveDomain()}/renew/?t=${encodeURIComponent(token)}`;

const logRenewalCdnError = (errorContext: string, error: string): void => {
  logError({
    code: ErrorCode.CDN_REQUEST,
    detail: `${errorContext}: ${error}`,
  });
  sendNtfyError("CDN_REQUEST");
};

/** Push a subset of site secrets to the hosting provider. Pure I/O — no DB writes. */
const pushSiteSecrets = async (
  site: BuiltSite,
  secrets: { readOnlyFrom?: string; renewalUrl?: string },
): Promise<CdnPushResult> => {
  if (!site.hostingId) return { error: "No hostingId", ok: false };
  const pairs: [string, string][] = [];
  if (secrets.renewalUrl !== undefined)
    pairs.push(["RENEWAL_URL", secrets.renewalUrl]);
  if (secrets.readOnlyFrom !== undefined)
    pairs.push(["READ_ONLY_FROM", secrets.readOnlyFrom]);
  return resolveHostingProvider(site.hostingProvider).setSecrets(
    site.hostingId,
    pairs,
  );
};

/**
 * Push READ_ONLY_FROM (and optionally re-push RENEWAL_URL) to the edge script
 * and persist the cutoff on success. Single DB write per call.
 */
export const syncReadOnlyFrom = async (
  site: BuiltSite,
  cutoffIso: string,
  renewalUrl?: string,
): Promise<CdnPushResult> => {
  const pushResult = await pushSiteSecrets(site, {
    readOnlyFrom: cutoffIso,
    ...(renewalUrl !== undefined ? { renewalUrl } : {}),
  });
  if (pushResult.ok) {
    await updateBuiltSiteRenewalState(site.id, { readOnlyFrom: cutoffIso });
  }
  return pushResult;
};

type RenewalStateUpdate = Parameters<typeof updateBuiltSiteRenewalState>[1];
type SiteSecrets = { readOnlyFrom?: string; renewalUrl?: string };

/**
 * Curried helper: push secrets and persist renewal state.
 * On push success, writes `onSuccess`. On failure, logs and leaves DB state
 * unchanged so an admin can retry from the unprovisioned state.
 */
const pushAndPersist =
  (site: BuiltSite, errorContext: string) =>
  async (
    secrets: SiteSecrets,
    onSuccess: RenewalStateUpdate,
  ): Promise<CdnPushResult> => {
    const pushResult = await pushSiteSecrets(site, secrets);
    if (pushResult.ok) {
      await updateBuiltSiteRenewalState(site.id, onSuccess);
    } else {
      logRenewalCdnError(errorContext, pushResult.error);
    }
    return pushResult;
  };

/**
 * Provision a site for renewals: generate a token, push initial secrets,
 * persist the full renewal state. On push failure, leaves renewal state
 * untouched so an admin can retry provisioning cleanly. Single DB write.
 */
export const provisionSiteRenewal = async (
  site: BuiltSite,
  months: number,
  errorContext: string,
): Promise<{ token: string; cutoff: string; pushOk: boolean }> => {
  const tokenData = await generateRenewalToken();
  const cutoff = addMonthsIso(nowIso(), months);
  const renewalState = {
    renewalToken: tokenData.token,
    renewalTokenIndex: tokenData.index,
  } as const;

  const pushResult = await pushAndPersist(site, errorContext)(
    { readOnlyFrom: cutoff, renewalUrl: renewalUrlFor(tokenData.token) },
    { readOnlyFrom: cutoff, ...renewalState },
  );

  return { cutoff, pushOk: pushResult.ok, token: tokenData.token };
};

/**
 * Rotate a site's renewal token. Pushes the new RENEWAL_URL only — the
 * READ_ONLY_FROM cutoff is independent of token identity and is not
 * re-pushed here. Persists the new token on push success.
 */
export const rotateRenewalToken = async (
  site: BuiltSite,
  errorContext: string,
): Promise<{ token: string; pushOk: boolean }> => {
  const tokenData = await generateRenewalToken();
  const pushResult = await pushAndPersist(site, errorContext)(
    { renewalUrl: renewalUrlFor(tokenData.token) },
    { renewalToken: tokenData.token, renewalTokenIndex: tokenData.index },
  );
  return { pushOk: pushResult.ok, token: tokenData.token };
};

/** Assign a site and provision its renewal token. */
const assignSiteWithRenewal = async ({
  attendee,
  listing,
  site,
}: AssignmentContext): Promise<SiteAssignment> => {
  await assignBuiltSite(site.id, attendee.id, listing.id);
  await provisionSiteRenewal(
    site,
    listing.initial_site_months,
    `Failed to push initial renewal secrets for site ${site.id}`,
  );
  return { listingName: listing.name, siteUrl: site.siteUrl };
};

/** Assign built sites to entries that need them. Returns assigned URLs. */
const assignSitesForEntries = async (
  entries: SiteAssignmentEntry[],
): Promise<SiteAssignment[]> => {
  const needsSite = entries.filter(
    (e: SiteAssignmentEntry) => e.listing.assign_built_site,
  );
  if (needsSite.length === 0) return [];

  // Keep async assignment aligned with the pre-checkout validation gate.
  const config = await validateSiteAssignmentConfig(needsSite);
  if (!config.ok) {
    logError({
      code:
        config.reason === "initial_months"
          ? ErrorCode.DATA_INVALID
          : ErrorCode.CONFIG_MISSING,
      detail: `Site assignment blocked (${config.reason}, ${needsSite.length} entries skipped)`,
    });
    sendNtfyError(
      config.reason === "initial_months" ? "DATA_INVALID" : "CONFIG_MISSING",
    );
    return [];
  }

  const assignments: SiteAssignment[] = [];
  const available = await getAssignableBuiltSites();
  let idx = 0;

  for (const { listing, attendee } of needsSite) {
    const qty = attendee.quantity;
    for (let i = 0; i < qty; i++) {
      const site = available[idx] ?? (await buildSiteForAssignment());
      if (!site) break;

      assignments.push(
        await assignSiteWithRenewal({ attendee, listing, site }),
      );
      idx++;
    }
  }

  return assignments;
};

/** Absolute /setup/ link for a site — siteUrl may be a bare hostname. */
const siteSetupUrl = (siteUrl: string): string =>
  `${siteBaseUrl(siteUrl)}/setup/`;

/** Send site assignment notification email */
const sendSiteAssignmentEmail = async (
  to: ValidEmail,
  assignments: SiteAssignment[],
): Promise<void> => {
  const config = getEmailConfig() ?? getHostEmailConfig();
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

/** Assign sites and send notification email. Designed to be called via addPendingWork.
 * No-ops when CAN_BUILD_SITES is not enabled. */
export const assignAndNotifyBuiltSites = async (
  entries: SiteAssignmentEntry[],
): Promise<void> => {
  if (!isBuilderEnabled()) return;

  const assignments = await assignSitesForEntries(entries);
  if (assignments.length === 0) return;

  const email = parseEmail(entries[0]!.attendee.email);
  if (!email) return;
  await sendSiteAssignmentEmail(email, assignments);
};
