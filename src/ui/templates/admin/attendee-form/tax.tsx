import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import type { TaxSavePreview } from "#shared/tax/save.ts";

const previewColumns = [
  "attendee_form.tax_figure",
  "attendee_form.tax_before",
  "attendee_form.tax_after",
];

const previewRows = (preview: TaxSavePreview) => [
  {
    after: preview.afterTax,
    before: preview.beforeTax,
    label: "attendee_form.tax_amount",
  },
  {
    after: preview.afterBalance,
    before: preview.beforeBalance,
    label: "attendee_form.tax_balance",
  },
];

export const TaxSaveFields = ({
  preview,
}: {
  preview: TaxSavePreview;
}): JSX.Element => (
  <>
    <input name="tax_preview" type="hidden" value={preview.token} />
    <p>
      {t(
        preview.changed
          ? "attendee_form.tax_save_reason"
          : "attendee_form.tax_unchanged",
      )}
    </p>
    <table>
      <thead>
        <tr>
          {previewColumns.map((column) => (
            <th>{t(column)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {previewRows(preview).map((row) => (
          <tr>
            <th>{t(row.label)}</th>
            <td>{formatCurrency(row.before)}</td>
            <td>{formatCurrency(row.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p>{t("attendee_form.tax_no_payment")}</p>
  </>
);
