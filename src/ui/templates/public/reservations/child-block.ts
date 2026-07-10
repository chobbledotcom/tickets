/** Per-parent child selector rendering: each bookable child as a per-unit quantity
 * row (or, when there is a sole bookable child, an informational auto-select
 * marker), the "choose N in total" guidance, the children's pay-more price
 * inputs, and their deduped non-required questions. Requiredness/totals are
 * enforced server-side. */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  type ChildDatesByDayCount,
  childDateKey,
  dayCountsChildSupports,
  encodeChildDatesByDayCount,
  type TicketListing,
} from "#shared/booking/model.ts";
import {
  childCanBeBooked,
  childTicketLimit,
  groupCapacityInfo,
} from "#shared/booking/package-cap.ts";
import {
  childPriceFieldName,
  childQuantityFieldName,
} from "#shared/booking/tree.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { escapeHtml } from "#templates/layout.tsx";
import { renderListingAttributes } from "../listing-attributes.ts";
import {
  childLimitedMax,
  childPriceLabel,
  childPriceMinor,
  childQuestionsToRender,
} from "./child-pricing.ts";
import { renderPayMoreInput } from "./controls.ts";
import { quantityOptions, restoredChildQty } from "./quantities.ts";
import { renderQuestion } from "./questions.tsx";
import type { ChildRenderCtx } from "./types.ts";

/* jscpd:ignore-end */

/** Adds the child date data the browser uses to disable impossible choices. */
const childDateAttrs = (
  parentId: number,
  child: TicketListing,
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>,
): string => {
  const attrs: string[] = [];
  const dates = childDatesById.get(childDateKey(parentId, child.listing.id));
  if (dates !== undefined) {
    attrs.push(
      ` data-child-dates="${escapeHtml(encodeChildDatesByDayCount(dates))}"`,
    );
  }
  const dayCounts = dayCountsChildSupports(child);
  if (dayCounts !== null) {
    attrs.push(` data-child-spans="${escapeHtml(dayCounts.join(","))}"`);
  }
  return attrs.join("");
};

/** Render one child as a per-unit quantity row: a `child_qty_<parentId>_<childId>`
 * select over `0..childLimit`, plus — for a bookable pay-more child — its
 * non-required price input. A sold-out/closed/inactive child renders a disabled
 * select fixed at 0, never selectable. The select is non-required in
 * markup; the server fold validates the per-parent total. A bookable
 * child also carries its date/span compatibility attributes ({@link
 * childDateAttrs}) for the client compatibility script. */
const renderChildOption = (
  parent: ListingWithCount,
  child: TicketListing,
  childLimit: number,
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>,
  showZero: boolean,
  attributesHtml = "",
): string => {
  const parentId = parent.id;
  const { listing } = child;
  const bookable = childCanBeBooked(child);
  const selectName = childQuantityFieldName(parentId, listing.id);
  const priceHtml =
    listing.can_pay_more && bookable
      ? renderPayMoreInput(
          listing,
          childPriceFieldName(parentId, listing.id),
          undefined,
          false,
        )
      : "";
  const label = bookable
    ? `${escapeHtml(listing.name)} ${childPriceLabel(
        listing,
        parent,
        showZero,
      )}`.trim()
    : escapeHtml(t("public.ticket.child_unavailable", { name: listing.name }));
  const select = bookable
    ? `<select name="${selectName}" data-child-qty="${listing.id}"${childDateAttrs(
        parentId,
        child,
        childDatesById,
      )}>${quantityOptions(
        childLimit,
        restoredChildQty(parentId, listing.id, childLimit),
      )}</select>`
    : `<select name="${selectName}" disabled><option value="0" selected>0</option></select>`;
  return `<label class="child-option">${select} ${label}</label>${priceHtml}${attributesHtml}`;
};

/** Render a sole bookable child as INFORMATIONAL (auto-select preserved): no
 * submitted `child_qty_<parentId>_<childId>` field at all — the server fold
 * auto-fills the sole child to the parent's quantity Q whenever nothing was
 * submitted, so emitting a fixed quantity would over-submit and the fold would
 * reject it as "too many" when Q is below that cap. Instead show
 * just the child's name plus its (non-zero) price, and — for a pay-more sole child
 * — its (non-required) price input, which the fold reads for the auto-selected
 * child. No-JS safe: nothing posts a quantity for it.
 *
 * The buyer makes no choice for a sole child, so it carries no "choose an option"
 * prompt (that lives on the parent's `<legend>`, suppressed for a sole child — see
 * {@link renderChildBlock}). A HIDDEN child shows nothing visible — the operator
 * hid it from public view — but keeps its data markers and pay-more price input so
 * the fold and the compat/required client scripts still drive off them.
 *
 * The informational marker ALSO carries the same date/span compatibility
 * attributes a selectable child option does ({@link childDateAttrs}) so on a
 * group/multi-listing page (where the date/day-count controls aren't globally
 * constrained to the child's calendar) the client script can tell the auto-selected
 * sole child can't serve the chosen date/span and flag/disable the parent — rather
 * than letting the buyer hit the submit-side `child_sold_out` rejection. */
const renderSoleChildOption = (
  parent: ListingWithCount,
  child: TicketListing,
  childDatesById: ReadonlyMap<string, ChildDatesByDayCount>,
  showZero: boolean,
  attributesHtml = "",
): string => {
  const parentId = parent.id;
  const { listing } = child;
  const priceHtml = listing.can_pay_more
    ? renderPayMoreInput(
        listing,
        childPriceFieldName(parentId, listing.id),
        undefined,
        false,
      )
    : "";
  const visible = !listing.hidden;
  const namePart = visible ? escapeHtml(listing.name) : "";
  const pricePart = visible ? childPriceLabel(listing, parent, showZero) : "";
  const label = `${namePart} ${pricePart}`.trim();
  return `<p class="child-option child-sole" data-sole-parent="${parentId}" data-sole-child="${listing.id}"${childDateAttrs(
    parentId,
    child,
    childDatesById,
  )}>${label}</p>${priceHtml}${visible ? attributesHtml : ""}`;
};

/**
 * Render the per-parent child block: a `child_qty_<parentId>_<childId>` select per
 * child, a "Choose <Q> add-on(s) in total" note plus a live "X of Q chosen" hint,
 * each bookable pay-more child's price input, and the children's questions (deduped,
 * non-required). A SOLE bookable child renders as informational (auto-select
 * preserved, see {@link renderSoleChildOption}). Empty string when the parent has
 * no children. Requiredness/totals are enforced server-side.
 */
export const renderChildBlock = (
  parentInfo: TicketListing,
  ctx: ChildRenderCtx,
): string => {
  const parent = parentInfo.listing;
  const parentId = parent.id;
  const children = ctx.children.get(parentId);
  if (!children || children.length === 0) return "";
  const bookable = children.filter(childCanBeBooked);
  // The parent's effective max is the per-parent total ceiling; each child select is
  // additionally capped by its own parent+child order capacity (below).
  const total = childLimitedMax(parentInfo, ctx);
  // A SOLE bookable child is auto-selected by the fold (informational), so the buyer
  // makes no choice: suppress the "choose an option" legend and the "choose N in
  // total" guidance and let the child option show its name directly.
  const sole = bookable.length === 1;
  // Hide prices across the WHOLE block when every bookable child is free (£0): a
  // solo free child shows no "(£0)", and an all-free multi-child selector drops every
  // price; one paid sibling among free children keeps all prices (including the £0
  // ones) so the buyer can still compare.
  const showZero = !bookable.every(
    (child) => childPriceMinor(child.listing, parent) === 0,
  );
  const isSole = (child: TicketListing): boolean =>
    bookable.length === 1 && bookable[0]!.listing.id === child.listing.id;
  const options = children
    .map((child) => {
      const childAttributesHtml = renderListingAttributes(
        ctx.attributesByListing.get(child.listing.id),
      );
      return isSole(child)
        ? renderSoleChildOption(
            parent,
            child,
            ctx.childDatesById,
            showZero,
            childAttributesHtml,
          )
        : renderChildOption(
            parent,
            child,
            childCanBeBooked(child)
              ? Math.min(
                  total,
                  childTicketLimit(
                    parentInfo,
                    child,
                    groupCapacityInfo(
                      ctx.groupRemainingByGroupId,
                      ctx.groupIdsByListingId,
                    ),
                  ),
                )
              : 0,
            ctx.childDatesById,
            showZero,
            childAttributesHtml,
          );
    })
    .join("");
  const questionsHtml = children
    .map((child) => {
      const toRender = childQuestionsToRender(child.listing.id, ctx);
      for (const q of toRender) ctx.rendered.add(q.id);
      return toRender
        .map((q) =>
          String(
            renderQuestion(
              q,
              false,
              ctx.questionListingMap?.get(q.id)?.join(" "),
            ),
          ),
        )
        .join("");
    })
    .join("");
  // The "choose N in total" note + live hint guide the per-unit selection. At no-JS
  // render the parent quantity isn't chosen yet, so the note seeds with the parent's
  // effective max; JS recomputes it live against the parent select. Suppressed for a
  // sole auto-selected child — nothing for the buyer to choose.
  const note = sole
    ? ""
    : `<p class="child-total-note" data-child-total="${parentId}">` +
      `${escapeHtml(t("public.ticket.choose_total", { count: total }))} ` +
      `<span class="child-total-hint" data-child-hint="${parentId}"></span></p>`;
  const legend = sole
    ? ""
    : `<legend>${escapeHtml(
        t("public.ticket.choose_option", { name: parent.name }),
      )}</legend>`;
  return (
    `<fieldset class="child-selector" data-parent-id="${parentId}">` +
    `${legend}${note}${options}${questionsHtml}</fieldset>`
  );
};
