/** Renewal recovery handlers for built sites: bump / override / re-sync the
 * customer deadline and provision (or retry) the renewal URL push. Split out
 * of built-sites.ts, which keeps the route table wired to these exports. */

import { logActivity } from "#db/activity-log.ts";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { isProvisioned, isReservedRenewal } from "#shared/renewal-helpers.ts";
import { pickTierListing } from "#shared/renewal-tier.ts";
import {
  addMonthsToRenewalDeadline,
  provisionSiteRenewal,
  renewalUrlFor,
  syncReadOnlyFrom,
} from "#shared/site-renewal.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import {
  type BuiltSitePost,
  builtSiteAction,
  builtSiteTabError,
  builtSiteTabResult,
  builtSiteTabSuccess,
} from "./built-site-action.ts";

const renewalPushResult = builtSiteTabResult(
  "renewal",
  (error) => `Deadline could not be pushed to the site: ${error}`,
);

/** The renewal tab result for a mutation, keyed on whether its push landed. */
export const editPushOk = (
  id: number,
  pushOk: boolean,
  success: string,
  failure: string,
): Response =>
  pushOk
    ? builtSiteTabSuccess(id, "renewal", success)
    : builtSiteTabError(id, "renewal", failure);

/** Max months any single bump/provision can request — guards against form tampering. */
const MAX_RENEWAL_MONTHS = 120;

const readClampedMonths = (form: {
  getString: (key: string) => string;
}): number => {
  const months = Number.parseInt(form.getString("months"), 10);
  if (!Number.isFinite(months) || months < 1) return 1;
  return Math.min(months, MAX_RENEWAL_MONTHS);
};

const parseDeadlineDate = (dateStr: string): string | null =>
  isIsoDate(dateStr) ? `${dateStr}T23:59:59Z` : null;

/** A reserved-but-unconfirmed token means the renewal URL never reached the
 * site: no deadline change may proceed while the retry path is the provision
 * route. Returns the tab error to return, or undefined to continue. */
const reservedRenewalError = (site: BuiltSite, id: number) =>
  isReservedRenewal(site)
    ? builtSiteTabError(
        id,
        "renewal",
        "Renewal is not provisioned for this site",
      )
    : undefined;

/** Run the action only when the site's renewal URL is not reserved-unconfirmed. */
const whenProvisioned =
  (action: BuiltSitePost): BuiltSitePost =>
  async (site, form, id) => {
    const blocked = reservedRenewalError(site, id);
    return blocked ?? action(site, form, id);
  };

/** POST /admin/built-sites/:id/bump-deadline */
export const handleBumpDeadline = builtSiteAction(
  whenProvisioned(async (site, form, id) => {
    // Storing a cutoff here would let the provision route refuse the retry
    // while the site still has no renewal link.
    const months = readClampedMonths(form);
    const newIso = addMonthsToRenewalDeadline(site, months);
    const result = await syncReadOnlyFrom(site, newIso);
    if (result.ok) {
      await logActivity(
        `Admin bumped '${site.name}' deadline by ${months} month(s)`,
      );
    }
    return renewalPushResult("Deadline bumped")(id, result);
  }),
);

/** POST /admin/built-sites/:id/override-deadline */
export const handleOverrideDeadline = builtSiteAction(
  whenProvisioned(async (site, form, id) => {
    const dateStr = form.getString("date");
    if (!dateStr) {
      return builtSiteTabError(id, "renewal", "Choose a deadline date");
    }
    const cutoffIso = parseDeadlineDate(dateStr);
    if (!cutoffIso) {
      return builtSiteTabError(id, "renewal", "Choose a valid deadline date");
    }
    const result = await syncReadOnlyFrom(site, cutoffIso);
    if (result.ok) {
      await logActivity(
        `Admin overrode '${site.name}' deadline to ${cutoffIso}`,
      );
    }
    return renewalPushResult("Deadline updated")(id, result);
  }),
);

/** POST /admin/built-sites/:id/re-sync-deadline */
export const handleReSyncDeadline = builtSiteAction(async (site, _form, id) => {
  if (!site.readOnlyFrom) {
    return builtSiteTabError(id, "renewal", "No deadline to re-sync");
  }
  const renewalUrl =
    isProvisioned(site) && site.renewalToken
      ? renewalUrlFor(site.renewalToken)
      : undefined;
  const result = await syncReadOnlyFrom(site, site.readOnlyFrom, renewalUrl);
  if (result.ok) {
    await logActivity(`Admin re-synced deadline for '${site.name}'`);
  }
  return renewalPushResult("Deadline re-synced")(id, result);
});

/** POST /admin/built-sites/:id/provision-renewal
 *
 * Gates on the existence of at least one qualifying renewal tier listing so an
 * admin doesn't generate a token that would dead-end at an empty /renew picker.
 * (The customer picks the actual tier at renew time.) */
export const handleProvisionRenewal = builtSiteAction(
  async (site, form, id) => {
    // A provisioned site with a set deadline is confirmed. Anything else —
    // no token yet, or a reserved token whose push never landed — is this
    // route's to (re)provision.
    if (isProvisioned(site) && !isReservedRenewal(site)) {
      return builtSiteTabError(
        id,
        "renewal",
        "Renewal is already provisioned for this site",
      );
    }
    const tier = await pickTierListing();
    if (!tier) {
      return builtSiteTabError(
        id,
        "renewal",
        "Create a qualifying renewal tier listing before provisioning",
      );
    }
    const months = readClampedMonths(form);
    const pushed = await provisionSiteRenewal(
      site,
      months,
      `Provision push failed for site ${id}`,
    );
    if (pushed) {
      await logActivity(
        `Admin provisioned renewals for '${site.name}' (${months}mo)`,
      );
    }
    return editPushOk(
      id,
      pushed,
      "Renewal provisioned",
      "Renewal could not be pushed to the site",
    );
  },
);
