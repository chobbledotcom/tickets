/**
 * Admin attendee "contact" page — send a text message via the SMS gateway.
 */

import { joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminSession,
  Attendee,
  ListingWithCount,
} from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

/** A text-message activity-log entry, shown as conversation history. */
export type SmsHistoryItem = {
  created: string;
  message: string;
};

const HistoryRow = ({ item }: { item: SmsHistoryItem }): string =>
  String(
    <tr>
      <td>{new Date(item.created).toLocaleString()}</td>
      <td>{item.message}</td>
    </tr>,
  );

const historyTable = (history: SmsHistoryItem[]): string =>
  history.length === 0
    ? `<p>${t("sms.contact.no_messages")}</p>`
    : String(
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("sms.contact.col_when")}</th>
                <th>{t("sms.contact.col_message")}</th>
              </tr>
            </thead>
            <tbody>
              <Raw
                html={pipe(
                  map((item: SmsHistoryItem) => HistoryRow({ item })),
                  joinStrings,
                )(history)}
              />
            </tbody>
          </table>
        </div>,
      );

export const attendeeContactPage = (
  { attendee, listing }: { attendee: Attendee; listing: ListingWithCount },
  session: AdminSession,
  history: SmsHistoryItem[],
  opts: { configured: boolean; success?: string; error?: string },
): string =>
  String(
    <Layout title={t("sms.contact.title", { name: attendee.name })}>
      <AdminNav active="/admin/" session={session} />
      <Flash error={opts.error} success={opts.success} />

      <p>
        <a href={`/admin/listing/${listing.id}/attendee/${attendee.id}/edit`}>
          {t("sms.contact.back")}
        </a>
      </p>

      <h1>{t("sms.contact.heading", { name: attendee.name })}</h1>
      <p>
        <strong>{t("sms.contact.phone_label")}</strong>{" "}
        {attendee.phone || t("sms.contact.no_phone")}
      </p>

      {!opts.configured && <Raw html={t("sms.contact.not_configured")} />}

      {attendee.phone && opts.configured && (
        <CsrfForm
          action={`/admin/listing/${listing.id}/attendee/${attendee.id}/contact`}
        >
          <h2>{t("sms.contact.compose_heading")}</h2>
          <label for="sms-message">{t("sms.contact.message_label")}</label>
          <textarea
            id="sms-message"
            maxlength="1000"
            name="message"
            required
            rows="4"
          />
          <SubmitButton icon="check">{t("sms.contact.send")}</SubmitButton>
        </CsrfForm>
      )}

      <h2>{t("sms.contact.history_heading")}</h2>
      <Raw html={historyTable(history)} />
    </Layout>,
  );
