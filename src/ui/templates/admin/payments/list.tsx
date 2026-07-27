import { t } from "#i18n";
import { adminPath } from "#shared/admin-surface.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import type { PaymentCase } from "#shared/db/payments/types.ts";
import type { AdminSession } from "#shared/types.ts";
import { successAdminPage } from "#templates/admin/admin-page.tsx";
import {
  paymentCaseProvider,
  paymentCaseReason,
} from "#templates/admin/payments/format.tsx";
import { WritableLink } from "#templates/admin/writable-only.tsx";
import { dataTable } from "#templates/components/data-table.tsx";

const statusLabel = (paymentCase: PaymentCase): string =>
  t(`admin.payments.status.${paymentCase.state}`);

export const adminPaymentsPage = (
  cases: PaymentCase[],
  session: AdminSession,
  success?: string,
): string =>
  successAdminPage(t("admin.payments.title"), "/admin/payments")(
    session,
    success,
  )(
    <>
      <h1>{t("admin.payments.title")}</h1>
      <p>{t("admin.payments.intro")}</p>
      {dataTable<PaymentCase>([
        {
          cell: (paymentCase) =>
            paymentCase.state === "needs_action" ? (
              <WritableLink
                href={adminPath("paymentCase", { caseId: paymentCase.id })}
              >
                {t("admin.payments.case", { id: paymentCase.id })}
              </WritableLink>
            ) : (
              t("admin.payments.case", { id: paymentCase.id })
            ),
          header: t("admin.payments.col.case"),
        },
        {
          cell: paymentCaseProvider,
          header: t("admin.payments.col.provider"),
        },
        {
          cell: (paymentCase) => paymentCaseReason(paymentCase.reason),
          header: t("admin.payments.col.reason"),
        },
        {
          cell: statusLabel,
          header: t("common.status"),
        },
        {
          cell: (paymentCase) =>
            formatDatetimeShort(
              new Date(paymentCase.lastObservedAt).toISOString(),
            ),
          header: t("admin.payments.col.updated"),
        },
      ])(cases, { empty: t("admin.payments.empty") })}
    </>,
  );
