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

/* jscpd:ignore-start */
import { sort } from "#fp";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { SELECT_PREFIX, START_DATE_FIELD } from "#shared/order-select.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableHeader } from "#templates/components/translated-table-column.ts";
import { OrderCartButtonBody } from "#templates/public/order-gallery.tsx";
/* jscpd:ignore-end */

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

const availabilityColumns: readonly TableColumn<AvailabilityRow>[] = [
  {
    cell: (row) => {
      const field = `${SELECT_PREFIX}${row.id}`;
      return (
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
      );
    },
    header: () => (
      <span class="visually-hidden">{t("availability.select")}</span>
    ),
    key: "select",
  },
  {
    cell: (row) => <a href={`/admin/listing/${row.id}`}>{row.name}</a>,
    header: translatedTableHeader("availability.listing"),
    key: "listing",
  },
  {
    cell: (row) => `${row.remaining}/${row.total}`,
    cellAttrs: (row) => ({ class: row.remaining <= 0 ? "danger" : undefined }),
    class: "quantity",
    header: translatedTableHeader("availability.remaining"),
    key: "remaining",
  },
  {
    cell: priceLabel,
    class: "amount",
    header: translatedTableHeader("availability.price"),
    key: "price",
  },
];

const availabilityTable = defineTable(availabilityColumns);

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
          {renderTable(
            availabilityTable,
            sort((a: AvailabilityRow, b: AvailabilityRow) =>
              a.name.localeCompare(b.name),
            )(rows),
            { tableClass: "availability-table" },
          )}
          <div class="order-actions">
            <button class="order-cart" type="submit">
              <OrderCartButtonBody
                icon="user-plus"
                label={t("availability.create_attendee")}
              />
            </button>
            <button
              class="order-cart"
              formaction="/admin/servicing/new"
              type="submit"
            >
              <OrderCartButtonBody
                icon="hammer"
                label={t("availability.create_service_event")}
              />
            </button>
          </div>
        </form>
      )}
    </div>
  </details>
);
