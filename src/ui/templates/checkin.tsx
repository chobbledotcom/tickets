/**
 * Check-in page templates
 * Admin view: attendee details with check-in/check-out button
 * Non-admin view: simple confirmation message
 */

import { map, pipe } from "#fp";
import { t } from "#i18n";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  AttendeeTable,
  type AttendeeTableRow,
} from "#templates/attendee-table.tsx";
import { Layout } from "#templates/layout.tsx";

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
      (e: TokenEntry): AttendeeTableRow => ({
        attendee: e.attendee,
        listingId: e.listing.id,
        listingName: e.listing.name,
      }),
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
        <input name="check_in" type="hidden" value={nextValue} />
        <button class={buttonClass} type="submit">
          {buttonLabel}
        </button>
      </CsrfForm>
      <div class="table-scroll">
        <Raw
          html={AttendeeTable({
            allowedDomain,
            ...(phonePrefix !== undefined ? { phonePrefix } : {}),
            returnUrl: checkinPath,
            rows: tableRows,
            showDate,
            showListing: true,
          })}
        />
      </div>
    </Layout>,
  );
};

/**
 * Non-admin check-in page - simple message telling the user to show this to an admin
 */
export const checkinPublicPage = (): string =>
  String(
    <Layout title={t("admin.checkin.public_title")}>
      <div class="prose">
        <h1>{t("admin.checkin.public_heading")}</h1>
        <p>{t("admin.checkin.public_instructions")}</p>
      </div>
    </Layout>,
  );
