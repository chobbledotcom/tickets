/**
 * Calendar availability checker.
 *
 * A closed-by-default disclosure on the admin calendar listing every bookable
 * listing with its remaining capacity and price. Listings are selected with the
 * same hidden-checkbox mechanic the public `/order` page uses (a CSS counter
 * drives the floating button), and the form GETs to `/admin/attendees/new` so
 * the chosen listings — and the calendar's selected date — arrive pre-filled on
 * the create-attendee form. Selection and the live count are pure CSS; a small
 * progressive-enhancement script (see `client/admin/availability-checker.ts`)
 * only persists the open/closed state across a single navigation.
 */

import { sort } from "#fp";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { SELECT_PREFIX, START_DATE_FIELD } from "#shared/order-select.ts";
import { Icon } from "#templates/components/actions.tsx";
import { colClass } from "#templates/components/table-columns.ts";

/** One row of the availability table: a bookable listing and its remaining
 * capacity for the selected date (or overall when no date is selected). */
export type AvailabilityRow = {
  id: number;
  name: string;
  remaining: number;
  total: number;
  unitPrice: number;
  canPayMore: boolean;
};

/** Price label mirroring the public order card: "Free" for £0 listings, a
 * "From" prefix when the buyer may pay more. */
const priceLabel = (row: AvailabilityRow): string =>
  row.unitPrice <= 0
    ? t("availability.free")
    : `${row.canPayMore ? t("availability.from_prefix") : ""}${formatCurrency(row.unitPrice)}`;

/** One selectable listing row. The name links to the listing; the first cell
 * is the hidden checkbox + tick box that drives selection. */
const Row = ({ row }: { row: AvailabilityRow }): JSX.Element => {
  const field = `${SELECT_PREFIX}${row.id}`;
  return (
    <tr>
      <td>
        <label class="row-select">
          <input
            aria-label={t("availability.select_listing", { name: row.name })}
            class="order-select"
            id={field}
            name={field}
            type="checkbox"
            value="1"
          />
          <span aria-hidden="true" class="row-select-tick"></span>
        </label>
      </td>
      <td>
        <a href={`/admin/listing/${row.id}`}>{row.name}</a>
      </td>
      <td
        class={[colClass("quantity"), row.remaining <= 0 ? "danger" : null]
          .filter(Boolean)
          .join(" ")}
      >
        {row.remaining}/{row.total}
      </td>
      <td class={colClass("amount")}>{priceLabel(row)}</td>
    </tr>
  );
};

/**
 * The availability checker disclosure. Rendered closed; the create-attendee
 * button is hidden by CSS until at least one listing is selected. `date` (the
 * calendar's selected day) rides along as a hidden field so the create form can
 * pre-fill it and show accurate availability.
 */
export const AvailabilityChecker = ({
  rows,
  date,
}: {
  rows: AvailabilityRow[];
  date: string | null;
}): JSX.Element => (
  <details class="availability-checker" data-availability-checker>
    <summary>{t("availability.check")}</summary>
    <div class="availability-checker-body">
      {rows.length === 0 ? (
        <p>
          <em>{t("availability.no_bookable_listings")}</em>
        </p>
      ) : (
        <form
          action="/admin/attendees/new"
          class="selectable-form"
          method="get"
        >
          {date && <input name={START_DATE_FIELD} type="hidden" value={date} />}
          <div class="table-scroll">
            <table class="availability-table">
              <thead>
                <tr>
                  <th>
                    <span class="visually-hidden">
                      {t("availability.select")}
                    </span>
                  </th>
                  <th>{t("availability.listing")}</th>
                  <th class={colClass("quantity")}>
                    {t("availability.remaining")}
                  </th>
                  <th class={colClass("amount")}>{t("availability.price")}</th>
                </tr>
              </thead>
              <tbody>
                {sort((a: AvailabilityRow, b: AvailabilityRow) =>
                  a.name.localeCompare(b.name),
                )(rows).map((row) => (
                  <Row row={row} />
                ))}
              </tbody>
            </table>
          </div>
          <button class="order-cart" type="submit">
            <Icon name="user-plus" />
            <span aria-hidden="true" class="order-cart-count"></span>
            <span class="order-cart-label">
              {t("availability.create_attendee")}
            </span>
          </button>
        </form>
      )}
    </div>
  </details>
);
