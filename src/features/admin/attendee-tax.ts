import { attendeeAccount } from "#accounting/accounts.ts";
import { writeoffAdjustmentInserts } from "#accounting/adjustments.ts";
import type { AttendeeEditWork } from "#db/attendees/atomic-update.ts";
import { update } from "#db/client.ts";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { nowIso } from "#shared/now.ts";
import type { TaxSavePlan, TaxSavePreview } from "#shared/tax/save.ts";

export const attendeeTaxSaveWork = async (
  attendeeId: number,
  statusId: number | null,
  hasRealLine: boolean,
  plan: TaxSavePlan,
): Promise<AttendeeEditWork> => ({
  after: [
    ...plan.after,
    update("attendees", { status_id: statusId }, { id: attendeeId }),
    ...(!hasRealLine
      ? await writeoffAdjustmentInserts(
          [
            {
              account: attendeeAccount(attendeeId),
              delta: plan.preview.afterBalance,
              keyParts: ["balance-adjust", attendeeId],
            },
          ],
          nowIso(),
        )
      : []),
  ],
  before: plan.before,
});

export const attendeeTaxSavedMessage = (
  name: string,
  preview: TaxSavePreview,
): string =>
  preview.changed
    ? t("attendee_form.saved_tax_updated", {
        afterBalance: formatCurrency(preview.afterBalance),
        afterTax: formatCurrency(preview.afterTax),
        beforeBalance: formatCurrency(preview.beforeBalance),
        beforeTax: formatCurrency(preview.beforeTax),
        value: name,
      })
    : t("attendee_form.saved_updated", { value: name });
