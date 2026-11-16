/** Admin invoice pages: the list, the create form, and one invoice. */

import type { InvoiceRow, InvoiceSummary } from "#db/invoices.ts";
import { t } from "#i18n";
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import type { AuthSession } from "#routes/auth.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import type { FlashFields } from "#shared/flash-fields.ts";
import {
  INVOICE_STATUS_LABEL_KEYS,
  type InvoiceStatus,
} from "#shared/invoices/status.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
import type { DetailRow } from "#templates/admin/detail-rows.tsx";
import { ActionButton, SubmitButton } from "#templates/components/actions.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { LabelledRow } from "#templates/components/labelled-row.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { textareaBody } from "#templates/components/textarea.tsx";
import {
  dateLabelColumn,
  labelColumn,
  translatedTableColumn,
} from "#templates/components/translated-table-column.ts";
import { getInvoiceForm } from "#templates/fields/invoice.ts";

type InvoiceListRow = {
  attendeeName: string;
  created: string;
  id: number;
  status: InvoiceStatus;
};

const invoiceListTable = defineTable<InvoiceListRow>([
  translatedTableColumn("number", "invoices.column.number", (row) => (
    <a href={adminPath("invoice", { id: row.id })}>{row.id}</a>
  )),
  translatedTableColumn(
    "attendee",
    "invoices.column.attendee",
    (row) => row.attendeeName,
  ),
  dateLabelColumn("created", "invoices.column.created", (row) => row.created),
  labelColumn(
    "status",
    "invoices.column.status",
    INVOICE_STATUS_LABEL_KEYS,
    (row) => row.status,
  ),
]);

/** The rows every invoice page opens with: its number and who it is for. */
const whoRows = (
  number: number,
  attendeeName: string,
  attendeeEmail: string,
): DetailRow[] => [
  { key: t("invoices.column.number"), value: number },
  {
    key: t("invoices.column.attendee"),
    value: `${attendeeName} (${attendeeEmail})`,
  },
];

/** One step of the create flow. Both steps sit under the New invoice route,
 *  and differ only in where their form posts and what it holds. */
const invoiceFormPage = (
  action: string,
  fields: Child,
  session: AuthSession,
  title: string,
  flash?: FlashFields,
): string =>
  renderAdminPageSpec({
    active: "/admin/invoices/new",
    form: {
      action,
      fields,
      ...(flash === undefined ? {} : { flash }),
    },
    session,
    title,
  });

/** The invoices list. `attendeeNames` holds each row's decrypted name. */
export const adminInvoicesPage = ({
  attendeeNames,
  flash,
  invoices,
  session,
}: {
  attendeeNames: ReadonlyMap<number, string>;
  flash: FlashFields;
  invoices: InvoiceSummary[];
  session: AuthSession;
}): string =>
  renderAdminPageSpec({
    actions: (
      <ActionButton href={adminPath("invoiceNew", {})}>
        {t("invoices.action.create")}
      </ActionButton>
    ),
    active: "/admin/invoices",
    flash,
    list: {
      columns: invoiceListTable.columns,
      empty: t("invoices.empty"),
      items: invoices.map((invoice) => ({
        // An invoice whose attendee row is gone (hand-edited data only) still
        // lists, without a name, so an operator can find and delete it.
        attendeeName: attendeeNames.get(invoice.attendee_id) ?? "",
        created: invoice.created,
        id: invoice.id,
        status: invoice.status,
      })),
    },
    session,
    title: t("invoices.title"),
  });

/** The create form, with the next free invoice number prefilled. */
export const adminInvoiceNewPage = ({
  attendeeId,
  flash,
  nextNumber,
  session,
}: {
  attendeeId: number | null;
  flash: FlashFields;
  nextNumber: number;
  session: AuthSession;
}): string =>
  invoiceFormPage(
    adminPath("invoicePreview", {}),
    <>
      <p class="prose">{t("invoices.new_hint")}</p>
      <Raw
        html={getInvoiceForm().render({
          attendee_id: attendeeId === null ? "" : attendeeId,
          number: nextNumber,
        })}
      />
      <SubmitButton icon="save">{t("invoices.action.preview")}</SubmitButton>
    </>,
    session,
    t("invoices.new_title"),
    flash,
  );

/** The preview step: the template the operator edits, the invoice it makes for
 *  this booking, and whether the site will email it. */
export const adminInvoicePreviewPage = ({
  attendeeEmail,
  attendeeId,
  attendeeName,
  delivered,
  number,
  previewHtml,
  session,
  template,
}: {
  attendeeEmail: string;
  attendeeId: number;
  attendeeName: string;
  delivered: boolean;
  number: number;
  previewHtml: string;
  session: AuthSession;
  template: string;
}): string =>
  invoiceFormPage(
    adminPath("invoiceNew", {}),
    <>
      <DetailTable rows={whoRows(number, attendeeName, attendeeEmail)} />
      <p class="prose">
        {delivered
          ? t("invoices.preview.will_email", { email: attendeeEmail })
          : t("invoices.preview.no_email")}
      </p>
      <div class="prose">
        <h2>{t("invoices.preview.rendered_heading")}</h2>
      </div>
      <div class="prose email-preview">
        <Raw html={previewHtml} />
      </div>
      <input name="attendee_id" type="hidden" value={attendeeId} />
      <input name="number" type="hidden" value={number} />
      <label>
        {t("invoices.preview.body_label")}
        <textarea maxlength={MAX_TEXTAREA_LENGTH} name="body">
          {textareaBody(template)}
        </textarea>
      </label>
      <p class="small">{t("invoices.preview.body_hint")}</p>
      <p class="form-actions">
        <button
          class="secondary"
          formaction={adminPath("invoicePreview", {})}
          type="submit"
        >
          {t("invoices.action.update_preview")}
        </button>
        <SubmitButton icon="save">{t("invoices.action.create")}</SubmitButton>
      </p>
    </>,
    session,
    t("invoices.preview.title", { number }),
  );

/** One invoice: its details, its share link, its actions, and the frozen body. */
export const adminInvoicePage = ({
  attendeeEmail,
  attendeeName,
  bodyHtml,
  flash,
  invoice,
  session,
  shareUrl,
}: {
  attendeeEmail: string;
  attendeeName: string;
  bodyHtml: string;
  flash: FlashFields;
  invoice: InvoiceRow;
  session: AuthSession;
  shareUrl: string;
}): string =>
  renderAdminPageSpec({
    active: "/admin/invoices",
    body: (
      <>
        <DetailTable
          rows={[
            ...whoRows(invoice.id, attendeeName, attendeeEmail),
            {
              key: t("invoices.column.created"),
              value: formatDateLabel(invoice.created.slice(0, 10)),
            },
            {
              key: t("invoices.column.status"),
              value: t(INVOICE_STATUS_LABEL_KEYS[invoice.status]),
            },
          ]}
        >
          <LabelledRow label={t("invoices.share_link")}>
            <input data-select-on-click readOnly type="text" value={shareUrl} />
            <p class="small">{t("invoices.detail.share_hint")}</p>
          </LabelledRow>
        </DetailTable>
        <p class="actions">
          {invoice.status === "new" ? (
            <SaveForm
              action={adminPath("invoiceCancel", { id: invoice.id })}
              submitIcon="x"
              submitLabel={t("invoices.action.cancel")}
            />
          ) : null}
          <SaveForm
            action={adminPath("invoiceDelete", { id: invoice.id })}
            submitClass="danger"
            submitIcon="trash-2"
            submitLabel={t("invoices.action.delete")}
          />
        </p>
        <h2>{t("invoices.detail.body_heading")}</h2>
        <Raw html={bodyHtml} />
      </>
    ),
    flash,
    session,
    title: t("invoices.detail.title", { number: invoice.id }),
  });
