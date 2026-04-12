/**
 * Built site assignment — assigns sites to attendees after booking completion.
 * Sends a separate notification email with site URLs.
 * All assignment logic is gated behind CAN_BUILD_SITES.
 */

import {
  assignBuiltSite,
  getAssignableBuiltSites,
} from "#lib/db/built-sites.ts";
import { settings } from "#lib/db/settings.ts";
import { getEmailConfig, getHostEmailConfig, sendEmail } from "#lib/email.ts";
import { isBuilderEnabled } from "#routes/admin/builder.ts";

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
      const site = available[idx];
      if (!site) break; // edge case: ran out (paid booking race)
      await assignBuiltSite(site.id, attendee.id, event.id);
      assignments.push({ siteUrl: site.bunnyUrl, eventName: event.name });
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

  const siteListHtml = assignments
    .map(
      (a) => `<li>${a.eventName}: <a href="${a.siteUrl}">${a.siteUrl}</a></li>`,
    )
    .join("");

  const html = `<p>Your new site${assignments.length > 1 ? "s are" : " is"} ready!</p><ul>${siteListHtml}</ul>`;

  const siteListText = assignments
    .map((a) => `- ${a.eventName}: ${a.siteUrl}`)
    .join("\n");

  const text = `Your new site${assignments.length > 1 ? "s are" : " is"} ready!\n\n${siteListText}`;

  const replyTo = settings.businessEmail || undefined;
  await sendEmail(config, { to, subject, html, text, replyTo });
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
