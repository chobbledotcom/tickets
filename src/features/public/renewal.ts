/**
 * Renewal route — handles GET/POST for /renew/?t=<token>
 *
 * Lets a customer pick from the qualifying renewal tier events and pay for
 * any quantity of months. Reuses `handleTicket` so the picker UI, validation,
 * CSRF, and Stripe checkout flow stay the same as the regular ticket form.
 */

import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { eventDateToCalendarDate, formatDateLabel } from "#shared/dates.ts";
import { getBuiltSiteByRenewalTokenIndex } from "#shared/db/built-sites.ts";
import { getQualifyingTierEvents } from "#shared/site-assignment.ts";
import { renewalErrorPage } from "#templates/public/renewal.tsx";
import { renderTicketFlow } from "./ticket-submit.ts";
import { applyNoindex } from "./types.ts";

const renewalActionUrl = (token: string): string =>
  `/renew/?t=${encodeURIComponent(token)}`;

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

  const tiers = await getQualifyingTierEvents();
  if (tiers.length === 0) {
    return applyNoindex(
      htmlResponse(renewalErrorPage({ siteName: site.name })),
    );
  }

  const deadlineDate = site.readOnlyFrom
    ? eventDateToCalendarDate(site.readOnlyFrom)
    : null;

  return applyNoindex(
    await renderTicketFlow(request, [], {
      overrides: {
        actionUrl: renewalActionUrl(token),
        groupDescription: deadlineDate
          ? `Current deadline: ${formatDateLabel(
              deadlineDate,
            )}. Pick a tier and quantity below.`
          : "Pick a tier and quantity below.",
        groupName: `Renew ${site.name}`,
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
