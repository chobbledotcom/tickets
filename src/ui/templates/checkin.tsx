/**
 * Check-in page templates
 * Admin view: attendee details with check-in/check-out button
 * Non-admin view: simple confirmation message
 */

import { map, pipe } from "#fp";
import { t } from "#i18n";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
// jscpd:ignore-start
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { Flash } from "#shared/forms/flash.tsx";
import type { AttendeeColumnKey } from "#shared/tables/configurable.ts";
import type { TableLayout } from "#shared/tables/layout.ts";
// jscpd:ignore-end
import { AttendeeTableBlock } from "#templates/admin/attendee-table-block.tsx";
import { Layout } from "#templates/layout.tsx";
import type { AttendeeTableRow } from "#types";
import { messagePublicPage } from "./public/prose-page.tsx";
import { SubmitWithHidden } from "./public/unsubscribe.tsx";

/**
 * Admin check-in page - shows attendee details with check-in/check-out button
 */
type CheckinAdminPageOptions = {
  canCheckIn: boolean;
  doorOnly: boolean;
  linkAdminPages: boolean;
};

/** The door-safe columns a door-only login's ticket page shows, fixed so an
 * operator's staff-table column order cannot empty it: the projection blanks
 * contact fields, and a layout that selected only those would hide every
 * column. The date column hides itself for date-less tickets. */
const DOOR_SAFE_COLUMNS: TableLayout<AttendeeColumnKey> = {
  columnKeys: ["name", "listings", "date", "qty", "status"],
  filters: new Map(),
};

const bulkForm = (
  checkinPath: string,
  label: string,
  buttonClass: string,
  nextValue: string,
): JSX.Element => (
  <CsrfForm action={checkinPath}>
    <SubmitWithHidden
      buttonClass={buttonClass}
      label={label}
      name="check_in"
      value={nextValue}
    />
  </CsrfForm>
);

/** The door-only bulk forms: no per-row controls, so both actions stay
 * available and each renders only when its POST could change a row — admit
 * a waiting party, or undo the check-ins a door made. */
const doorBulkForms = (
  checkinPath: string,
  heading: JSX.Element,
  anyCheckedIn: boolean,
  allCheckedIn: boolean,
): JSX.Element => (
  <>
    {heading}
    {!allCheckedIn &&
      bulkForm(
        checkinPath,
        t("admin.checkin.check_in_all"),
        "bulk-checkin",
        "true",
      )}
    {anyCheckedIn &&
      bulkForm(
        checkinPath,
        t("admin.checkin.check_out_all"),
        "bulk-checkout",
        "false",
      )}
  </>
);

/** The staff bulk form: one flipping button beside their per-row controls,
 * offering checkout only once every eligible row is in. */
const staffBulkForm = (
  checkinPath: string,
  heading: JSX.Element,
  offerCheckout: boolean,
): JSX.Element => (
  <CsrfForm action={checkinPath}>
    {heading}
    <SubmitWithHidden
      buttonClass={offerCheckout ? "bulk-checkout" : "bulk-checkin"}
      label={
        offerCheckout
          ? t("admin.checkin.check_out_all")
          : t("admin.checkin.check_in_all")
      }
      name="check_in"
      value={offerCheckout ? "false" : "true"}
    />
  </CsrfForm>
);

export const checkinAdminPage = (
  entries: TokenEntry[],
  checkinPath: string,
  message: string,
  allowedDomain: string,
  phonePrefix: string | undefined,
  options: CheckinAdminPageOptions,
): string => {
  const { canCheckIn } = options;
  const showDate = entries.some((e) => e.attendee.date !== null);
  const tableRows: AttendeeTableRow[] = pipe(
    map(
      (e: TokenEntry): AttendeeTableRow =>
        attendeeLineRow(e.attendee, e.listing),
    ),
  )(entries);

  // The bulk action's POST only touches rows that are neither refunded nor on
  // a "No check-in" listing, so the actions' state reads those rows alone —
  // a refunded row left checked-in must not hide the action a checkable row
  // still needs.
  const eligibleRows = entries.filter(
    (e) => !e.attendee.refunded && !e.listing.purchase_only,
  );
  const anyEligibleCheckedIn = eligibleRows.some((e) => e.attendee.checked_in);
  const allEligibleCheckedIn =
    eligibleRows.length > 0 && eligibleRows.every((e) => e.attendee.checked_in);
  const heading = (
    <>
      <h1>{t("admin.checkin.heading")}</h1>
      <Flash success={message} />
    </>
  );
  const bulkForms = canCheckIn
    ? options.doorOnly
      ? doorBulkForms(
          checkinPath,
          heading,
          anyEligibleCheckedIn,
          allEligibleCheckedIn,
        )
      : staffBulkForm(
          checkinPath,
          heading,
          options.linkAdminPages && allEligibleCheckedIn,
        )
    : heading;

  return String(
    <Layout title={t("admin.checkin.title")}>
      {bulkForms}
      <AttendeeTableBlock
        options={{
          adminLinks: options.linkAdminPages,
          allowedDomain,
          // A door-only login reads the fixed door-safe columns: the staff
          // table's configured column order must not empty their table.
          columnLayout: options.doorOnly ? DOOR_SAFE_COLUMNS : undefined,
          phonePrefix,
          returnUrl: checkinPath,
          rows: tableRows,
          // Each row's form POSTs to a staff-only admin endpoint, so only
          // staff see it; a door-only login reads each row's state as a
          // badge instead — and staff keep the badges when no toggle could
          // render (a token whose rows are all refunded or no-check-in).
          showCheckin: canCheckIn && options.linkAdminPages,
          showCheckinState: options.doorOnly || options.linkAdminPages,
          showDate,
          showListing: true,
        }}
      />
    </Layout>,
  );
};

/**
 * Non-admin check-in page - simple message telling the user to show this to an admin
 */
export const checkinPublicPage = messagePublicPage(
  "admin.checkin.public_title",
  "admin.checkin.public_heading",
  "admin.checkin.public_instructions",
);
