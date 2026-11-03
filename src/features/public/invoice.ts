/** Public invoice share page: GET /invoice/:token. */

import { getAttendeeBalanceState } from "#db/attendees/balance.ts";
import { getInvoiceByShareToken } from "#db/invoices.ts";
import { notFoundResponse, publicPageResponse } from "#routes/response.ts";
import type { PathMethodRoute } from "#routes/types.ts";
import { signBalanceToken } from "#shared/balance-link.ts";
import { openInvoiceBody } from "#shared/invoices/share.ts";
import { invoiceSharePage } from "#templates/public/invoice.tsx";
import { applyNoindex } from "./types.ts";

const SHARE_PREFIX = "/invoice/";

const handleInvoiceGet = async (token: string): Promise<Response> => {
  const invoice = await getInvoiceByShareToken(token);
  if (!invoice) return notFoundResponse();
  const [body, state] = await Promise.all([
    openInvoiceBody(invoice.body, token),
    getAttendeeBalanceState(invoice.attendee_id),
  ]);
  // An attendee delete removes its invoices, so a row without its attendee can
  // only come from a hand-edited database. The admin page answers not found for
  // that row, so the share link answers the same.
  if (!state) return notFoundResponse();
  const payToken =
    invoice.status === "new" && state.remainingBalance > 0
      ? await signBalanceToken(invoice.attendee_id)
      : null;
  return applyNoindex(
    await publicPageResponse(() =>
      invoiceSharePage({ body, invoice, payToken }),
    ),
  );
};

/** Serve the share link. Any other method keeps its normal routing. */
export const routeInvoice: PathMethodRoute = (_request, path, method) => {
  if (method !== "GET" || !path.startsWith(SHARE_PREFIX)) {
    return Promise.resolve(null);
  }
  return handleInvoiceGet(path.slice(SHARE_PREFIX.length));
};
