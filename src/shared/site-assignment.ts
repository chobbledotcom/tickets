/**
 * Built site assignment — assigns sites to attendees after booking completion.
 * Sends a separate notification email with site URLs.
 * All assignment logic is gated behind CAN_BUILD_SITES.
 */

import { sort } from "#fp";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
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
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { getAllEvents } from "#shared/db/events.ts";
import { settings } from "#shared/db/settings.ts";
import {
  getEmailConfig,
  getHostEmailConfig,
  sendEmail,
} from "#shared/email.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";

/** Entry with the fields needed for site assignment */
type SiteAssignmentEntry = {
  event: {
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
  eventName: string;
};

type AssignmentContext = {
  attendee: SiteAssignmentEntry["attendee"];
  event: SiteAssignmentEntry["event"];
  site: BuiltSite;
};

export type TierEvent = Awaited<ReturnType<typeof getAllEvents>>[number];
export type CdnPushResult = { ok: true } | { ok: false; error: string };
type RenewalTokenData = { token: string; index: string };

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
    bunnyScriptId: String(result.scriptId),
    bunnyUrl: result.defaultHostname,
    dbToken: result.dbToken,
    dbUrl: result.dbUrl,
    name,
  });
};

/** Pick the cheapest qualifying tier event (purchase_only=1, hidden=1, months_per_unit>0, active=1). */
export const isQualifyingTierEvent = (event: TierEvent): boolean =>
  event.purchase_only &&
  event.hidden &&
  event.months_per_unit > 0 &&
  event.active;

/** Pick the cheapest qualifying tier event. */
export const pickTierEvent = async (): Promise<TierEvent | null> => {
  const events = await getAllEvents();
  const qualifying = events.filter(isQualifyingTierEvent);
  if (qualifying.length === 0) return null;
  const sorted = sort(
    (a: (typeof qualifying)[number], b: (typeof qualifying)[number]) =>
      a.unit_price - b.unit_price,
  )(qualifying);
  return sorted[0] ?? null;
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

/** Push a subset of site secrets to the edge script. Pure I/O — no DB writes. */
const pushSiteSecrets = async (
  site: BuiltSite,
  secrets: { readOnlyFrom?: string; renewalUrl?: string },
): Promise<CdnPushResult> => {
  const scriptId = Number(site.bunnyScriptId);
  if (!scriptId) return { error: "No bunnyScriptId", ok: false };

  if (secrets.readOnlyFrom !== undefined) {
    const r = await bunnyCdnApi.setEdgeScriptSecret(
      scriptId,
      "READ_ONLY_FROM",
      secrets.readOnlyFrom,
    );
    if (!r.ok) return r;
  }
  if (secrets.renewalUrl !== undefined) {
    const r = await bunnyCdnApi.setEdgeScriptSecret(
      scriptId,
      "RENEWAL_URL",
      secrets.renewalUrl,
    );
    if (!r.ok) return r;
  }
  return { ok: true };
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

/**
 * Provision a site for renewals: generate a token, push initial secrets,
 * persist the full renewal state. On push failure persists the token/tier so
 * an admin can re-sync without re-provisioning; leaves readOnlyFrom empty so
 * the host doesn't lie about the customer-facing deadline. Single DB write.
 */
export const provisionSiteRenewal = async (
  site: BuiltSite,
  tierEventId: number,
  months: number,
  errorContext: string,
): Promise<{ token: string; cutoff: string; pushOk: boolean }> => {
  const tokenData = await generateRenewalToken();
  const cutoff = addMonthsIso(nowIso(), months);
  const renewalState = {
    renewalTierEventId: tierEventId,
    renewalToken: tokenData.token,
    renewalTokenIndex: tokenData.index,
  } as const;

  const pushResult = await pushSiteSecrets(site, {
    readOnlyFrom: cutoff,
    renewalUrl: renewalUrlFor(tokenData.token),
  });

  if (pushResult.ok) {
    await updateBuiltSiteRenewalState(site.id, {
      readOnlyFrom: cutoff,
      ...renewalState,
    });
  } else {
    logRenewalCdnError(errorContext, pushResult.error);
    await updateBuiltSiteRenewalState(site.id, renewalState);
  }

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
  const pushResult = await pushSiteSecrets(site, {
    renewalUrl: renewalUrlFor(tokenData.token),
  });
  if (pushResult.ok) {
    await updateBuiltSiteRenewalState(site.id, {
      renewalToken: tokenData.token,
      renewalTokenIndex: tokenData.index,
    });
  } else {
    logRenewalCdnError(errorContext, pushResult.error);
  }
  return { pushOk: pushResult.ok, token: tokenData.token };
};

/** Assign a site and configure its renewal state with a known tier event. */
const assignSiteWithRenewal = async (
  { attendee, event, site }: AssignmentContext,
  tierEvent: TierEvent,
): Promise<SiteAssignment> => {
  await assignBuiltSite(site.id, attendee.id, event.id);
  await provisionSiteRenewal(
    site,
    tierEvent.id,
    event.initial_site_months,
    `Failed to push initial READ_ONLY_FROM for site ${site.id}`,
  );
  return { eventName: event.name, siteUrl: site.bunnyUrl };
};

/** Assign built sites to entries that need them. Returns assigned URLs. */
const assignSitesForEntries = async (
  entries: SiteAssignmentEntry[],
): Promise<SiteAssignment[]> => {
  const needsSite = entries.filter(
    (e: SiteAssignmentEntry) => e.event.assign_built_site,
  );
  if (needsSite.length === 0) return [];

  const tierEvent = await pickTierEvent();
  if (!tierEvent) {
    logError({
      code: ErrorCode.CONFIG_MISSING,
      detail: `No qualifying tier event for site assignment (${needsSite.length} entr${needsSite.length === 1 ? "y" : "ies"} skipped)`,
    });
    sendNtfyError("CONFIG_MISSING");
    return [];
  }

  const assignments: SiteAssignment[] = [];
  const available = await getAssignableBuiltSites();
  let idx = 0;

  for (const { event, attendee } of needsSite) {
    if (event.initial_site_months <= 0) {
      logError({
        code: ErrorCode.DATA_INVALID,
        detail: `assign_built_site event ${event.id} has initial_site_months=0, skipping`,
      });
      continue;
    }

    const qty = attendee.quantity;
    for (let i = 0; i < qty; i++) {
      const site = available[idx] ?? (await buildSiteForAssignment());
      if (!site) break;

      assignments.push(
        await assignSiteWithRenewal({ attendee, event, site }, tierEvent),
      );
      idx++;
    }
  }

  return assignments;
};

/** Send site assignment notification email */
const sendSiteAssignmentEmail = async (
  to: string,
  assignments: SiteAssignment[],
): Promise<void> => {
  const config = getEmailConfig() ?? getHostEmailConfig();
  if (!config) return;

  const subject =
    assignments.length === 1
      ? "Your new site is ready"
      : `Your ${assignments.length} new sites are ready`;

  const greeting = `Your new site${
    assignments.length > 1 ? "s are" : " is"
  } ready!`;

  const htmlList = assignments
    .map(
      (a) => `<li>${a.eventName}: <a href="${a.siteUrl}">${a.siteUrl}</a></li>`,
    )
    .join("");

  const textList = assignments
    .map((a) => `- ${a.eventName}: ${a.siteUrl}`)
    .join("\n");

  const replyTo = settings.businessEmail || undefined;
  await sendEmail(config, {
    html: `<p>${greeting}</p><ul>${htmlList}</ul>`,
    replyTo,
    subject,
    text: `${greeting}\n\n${textList}`,
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

  const email = entries[0]!.attendee.email;
  await sendSiteAssignmentEmail(email, assignments);
};
