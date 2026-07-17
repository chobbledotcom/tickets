/**
 * Check-in page templates
 * Admin view: attendee details with check-in/check-out button
 * Non-admin view: simple confirmation message
 */

import { map, pipe } from "#fp";
import { t } from "#i18n";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { Flash } from "#shared/forms/flash.tsx";
import { AttendeeTableBlock } from "#templates/admin/attendee-table-block.tsx";
import type { AttendeeTableRow } from "#templates/attendee-table.tsx";
import { Layout } from "#templates/layout.tsx";
import { simplePublicPage } from "./public/shared.tsx";
import { SubmitWithHidden } from "./public/unsubscribe.tsx";

/** Alias export used by check-in templates */
export type { TokenEntry as CheckinEntry };

/**
 * Admin check-in page - shows attendee details with check-in/check-out button
 */
export const checkinAdminPage = (
  entries: TokenEntry[],
  checkinPath: string,
  message: string,
  allowedDomain: string,
  phonePrefix?: string,
): string => {
  const showDate = entries.some((e) => e.attendee.date !== null);
  const tableRows: AttendeeTableRow[] = pipe(
    map(
      (e: TokenEntry): AttendeeTableRow =>
        attendeeLineRow(e.attendee, e.listing),
    ),
  )(entries);

  const allCheckedIn = entries.every((e) => e.attendee.checked_in);
  const buttonLabel = allCheckedIn
    ? t("admin.checkin.check_out_all")
    : t("admin.checkin.check_in_all");
  const buttonClass = allCheckedIn ? "bulk-checkout" : "bulk-checkin";
  const nextValue = allCheckedIn ? "false" : "true";

  return String(
    <Layout title={t("admin.checkin.title")}>
      <CsrfForm action={checkinPath}>
        <h1>{t("admin.checkin.heading")}</h1>
        <Flash success={message} />
        <SubmitWithHidden
          buttonClass={buttonClass}
          label={buttonLabel}
          name="check_in"
          value={nextValue}
        />
      </CsrfForm>
      <AttendeeTableBlock
        options={{
          allowedDomain,
          phonePrefix,
          returnUrl: checkinPath,
          rows: tableRows,
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
export const checkinPublicPage = (): string =>
  simplePublicPage(
    t("admin.checkin.public_title"),
    t("admin.checkin.public_heading"),
  )(<p>{t("admin.checkin.public_instructions")}</p>);
