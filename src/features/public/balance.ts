/**
 * Public balance-payment routes: GET /pay/:token shows a PII-free recap and a
 * pay button; POST /pay/:token starts a checkout for the outstanding balance.
 *
 * The token only carries the attendee id (HMAC-signed); the amount due and
 * reserved/paid state are read live from plaintext columns, so no private key
 * is needed here.
 */

import { withCsrfForm } from "#routes/csrf.ts";
import { checkoutResponse, htmlResponse } from "#routes/response.ts";
import type { PathMethodRoute } from "#routes/types.ts";
import { getBaseUrl } from "#routes/url.ts";
import { verifyBalanceToken } from "#shared/balance-link.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getAttendeeStatus } from "#shared/db/attendee-statuses.ts";
import {
  getAttendeeBalanceState,
  getAttendeeOrderSummary,
  type OrderSummary,
} from "#shared/db/attendees/balance.ts";
import {
  type CheckoutIntent,
  getActivePaymentProvider,
} from "#shared/payments.ts";
import {
  balanceInvalidPage,
  balancePaymentPage,
  balanceSettledPage,
} from "#templates/public/balance.tsx";

/** An attendee with an outstanding, payable reservation balance. */
type Outstanding = {
  attendeeId: number;
  amount: number;
  summary: OrderSummary;
};

/**
 * Verify the token, load the outstanding balance, and run `fn` with it.
 * Returns the not-payable page when the token is invalid, the attendee is
 * unknown, or there's nothing left to pay.
 */
const withOutstanding = async (
  token: string,
  fn: (out: Outstanding) => Promise<Response>,
): Promise<Response> => {
  const payload = await verifyBalanceToken(token);
  const state = payload ? await getAttendeeBalanceState(payload.a) : null;
  if (!payload || !state) return htmlResponse(balanceInvalidPage());
  const status = state.statusId
    ? await getAttendeeStatus(state.statusId)
    : null;
  if (!status?.is_reservation || state.remainingBalance <= 0) {
    return htmlResponse(balanceSettledPage());
  }
  const summary = await getAttendeeOrderSummary(payload.a);
  // Publicly payable only when the attendee has ≥1 real (quantity > 0) line to
  // pay into — a no-quantity-only attendee can't be paid into a ghost. (The
  // checkbox save / merge writer already clear such a balance; this guards stale
  // links and is why the order summary excludes quantity-0 lines.)
  if (summary.lines.length === 0) return htmlResponse(balanceInvalidPage());
  return fn({ amount: state.remainingBalance, attendeeId: payload.a, summary });
};

/** GET /pay/:token — render the recap + pay button. */
const handleBalanceGet = (token: string): Promise<Response> =>
  withOutstanding(token, async (out) => {
    await signCsrfToken();
    return htmlResponse(balancePaymentPage(token, out.amount, out.summary));
  });

/** POST /pay/:token — create a fee-free checkout for the balance and redirect. */
const handleBalancePost = (
  request: Request,
  token: string,
): Promise<Response> =>
  withCsrfForm(
    request,
    () => htmlResponse(balanceInvalidPage()),
    () =>
      withOutstanding(token, async ({ amount, attendeeId, summary }) => {
        const provider = await getActivePaymentProvider();
        if (!provider) return htmlResponse(balanceInvalidPage());

        const intent: CheckoutIntent = {
          address: "",
          balanceAttendeeId: attendeeId,
          date: null,
          email: "",
          feeSubtotal: 0,
          items: [
            {
              listingId: summary.lines[0]?.listingId ?? 0,
              name: "Remaining balance",
              quantity: 1,
              slug: "balance",
              unitPrice: amount,
            },
          ],
          name: "Balance payment",
          phone: "",
          special_instructions: "",
        };
        const result = await provider.createCheckoutSession(
          intent,
          getBaseUrl(request),
        );
        if (!result || "error" in result) {
          return htmlResponse(balanceInvalidPage());
        }
        return checkoutResponse(result.checkoutUrl);
      }),
  );

/** Dispatch /pay/:token (GET recap, POST checkout). An empty/invalid token
 * simply renders the not-valid page from the handlers. */
export const routeBalance: PathMethodRoute = (request, path, method) => {
  if (!path.startsWith("/pay/")) return Promise.resolve(null);
  const token = path.slice("/pay/".length);
  if (method === "GET") return handleBalanceGet(token);
  if (method === "POST") return handleBalancePost(request, token);
  return Promise.resolve(null);
};
