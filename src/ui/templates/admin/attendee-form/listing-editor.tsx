/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  LINE_KEY_PREFIX,
  LINE_LISTING_PREFIX,
  LINE_PACKAGE_PREFIX,
  NO_QUANTITY_PREFIX,
  QTY_PREFIX,
} from "#routes/admin/attendee-form-lines.ts";
import {
  type AttendeeFormLine,
  isPaymentLockedLine,
  isRetainedLine,
  SHOW_ALL_FIELD,
  SHOW_PACKAGE_PATHS_FIELD,
} from "#routes/admin/attendee-form-model.ts";
import { formatDateRangeLabel } from "#shared/dates.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { AdminListingLink } from "#templates/admin/admin-page.tsx";
import {
  BookingStatusBadges,
  InactiveNote,
} from "#templates/admin/attendee-detail.tsx";
import type {
  AttendeeFormProps,
  AttendeeFormTemplateData,
} from "#templates/admin/attendee-form/types.ts";
import { ErrorAlert } from "#templates/components/error.tsx";
import { renderTable } from "#templates/components/table.tsx";

/* jscpd:ignore-end */

/** The booking path shown beside a listing when it is not a standalone row. */
const pathLabel = (
  line: AttendeeFormLine,
  data: AttendeeFormTemplateData,
): string | null => {
  if (line.packageGroupId > 0) {
    const name = data.packageNamesById.get(line.packageGroupId);
    return name === undefined
      ? t("attendee_form.path_missing_package", { id: line.packageGroupId })
      : t("attendee_form.path_via_package", { name });
  }
  if (line.parentListingId > 0) {
    return t("attendee_form.path_addon_under", {
      name:
        data.parentNamesById.get(line.parentListingId) ??
        String(line.parentListingId),
    });
  }
  return null;
};

const lineRowClass = (line: AttendeeFormLine, booked: boolean): string => {
  if (booked) return "attendee-line";
  return line.packageGroupId > 0
    ? "attendee-line attendee-line-package-blank"
    : "attendee-line attendee-line-empty";
};

const listingNameCell = (
  line: AttendeeFormLine,
  data: AttendeeFormTemplateData,
): JSX.Element => {
  const listing = line.listing!;
  const label = pathLabel(line, data);
  return (
    <>
      <AdminListingLink listing={listing} />
      {label ? <span class="muted small booking-path"> {label}</span> : null}
      <InactiveNote active={listing.active} />
      {BookingStatusBadges({
        checkedIn: Boolean(line.existingBooking?.checked_in),
        refunded: Boolean(line.existingBooking?.refunded),
      })}
    </>
  );
};

const listingDatesCell = (line: AttendeeFormLine): JSX.Element => (
  <span class="muted small">
    {line.listing!.listing_type === "daily"
      ? t("attendee_form.shared_dates")
      : t("attendee_form.fixed_date")}
  </span>
);

const listingQuantityCell = (
  line: AttendeeFormLine,
  _data: AttendeeFormTemplateData,
  index: number,
): JSX.Element => {
  const listing = line.listing!;
  const paymentLocked = isPaymentLockedLine(line);
  return (
    <>
      <input
        aria-label={t("attendee_form.qty_aria", { title: listing.name })}
        class="line-qty"
        max={listing.max_quantity}
        min="0"
        name={`${QTY_PREFIX}${index}`}
        type="number"
        value={line.quantity === null ? "0" : String(line.quantity)}
      />
      <label class="small">
        <input
          checked={line.noQuantity}
          class="no-quantity-toggle"
          disabled={paymentLocked}
          name={`${NO_QUANTITY_PREFIX}${index}`}
          title={
            paymentLocked ? t("attendee_form.paid_no_quantity_line") : undefined
          }
          type="checkbox"
          value="1"
        />
        {t("attendee_form.no_quantity")}
      </label>
      <input
        name={`${LINE_LISTING_PREFIX}${index}`}
        type="hidden"
        value={String(line.listingId)}
      />
      <input
        name={`${LINE_KEY_PREFIX}${index}`}
        type="hidden"
        value={line.key}
      />
      {line.packageGroupId > 0 ? (
        <input
          name={`${LINE_PACKAGE_PREFIX}${index}`}
          type="hidden"
          value={String(line.packageGroupId)}
        />
      ) : null}
    </>
  );
};

const listingNoticesCell = (
  line: AttendeeFormLine,
  data: AttendeeFormTemplateData,
): JSX.Element => (
  <>
    {line.existingBooking?.start_at ? (
      <div class="muted small">
        {formatDateRangeLabel(
          line.existingBooking.start_at,
          line.existingBooking.end_at,
        )}
      </div>
    ) : null}
    {line.error ? <ErrorAlert>{line.error}</ErrorAlert> : null}
    {(data.lineWarnings.get(line.listingId) ?? []).map((warning) => (
      <div class="warning small" role="alert">
        {warning}
      </div>
    ))}
  </>
);

const listingColumns: readonly TableColumn<
  AttendeeFormLine,
  AttendeeFormTemplateData
>[] = [
  {
    cell: listingNameCell,
    header: t("terms.listing"),
    key: "listing",
  },
  {
    cell: listingDatesCell,
    header: t("attendee_form.col_dates"),
    key: "dates",
  },
  {
    cell: listingQuantityCell,
    className: "attendee-line-qty",
    header: t("attendee_form.col_qty"),
    key: "quantity",
  },
  {
    cell: listingNoticesCell,
    header: "",
    key: "notices",
  },
];

const listingEditorTable = defineTable(listingColumns);

/** The fixed listing editor with one quantity box per booking path. */
export const ListingEditor = ({ data }: AttendeeFormProps): JSX.Element => {
  const hasBookedLines = data.parsed.lines.some(
    (line) => isRetainedLine(line) || Boolean(line.existingBooking),
  );
  const hasPackagePathLines = data.parsed.lines.some(
    (line) => !line.existingBooking && line.packageGroupId > 0,
  );
  return (
    <div
      class={
        hasBookedLines ? "listing-editor" : "listing-editor show-all-listings"
      }
    >
      {hasBookedLines && (
        <label class="show-all">
          <input
            class="show-all-toggle"
            name={SHOW_ALL_FIELD}
            type="checkbox"
          />
          {t("attendee_form.show_all_listings")}
        </label>
      )}
      {hasPackagePathLines && (
        <label class="show-all">
          <input
            class="package-paths-toggle"
            name={SHOW_PACKAGE_PATHS_FIELD}
            type="checkbox"
          />
          {t("attendee_form.show_package_paths")}
        </label>
      )}
      {renderTable(listingEditorTable, data.parsed.lines, {
        context: data,
        rowAttrs: (line) => ({
          class: lineRowClass(
            line,
            isRetainedLine(line) || Boolean(line.existingBooking),
          ),
        }),
        tableClass: "line-editor",
      })}
    </div>
  );
};
