/** Renewal recovery handlers for built sites: bump / override / re-sync the
 * customer deadline and provision (or retry) the renewal URL push. Split out
 * of built-sites.ts, which keeps the route table wired to these exports. */

/* jscpd:ignore-start -- imports */
import { logActivity } from "#db/activity-log.ts";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { t } from "#i18n";
import type { FormParams } from "#shared/form-data.ts";
import { isProvisioned, isReservedRenewal } from "#shared/renewal-helpers.ts";
import { pickTierListing } from "#shared/renewal-tier.ts";
import type { Outcome } from "#shared/result.ts";
import {
  addMonthsToRenewalDeadline,
  provisionSiteRenewal,
  renewalUrlFor,
  syncReadOnlyFrom,
} from "#shared/site-renewal.ts";
import { parseDateString } from "#shared/validation/date-string.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import { type BuiltSitePost, builtSiteFormPost } from "./built-site-form.ts";
import { answerRenewalPush } from "./built-site-push.ts";
import { answerTab, refuseTab } from "./built-site-tab.ts";

/* jscpd:ignore-end */

/** Max months any single bump/provision can request — guards against form tampering. */
const MAX_RENEWAL_MONTHS = 120;

/** The months a bump or provision asks for. A blank or malformed field means
 * one month. A value above the limit is clamped to it. */
const readClampedMonths = (form: FormParams): number =>
  Math.min(parsePositiveInt(form.getString("months")) ?? 1, MAX_RENEWAL_MONTHS);

const parseDeadlineDate = (dateStr: string): string | null => {
  const day = parseDateString(dateStr);
  // The deadline is the end of the chosen day, UTC — the site's renewal
  // window closes after that day runs out.
  return day === null ? null : `${day}T23:59:59Z`;
};

/** One renewal write, given the site the route loaded and its parsed form. */
type RenewalWrite = (site: BuiltSite, form: FormParams) => Promise<Response>;

/** The renewal tab answer for a deadline sync: its success line, or the push
 * error the provider reported. */
const answerDeadlineSync = (
  id: number,
  result: Outcome,
  success: string,
): Response =>
  answerTab("renewal", id, result, success, (error) =>
    t("built_sites.deadline_push_failed", { error }),
  );

/** A reserved-but-unconfirmed token means the renewal URL never reached the
 * site: no deadline change can proceed while the retry path is the provision
 * route. Returns the tab error to return, or undefined to continue. */
const reservedRenewalError = (site: BuiltSite) =>
  isReservedRenewal(site)
    ? refuseTab("renewal", site.id, t("built_sites.renewal_not_provisioned"))
    : undefined;

/** Run the write only when the site's renewal URL is not reserved-unconfirmed. */
const whenProvisioned =
  (write: RenewalWrite): BuiltSitePost =>
  (site, _session, form) => {
    const blocked = reservedRenewalError(site);
    return blocked !== undefined ? blocked : write(site, form);
  };

const bumpDeadline: RenewalWrite = async (site, form) => {
  // This route stores no cutoff: the provision route is the one that refuses
  // the retry while the site still has no renewal link.
  const months = readClampedMonths(form);
  const newIso = addMonthsToRenewalDeadline(site, months);
  const result = await syncReadOnlyFrom(site, newIso);
  if (result.ok) {
    await logActivity(
      `Admin bumped '${site.name}' deadline by ${months} month(s)`,
    );
  }
  return answerDeadlineSync(site.id, result, t("built_sites.deadline_bumped"));
};

const overrideDeadline: RenewalWrite = async (site, form) => {
  const dateStr = form.getString("date");
  if (!dateStr) {
    return refuseTab("renewal", site.id, t("built_sites.choose_deadline_date"));
  }
  const cutoffIso = parseDeadlineDate(dateStr);
  if (!cutoffIso) {
    return refuseTab(
      "renewal",
      site.id,
      t("built_sites.choose_valid_deadline_date"),
    );
  }
  const result = await syncReadOnlyFrom(site, cutoffIso);
  if (result.ok) {
    await logActivity(`Admin overrode '${site.name}' deadline to ${cutoffIso}`);
  }
  return answerDeadlineSync(site.id, result, t("built_sites.deadline_updated"));
};

/** Re-push the site's stored deadline, then answer on the renewal tab. */
const resyncDeadline = async (site: BuiltSite): Promise<Response> => {
  if (!site.readOnlyFrom) {
    return refuseTab(
      "renewal",
      site.id,
      t("built_sites.no_deadline_to_resync"),
    );
  }
  const renewalUrl =
    isProvisioned(site) && site.renewalToken
      ? renewalUrlFor(site.renewalToken)
      : undefined;
  const result = await syncReadOnlyFrom(site, site.readOnlyFrom, renewalUrl);
  if (result.ok) {
    await logActivity(`Admin re-synced deadline for '${site.name}'`);
  }
  return answerDeadlineSync(
    site.id,
    result,
    t("built_sites.deadline_resynced"),
  );
};

/** Gates on the existence of at least one qualifying renewal tier listing.
 * Without the gate an admin generates a token that dead-ends at an empty
 * /renew picker. The customer picks the actual tier at renew time. */
const provisionRenewal: RenewalWrite = async (site, form) => {
  // A provisioned site with a set deadline is confirmed. Anything else — no
  // token yet, or a reserved token whose push never landed — is this route's
  // to (re)provision.
  if (isProvisioned(site) && !isReservedRenewal(site)) {
    return refuseTab(
      "renewal",
      site.id,
      t("built_sites.renewal_already_provisioned"),
    );
  }
  const tier = await pickTierListing();
  if (!tier) {
    return refuseTab("renewal", site.id, t("built_sites.renewal_needs_tier"));
  }
  const months = readClampedMonths(form);
  const pushed = await provisionSiteRenewal(
    site,
    months,
    `Provision push failed for site ${site.id}`,
  );
  return answerRenewalPush(site, pushed, {
    activity: `Admin provisioned renewals for '${site.name}' (${months}mo)`,
    failure: t("built_sites.renewal_push_failed"),
    success: t("built_sites.renewal_provisioned"),
  });
};

export const handleBumpDeadline = builtSiteFormPost(
  whenProvisioned(bumpDeadline),
);

export const handleOverrideDeadline = builtSiteFormPost(
  whenProvisioned(overrideDeadline),
);

export const handleReSyncDeadline = builtSiteFormPost((site) =>
  resyncDeadline(site),
);

export const handleProvisionRenewal = builtSiteFormPost(
  (site, _session, form) => provisionRenewal(site, form),
);
