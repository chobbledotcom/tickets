/**
 * Built site assignment — assigns sites to attendees after booking completion.
 * Sends a separate notification email with site URLs.
 * All assignment logic is gated behind CAN_BUILD_SITES.
 */

import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { builderApi } from "#shared/builder.ts";
import {
  assignBuiltSite,
  type BuiltSite,
  builtSitesCrudTable,
  getAllBuiltSites,
  getAssignableBuiltSites,
} from "#shared/db/built-sites.ts";
import { settings } from "#shared/db/settings.ts";
import {
  getEmailConfig,
  getHostEmailConfig,
  sendEmail,
} from "#shared/email.ts";
import { ErrorCode, logError } from "#shared/logger.ts";

/** Entry with the fields needed for site assignment */
type SiteAssignmentEntry = {
  event: { id: number; name: string; assign_built_site: boolean };
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

/** Assign built sites to entries that need them. Returns assigned URLs. */
const assignSitesForEntries = async (
  entries: SiteAssignmentEntry[],
): Promise<SiteAssignment[]> => {
  const needsSite = entries.filter((e) => e.event.assign_built_site);
  if (needsSite.length === 0) return [];

  const assignments: SiteAssignment[] = [];
  const available = await getAssignableBuiltSites();
  let idx = 0;

  for (const { event, attendee } of needsSite) {
    const qty = attendee.quantity;
    for (let i = 0; i < qty; i++) {
      const site = available[idx] ?? (await buildSiteForAssignment());
      if (!site) break;
      await assignBuiltSite(site.id, attendee.id, event.id);
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
