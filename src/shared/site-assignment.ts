/**
 * Built site assignment — assigns sites to attendees after booking completion.
 * Sends a separate notification email with site URLs.
 * All assignment logic is gated behind CAN_BUILD_SITES.
 */

import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { builderApi } from "#shared/builder.ts";
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
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { addMonthsIso } from "#shared/dates.ts";
import {
  getEmailConfig,
  getHostEmailConfig,
  sendEmail,
} from "#shared/email.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { nowIso } from "#shared/now.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { sort } from "#fp";

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
export const pickTierEvent = async (): Promise<
  (Awaited<ReturnType<typeof getAllEvents>>[number]) | null
> => {
  const events = await getAllEvents();
  const qualifying = events.filter(
    (e) => e.purchase_only && e.hidden && e.months_per_unit > 0 && e.active,
  );
  if (qualifying.length === 0) return null;
  const sorted = sort(
    (a: (typeof qualifying)[number], b: (typeof qualifying)[number]) =>
      a.unit_price - b.unit_price,
  )(qualifying);
  return sorted[0] ?? null;
};

/** Generate a renewal token + its HMAC blind index. */
export const generateRenewalToken = async (): Promise<{
  token: string;
  index: string;
}> => {
  const token = generateSecureToken();
  const index = await hmacHash(token);
  return { index, token };
};

/** Build the renewal URL for a given token. */
export const renewalUrlFor = (token: string): string =>
  `https://${getEffectiveDomain()}/renew/?t=${encodeURIComponent(token)}`;

/** Push READ_ONLY_FROM (and optionally RENEWAL_URL) to the edge script and persist on success. */
export const pushReadOnlyFrom = async (
  site: BuiltSite,
  cutoffIso: string,
  renewalUrl?: string,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const scriptId = Number(site.bunnyScriptId);
  if (!scriptId) return { error: "No bunnyScriptId", ok: false };

  const fromResult = await bunnyCdnApi.setEdgeScriptSecret(
    scriptId,
    "READ_ONLY_FROM",
    cutoffIso,
  );
  if (!fromResult.ok) return { error: fromResult.error, ok: false };

  if (renewalUrl) {
    const urlResult = await bunnyCdnApi.setEdgeScriptSecret(
      scriptId,
      "RENEWAL_URL",
      renewalUrl,
    );
    if (!urlResult.ok) return { error: urlResult.error, ok: false };
  }

  await updateBuiltSiteRenewalState(site.id, { readOnlyFrom: cutoffIso });
  return { ok: true };
};

/** Assign built sites to entries that need them. Returns assigned URLs. */
const assignSitesForEntries = async (
  entries: SiteAssignmentEntry[],
): Promise<SiteAssignment[]> => {
  const needsSite = entries.filter(
    (e: SiteAssignmentEntry) => e.event.assign_built_site,
  );
  if (needsSite.length === 0) return [];

  const assignments: SiteAssignment[] = [];
  const available = await getAssignableBuiltSites();
  let idx = 0;

  for (const { event, attendee } of needsSite) {
    if (event.initial_site_months <= 0) {
      logError({
        code: ErrorCode.DATA_INVALID,
        detail:
          `assign_built_site event ${event.id} has initial_site_months=0, skipping`,
      });
      continue;
    }

    const qty = attendee.quantity;
    for (let i = 0; i < qty; i++) {
      const site = available[idx] ?? (await buildSiteForAssignment());
      if (!site) break;

      const tierEvent = await pickTierEvent();
      if (!tierEvent) {
        logError({
          code: ErrorCode.CONFIG_MISSING,
          detail:
            `No qualifying tier event found for site assignment (event ${event.id})`,
        });
        sendNtfyError("CONFIG_MISSING");
        continue;
      }

      await assignBuiltSite(site.id, attendee.id, event.id);

      const { token, index: tokenIndex } = await generateRenewalToken();
      const cutoff = addMonthsIso(nowIso(), event.initial_site_months);
      const renewalUrl = renewalUrlFor(token);

      const pushResult = await pushReadOnlyFrom(site, cutoff, renewalUrl);
      if (pushResult.ok) {
        await updateBuiltSiteRenewalState(site.id, {
          renewalTokenIndex: tokenIndex,
          renewalTierEventId: tierEvent.id,
          renewalToken: token,
          readOnlyFrom: cutoff,
        });
      } else {
        logError({
          code: ErrorCode.CDN_REQUEST,
          detail:
            `Failed to push READ_ONLY_FROM for site ${site.id}: ${pushResult.error}`,
        });
        sendNtfyError("CDN_REQUEST");
        await updateBuiltSiteRenewalState(site.id, {
          renewalTokenIndex: tokenIndex,
          renewalTierEventId: tierEvent.id,
          renewalToken: token,
        });
      }

      assignments.push({ eventName: event.name, siteUrl: site.bunnyUrl });
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

  const subject = assignments.length === 1
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
