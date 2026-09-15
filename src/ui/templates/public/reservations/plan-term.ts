import type { TicketListing } from "#booking/model.ts";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { pricedMonthsForListing } from "./quantities.ts";

/** The label above the quantity selector: a renewal page prices its counts by
 *  the listing's months per unit, so a plan buys months where a ticket buys
 *  tickets. */
export const monthsQuantity = (
  listing: TicketListing["listing"],
  renewal?: boolean,
): string =>
  pricedMonthsForListing(listing, renewal) !== undefined
    ? t("public.ticket.number_of_months")
    : t("public.ticket.number_of_tickets");

/** A hidden selector buys exactly one unit; a plan hides its term there, so
 *  the fixed purchase still states the months it grants. */
export const termNoteFor = (
  listing: TicketListing["listing"],
  hideQuantity: boolean,
  renewal?: boolean,
): string => {
  const fixedTerm = pricedMonthsForListing(listing, renewal);
  return hideQuantity && fixedTerm !== undefined
    ? `<p class="child-total-note">${escapeHtml(
        t("public.ticket.fixed_term_granted", { count: fixedTerm }),
      )}</p>`
    : "";
};
