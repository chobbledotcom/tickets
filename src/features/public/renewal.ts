/**
 * Renewal route — handles GET/POST for /renew/?t=<token>
 * Allows customers to renew their built site by paying for additional months.
 */

import { requireCsrfForm } from "#routes/csrf.ts";
import { runCheckoutFlow } from "#routes/public/ticket-payment.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { getBuiltSiteByRenewalTokenIndex } from "#shared/db/built-sites.ts";
import { getEventWithCount } from "#shared/db/events.ts";
import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";
import { renewalErrorPage, renewalPage } from "#templates/public/renewal.tsx";

/** Look up a built site by renewal token. Returns null if token is missing/invalid/tier unassigned. */
const resolveRenewalSite = async (
  token: string | null,
): Promise<
  | {
      ok: true;
      site: Awaited<ReturnType<typeof getBuiltSiteByRenewalTokenIndex>> &
        object;
    }
  | { ok: false; response: Response }
> => {
  if (!token) return { ok: false, response: notFoundResponse() };

  const tokenIndex = await hmacHash(token);
  const site = await getBuiltSiteByRenewalTokenIndex(tokenIndex);
  if (!site) return { ok: false, response: notFoundResponse() };
  if (site.renewalTierEventId == null)
    return { ok: false, response: notFoundResponse() };

  return { ok: true, site };
};

/** GET /renew/?t=<token> — show the renewal form */
export const handleRenewalGet = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const token = url.searchParams.get("t");

  const resolved = await resolveRenewalSite(token);
  if (!resolved.ok) return resolved.response;
  const site = resolved.site;

  const tierEvent = await getEventWithCount(site.renewalTierEventId!);
  if (
    !tierEvent ||
    !tierEvent.active ||
    !tierEvent.purchase_only ||
    tierEvent.months_per_unit <= 0
  ) {
    return htmlResponse(renewalErrorPage({ siteName: site.name }));
  }

  return htmlResponse(renewalPage({ site, tierEvent, token: token! }));
};

/** POST /renew/?t=<token> — process the renewal form submission */
export const handleRenewalPost = async (
  request: Request,
): Promise<Response> => {
  const url = new URL(request.url);
  const token = url.searchParams.get("t");

  const resolved = await resolveRenewalSite(token);
  if (!resolved.ok) return resolved.response;
  const site = resolved.site;

  const tierEvent = await getEventWithCount(site.renewalTierEventId!);
  if (
    !tierEvent ||
    !tierEvent.active ||
    !tierEvent.purchase_only ||
    tierEvent.months_per_unit <= 0
  ) {
    return htmlResponse(renewalErrorPage({ siteName: site.name }));
  }

  const csrfResult = await requireCsrfForm(request, () =>
    htmlResponse(
      renewalPage({
        error: "CSRF token invalid",
        site,
        tierEvent,
        token: token!,
      }),
      403,
    ),
  );
  if (!csrfResult.ok) return csrfResult.response;

  const form = csrfResult.form;
  const name = form.getString("name") || "";
  const email = form.getString("email") || "";
  let quantity = Number.parseInt(form.getString("quantity") || "1", 10);
  if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
  if (quantity > tierEvent.max_quantity) quantity = tierEvent.max_quantity;

  const item: CheckoutItem = {
    eventId: tierEvent.id,
    name: tierEvent.name,
    quantity,
    slug: tierEvent.slug,
    unitPrice: tierEvent.unit_price,
  };

  const errorRedirect = (msg: string, _status: number) =>
    htmlResponse(renewalPage({ error: msg, site, tierEvent, token: token! }));

  const baseUrl = getBaseUrl(request);

  return runCheckoutFlow(
    `renewal site=${site.name}`,
    request,
    (provider) => {
      const checkoutIntent: CheckoutIntent = {
        address: "",
        date: null,
        email,
        eventAnswerIds: undefined,
        items: [item],
        name,
        phone: "",
        siteToken: token!,
        special_instructions: "",
      };
      return provider.createCheckoutSession(checkoutIntent, baseUrl);
    },
    errorRedirect,
  );
};
