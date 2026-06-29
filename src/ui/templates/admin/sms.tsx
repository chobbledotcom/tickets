/**
 * Admin SMS page — queue summary plus, when an attendee is targeted, a compose
 * form and the conversation history.
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

type SmsPageOptions = {
  configured: boolean;
  queueCount: number;
  flash: { success?: string | undefined; error?: string | undefined };
  target?: { attendee: Attendee; listing: ListingWithCount };
  history: SmsHistoryItem[];
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

const ComposeForm = ({
  attendee,
  listing,
  configured,
  history,
}: {
  attendee: Attendee;
  listing: ListingWithCount;
  configured: boolean;
  history: SmsHistoryItem[];
}): string =>
  String(
    <>
      <p>
        <a href={`/admin/attendees/${attendee.id}`}>{t("sms.contact.back")}</a>
      </p>

      <h2>{t("sms.contact.heading", { name: attendee.name })}</h2>
      <p>
        <strong>{t("sms.contact.phone_label")}</strong>{" "}
        {attendee.phone || t("sms.contact.no_phone")}
      </p>

      {!configured && <Raw html={t("sms.contact.not_configured")} />}

      {attendee.phone && configured && (
        <CsrfForm action="/admin/sms">
          <input name="listing" type="hidden" value={String(listing.id)} />
          <input name="attendee" type="hidden" value={String(attendee.id)} />
          <h3>{t("sms.contact.compose_heading")}</h3>
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

      <h3>{t("sms.contact.history_heading")}</h3>
      <Raw html={historyTable(history)} />
    </>,
  );

export const smsPage = (session: AdminSession, opts: SmsPageOptions): string =>
  String(
    <Layout
      title={
        opts.target
          ? t("sms.contact.title", { name: opts.target.attendee.name })
          : t("sms.page.title")
      }
    >
      <AdminNav active="/admin/" session={session} />
      <Flash error={opts.flash.error} success={opts.flash.success} />

      <h1>{t("sms.page.title")}</h1>
      <p>{t("sms.queue.awaiting", { count: opts.queueCount })}</p>

      {opts.target && (
        <Raw
          html={ComposeForm({
            attendee: opts.target.attendee,
            configured: opts.configured,
            history: opts.history,
            listing: opts.target.listing,
          })}
        />
      )}
    </Layout>,
  );
