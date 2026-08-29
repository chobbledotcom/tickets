/**
 * Renewal route — handles GET/POST for /renew/?t=<token>
 *
 * Lets a customer pick a renewal tier listing and pay for any quantity of
 * months. A site set to one tier offers only that tier; every other site
 * offers all of them. Reuses `handleTicket` so the picker UI, validation,
 * CSRF, and Stripe checkout flow stay the same as the regular ticket form.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { getBuiltSiteByRenewalTokenIndex } from "#db/built-sites.ts";
import { t } from "#i18n";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { formatDateLabel, listingDateToCalendarDate } from "#shared/dates.ts";
import { siteRenewalTier } from "#shared/renewal-helpers.ts";
import { getQualifyingTierListings } from "#shared/site-assignment.ts";
import { renewalErrorPage } from "#templates/public/renewal.tsx";
import { renderTicketFlow } from "./ticket-submit.ts";
import { applyNoindex } from "./types.ts";

const renewalActionUrl = (token: string): string =>
  `/renew/?t=${encodeURIComponent(token)}`;

/** The line above the picker. One tier leaves nothing to choose between, so
 * name it instead of asking the customer to pick one. */
const pickerIntro = (tiers: { name: string }[]): string =>
  tiers.length === 1
    ? t("public_renewal.pick_quantity", { name: tiers[0]!.name })
    : t("public_renewal.pick_tier");

/** Resolve site by token; null result becomes 404. */
const resolveRenewalSite = async (token: string | null) => {
  if (!token) return null;
  const tokenIndex = await hmacHash(token);
  return getBuiltSiteByRenewalTokenIndex(tokenIndex);
};

/** Shared handler for GET and POST: resolve token, build context, hand off to handleTicket. */
const handleRenewal = async (request: Request): Promise<Response> => {
  const token = new URL(request.url).searchParams.get("t");
  const site = await resolveRenewalSite(token);
  if (!site || !token) return notFoundResponse();

  const { offered: tiers } = siteRenewalTier(
    site,
    await getQualifyingTierListings(),
  );
  if (tiers.length === 0) {
    return applyNoindex(
      htmlResponse(renewalErrorPage({ siteName: site.name })),
    );
  }

  const deadlineDate = site.readOnlyFrom
    ? listingDateToCalendarDate(site.readOnlyFrom)
    : null;
  const intro = pickerIntro(tiers);

  return applyNoindex(
    await renderTicketFlow(request, [], {
      overrides: {
        actionUrl: renewalActionUrl(token),
        groupDescription: deadlineDate
          ? `${t("public_renewal.deadline", {
              date: formatDateLabel(deadlineDate),
            })} ${intro}`
          : intro,
        groupName: t("public_renewal.heading", { name: site.name }),
        siteToken: token,
        terms: "",
      },
    })(tiers),
  );
};

export {
  handleRenewal as handleRenewalGet,
  handleRenewal as handleRenewalPost,
};
