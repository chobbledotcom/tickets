/**
 * Renewal route — handles GET/POST for /renew/?t=<token>
 * Allows customers to renew their built site by paying for additional months.
 */

import { requireCsrfForm } from "#routes/csrf.ts";
import { runCheckoutFlow } from "#routes/public/ticket-payment.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  type BuiltSite,
  getBuiltSiteByRenewalTokenIndex,
} from "#shared/db/built-sites.ts";
import { getEventWithCount } from "#shared/db/events.ts";
import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";
import type { EventWithCount } from "#shared/types.ts";
import { renewalErrorPage, renewalPage } from "#templates/public/renewal.tsx";

type RenewalFailure = { ok: false; response: Response };
type RenewalContext = {
  ok: true;
  site: BuiltSite;
  tierEvent: EventWithCount;
  token: string;
};

/** Look up a built site by renewal token. Returns null if token is missing/invalid/tier unassigned. */
const resolveRenewalSite = async (
  token: string | null,
): Promise<{ ok: true; site: BuiltSite } | RenewalFailure> => {
  if (!token) return { ok: false, response: notFoundResponse() };

  const tokenIndex = await hmacHash(token);
  const site = await getBuiltSiteByRenewalTokenIndex(tokenIndex);
  if (!site || site.renewalTierEventId == null)
    return { ok: false, response: notFoundResponse() };

  return { ok: true, site };
};

const resolveRenewalTier = async (
  site: BuiltSite,
): Promise<{ ok: true; tierEvent: EventWithCount } | RenewalFailure> => {
  // site.renewalTierEventId is guaranteed non-null by resolveRenewalSite above.
  const tierEvent = await getEventWithCount(site.renewalTierEventId!);
  if (
    !tierEvent ||
    !tierEvent.active ||
    !tierEvent.purchase_only ||
    tierEvent.months_per_unit <= 0
  ) {
    return {
      ok: false,
      response: htmlResponse(renewalErrorPage({ siteName: site.name })),
    };
  }
  return { ok: true, tierEvent };
};

const resolveRenewalRequest = async (
  request: Request,
): Promise<RenewalContext | RenewalFailure> => {
  const token = new URL(request.url).searchParams.get("t");
  if (!token) return { ok: false, response: notFoundResponse() };

  const resolved = await resolveRenewalSite(token);
  if (!resolved.ok) return resolved;

  const tier = await resolveRenewalTier(resolved.site);
  if (!tier.ok) return tier;

  return { ok: true, site: resolved.site, tierEvent: tier.tierEvent, token };
};

/** GET /renew/?t=<token> — show the renewal form */
const withRenewalRequest =
  (
    handler: (
      resolved: RenewalContext,
      request: Request,
    ) => Promise<Response> | Response,
  ) =>
  async (request: Request): Promise<Response> => {
    const resolved = await resolveRenewalRequest(request);
    return resolved.ok ? handler(resolved, request) : resolved.response;
  };

export const handleRenewalGet = withRenewalRequest((resolved) =>
  htmlResponse(renewalPage(resolved)),
);

/** POST /renew/?t=<token> — process the renewal form submission */
export const handleRenewalPost = withRenewalRequest(
  async (resolved, request): Promise<Response> => {
    const { site, tierEvent } = resolved;
    const csrfResult = await requireCsrfForm(request, () =>
      htmlResponse(
        renewalPage({
          error: "CSRF token invalid",
          site,
          tierEvent,
          token: resolved.token,
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
      htmlResponse(
        renewalPage({ error: msg, site, tierEvent, token: resolved.token }),
      );

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
          siteToken: resolved.token,
          special_instructions: "",
        };
        return provider.createCheckoutSession(checkoutIntent, baseUrl);
      },
      errorRedirect,
    );
  },
);
