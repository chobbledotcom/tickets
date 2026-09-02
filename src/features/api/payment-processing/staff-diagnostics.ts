/** The owner's side of a payment failure: facts about the refused checkout,
 * rendered on the failure page for a logged-in owner only. Everyone else —
 * buyers above all — gets the page unchanged. */

import { t } from "#i18n";
import { getAuthenticatedSession } from "#routes/auth.ts";
import type { StaffDiagnostics } from "#routes/payment-response.ts";

/** Facts a failure branch knows about the checkout it refused. */
export interface StaffPaymentFacts {
  provider?: string;
  sessionId?: string;
  status?: string;
}

/** Build the diagnostics panel for a payment failure page, or undefined when
 * nobody who can read it is logged in. */
export const staffPaymentDiagnostics = async (
  request: Request | undefined,
  facts: StaffPaymentFacts,
): Promise<StaffDiagnostics | undefined> => {
  if (request === undefined) return;
  const session = await getAuthenticatedSession(request);
  if (session?.adminLevel !== "owner") return;
  const known = [
    { key: "payment.staff.provider", value: facts.provider },
    { key: "payment.staff.session", value: facts.sessionId },
    { key: "payment.staff.status", value: facts.status },
  ].filter((row) => row.value !== undefined);
  return {
    reasons: [
      t("payment.staff.reason_abandoned"),
      t("payment.staff.reason_delay"),
      t("payment.staff.reason_webhook"),
      t("payment.staff.reason_account"),
    ],
    rows: known.map((row) => ({ label: t(row.key), value: row.value! })),
  };
};
