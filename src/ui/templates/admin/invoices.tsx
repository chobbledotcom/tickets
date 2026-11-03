/** Admin invoice pages: the list, the create form, and one invoice. */

/* jscpd:ignore-start */
import type { InvoiceRow, InvoiceSummary } from "#db/invoices.ts";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import type { AuthSession } from "#routes/auth.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import type { FlashFields } from "#shared/flash-fields.ts";
import {
  INVOICE_STATUS_LABEL_KEYS,
  type InvoiceStatus,
} from "#shared/invoices/status.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
import { ActionButton, SubmitButton } from "#templates/components/actions.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { LabelledRow } from "#templates/components/labelled-row.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import {
  dateLabelColumn,
  translatedTableColumn,
} from "#templates/components/translated-table-column.ts";
import { getInvoiceForm } from "#templates/fields/invoice.ts";

/* jscpd:ignore-end */

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
  translatedTableColumn("status", "invoices.column.status", (row) =>
    t(INVOICE_STATUS_LABEL_KEYS[row.status]),
  ),
]);

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
  renderAdminPageSpec({
    active: "/admin/invoices/new",
    form: {
      action: adminPath("invoiceNew", {}),
      fields: (
        <>
          <Raw
            html={getInvoiceForm().render({
              attendee_id: attendeeId === null ? "" : attendeeId,
              number: nextNumber,
            })}
          />
          <SubmitButton icon="save">{t("invoices.action.create")}</SubmitButton>
        </>
      ),
      flash,
    },
    session,
    title: t("invoices.new_title"),
  });

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
            { key: t("invoices.column.number"), value: invoice.id },
            {
              key: t("invoices.column.attendee"),
              value: `${attendeeName} (${attendeeEmail})`,
            },
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
