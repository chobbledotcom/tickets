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
import { getAllEvents } from "#shared/db/events.ts";
import { isQualifyingTierEvent } from "#shared/site-assignment.ts";
import type { EventWithCount } from "#shared/types.ts";
import { renewalErrorPage } from "#templates/public/renewal.tsx";
import { buildTicketEventsWithGroupCapacity } from "./ticket-events.ts";
import { getTicketContext } from "./ticket-payment.ts";
import { handleTicket } from "./ticket-submit.ts";

const renewalActionUrl = (token: string): string =>
  `/renew/?t=${encodeURIComponent(token)}`;

/** Resolve site by token; null result becomes 404. */
const resolveRenewalSite = async (token: string | null) => {
  if (!token) return null;
  const tokenIndex = await hmacHash(token);
  return getBuiltSiteByRenewalTokenIndex(tokenIndex);
};

const loadQualifyingTiers = async (): Promise<EventWithCount[]> => {
  const events = await getAllEvents();
  return events.filter(isQualifyingTierEvent);
};

/** Shared handler for GET and POST: resolve token, build context, hand off to handleTicket. */
const handleRenewal = async (request: Request): Promise<Response> => {
  const token = new URL(request.url).searchParams.get("t");
  const site = await resolveRenewalSite(token);
  if (!site || !token) return notFoundResponse();

  const tiers = await loadQualifyingTiers();
  if (tiers.length === 0) {
    return htmlResponse(renewalErrorPage({ siteName: site.name }));
  }

  const activeEvents = await buildTicketEventsWithGroupCapacity(tiers);
  const actionUrl = renewalActionUrl(token);

  const deadlineDate = site.readOnlyFrom
    ? eventDateToCalendarDate(site.readOnlyFrom)
    : null;

  return handleTicket(request, [], activeEvents, async (events) => {
    const base = await getTicketContext(events);
    return {
      ...base,
      actionUrl,
      groupDescription: deadlineDate
        ? `Current deadline: ${formatDateLabel(
            deadlineDate,
          )}. Pick a tier and quantity below.`
        : "Pick a tier and quantity below.",
      groupName: `Renew ${site.name}`,
      siteToken: token,
    };
  });
};

export {
  handleRenewal as handleRenewalGet,
  handleRenewal as handleRenewalPost,
};
