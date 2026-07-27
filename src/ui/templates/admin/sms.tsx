/**
 * Admin SMS page — queue summary plus, when an attendee is targeted, a compose
 * form and the conversation history.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { formatDatetimeShort } from "#shared/dates.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import type {
  AdminSession,
  Attendee,
  ListingWithCount,
} from "#shared/types.ts";
import { flashAdminPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { SectionFieldset } from "#templates/components/aggregate-sections.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableHeader } from "#templates/components/translated-table-column.ts";
/* jscpd:ignore-end */

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

const historyColumns: readonly TableColumn<SmsHistoryItem>[] = [
  {
    cell: (item) => formatDatetimeShort(item.created),
    header: translatedTableHeader("sms.contact.col_when"),
    key: "when",
  },
  {
    cell: (item) => item.message,
    header: translatedTableHeader("sms.contact.col_message"),
    key: "message",
  },
];

const smsHistoryTable = defineTable(historyColumns);

const historyTable = (history: SmsHistoryItem[]): string =>
  history.length === 0
    ? `<p>${t("sms.contact.no_messages")}</p>`
    : String(renderTable(smsHistoryTable, history));

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
        <SaveForm
          action="/admin/sms"
          submitIcon="check"
          submitLabel={t("sms.contact.send")}
        >
          <input name="listing" type="hidden" value={String(listing.id)} />
          <input name="attendee" type="hidden" value={String(attendee.id)} />
          <SectionFieldset
            className="listing-section"
            legend={t("sms.contact.compose_heading")}
          >
            <label for="sms-message">{t("sms.contact.message_label")}</label>
            <textarea
              id="sms-message"
              maxlength="1000"
              name="message"
              required
              rows="4"
            />
          </SectionFieldset>
        </SaveForm>
      )}

      <h3>{t("sms.contact.history_heading")}</h3>
      <Raw html={historyTable(history)} />
    </>,
  );

export const smsPage = (session: AdminSession, opts: SmsPageOptions): string =>
  flashAdminPage(
    opts.target
      ? t("sms.contact.title", { name: opts.target.attendee.name })
      : t("sms.page.title"),
    "/admin/",
  )(
    session,
    opts.flash.error,
    opts.flash.success,
  )(
    <>
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
      <GuideFooter href="/admin/guide#sms">{t("sms.guide_link")}</GuideFooter>
    </>,
  );
