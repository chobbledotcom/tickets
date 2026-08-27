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
import { Layout } from "#templates/layout.tsx";
import type { AttendeeTableRow } from "#types";
import { messagePublicPage } from "./public/prose-page.tsx";
import { SubmitWithHidden } from "./public/unsubscribe.tsx";

/** Alias export used by check-in templates */
export type { TokenEntry as CheckinEntry };

/**
 * Admin check-in page - shows attendee details with check-in/check-out button
 */
type CheckinAdminPageOptions = {
  canCheckIn: boolean;
  linkAdminPages: boolean;
};

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

  const allCheckedIn = entries.every((e) => e.attendee.checked_in);
  const buttonLabel = allCheckedIn
    ? t("admin.checkin.check_out_all")
    : t("admin.checkin.check_in_all");
  const buttonClass = allCheckedIn ? "bulk-checkout" : "bulk-checkin";
  const nextValue = allCheckedIn ? "false" : "true";
  const heading = (
    <>
      <h1>{t("admin.checkin.heading")}</h1>
      <Flash success={message} />
    </>
  );

  return String(
    <Layout title={t("admin.checkin.title")}>
      {canCheckIn ? (
        <CsrfForm action={checkinPath}>
          {heading}
          <SubmitWithHidden
            buttonClass={buttonClass}
            label={buttonLabel}
            name="check_in"
            value={nextValue}
          />
        </CsrfForm>
      ) : (
        heading
      )}
      <AttendeeTableBlock
        options={{
          adminLinks: options.linkAdminPages,
          allowedDomain,
          phonePrefix,
          returnUrl: checkinPath,
          rows: tableRows,
          showCheckin: canCheckIn,
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
