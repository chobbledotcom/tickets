/* jscpd:ignore-start -- imports */
import { settings } from "#db/settings.ts";
import { unique } from "#fp";
import { escapeHtml } from "#jsx/escape-html.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { getEmailConfig, hostEmail, sendEmail } from "#shared/email.ts";
import { ErrorCode, type ErrorCodeType, logError } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { parseEmail } from "#shared/validation/email.ts";
/* jscpd:ignore-end */

export type SiteAssignmentConfigValidation =
  | { ok: true }
  | {
      ok: false;
      reason: "builder_disabled" | "initial_months" | "missing_tier";
      message: string;
      listingId?: number;
    };

type SiteAssignmentConfigFailure = Exclude<
  SiteAssignmentConfigValidation,
  { ok: true }
>;
type SiteAssignmentFailureReport = {
  code: ErrorCodeType;
  notification: ErrorCodeType;
};

const SITE_ASSIGNMENT_FAILURE_REPORTS = {
  builder_disabled: {
    code: ErrorCode.CONFIG_MISSING,
    notification: ErrorCode.CONFIG_MISSING,
  },
  initial_months: {
    code: ErrorCode.DATA_INVALID,
    notification: ErrorCode.DATA_INVALID,
  },
  missing_tier: {
    code: ErrorCode.CONFIG_MISSING,
    notification: ErrorCode.CONFIG_MISSING,
  },
} as const satisfies Record<
  SiteAssignmentConfigFailure["reason"],
  SiteAssignmentFailureReport
>;

/** Report why post-checkout assignment was blocked. */
export const reportSiteAssignmentFailure = (
  failure: SiteAssignmentConfigFailure,
  skippedCount: number,
): void => {
  const report = SITE_ASSIGNMENT_FAILURE_REPORTS[failure.reason];
  logError({
    code: report.code,
    detail: `Site assignment blocked (${failure.reason}, ${skippedCount} entries skipped)${
      failure.listingId !== undefined ? `, listing #${failure.listingId}` : ""
    }`,
  });
  sendNtfyError(report.notification);
};

/** A plan buyer whose booking stood but got no site, because the pool of
 * pre-built assignable sites ran dry before their turn. */
export type MissedBuyer = {
  attendee: { email: string; name: string };
  listingName: string;
};

/** Tell the operator a plan sold with no assignable site to give the buyer.
 * The purchase stands, so the pool running dry must reach a human: the log,
 * a push notification, and the business email. */
export const reportOutOfStockBuyers = async (
  missed: readonly MissedBuyer[],
): Promise<void> => {
  if (missed.length === 0) return;
  const listingNames = unique(missed.map((m) => m.listingName)).join(" + ");
  logError({
    code: ErrorCode.SITE_ASSIGNMENT,
    detail: `${missed.length} plan buyer(s) got no site — the pool of assignable sites is empty (plans: ${listingNames})`,
  });
  sendNtfyError(ErrorCode.SITE_ASSIGNMENT);

  const config = getEmailConfig() ?? hostEmail.getHostConfig();
  const to = parseEmail(settings.businessEmail);
  if (!config || !to) return;
  const sitesUrl = `https://${getEffectiveDomain()}/admin/built-sites`;
  const lines: string[] = missed.map(
    (m) => `${m.listingName} — ${m.attendee.name} (${m.attendee.email})`,
  );
  await sendEmail(config, {
    html:
      "<p>A site plan was sold, and no site was available to assign. " +
      "The booking and its payment stand, and these buyers have no site yet:</p>" +
      `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` +
      `<p>Add sites on the <a href="${sitesUrl}">built-sites page</a>, then ` +
      "resend the notification for each buyer from their attendee page.</p>",
    subject: "A site plan sold with no site available",
    text:
      "A site plan was sold, and no site was available to assign.\n\n" +
      "The booking and its payment stand, and these buyers have no site yet:\n\n" +
      `${lines.map((line) => `- ${line}`).join("\n")}\n\n` +
      `Add sites on the built-sites page (${sitesUrl}), then resend the ` +
      "notification for each buyer from their attendee page.",
    to,
  });
};
