/* jscpd:ignore-start */
import { logActivity } from "#db/activity-log.ts";
import { parseTaxPolicy } from "#db/settings/tax.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { OWNER_FORM, withAuth } from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { TaxPolicy } from "#shared/tax/types.ts";

/* jscpd:ignore-end */

const formId = "settings-tax";
const destination = "/admin/settings";

type TaxFormResult =
  | { ok: true; policy: TaxPolicy; expected: TaxPolicy }
  | { ok: false; error: string };

export const parseTaxSettingsForm = (form: FormParams): TaxFormResult => {
  const mode = form.getString("tax_mode");
  const storedExpected = form.getString("expected_tax");
  if (
    !storedExpected ||
    !["none", "add_to_total", "calculate_from_total"].includes(mode)
  ) {
    return { error: t("settings.tax_invalid"), ok: false };
  }
  let expected: TaxPolicy;
  try {
    expected = parseTaxPolicy(storedExpected);
  } catch {
    return { error: t("settings.tax_invalid"), ok: false };
  }
  const raw = form.get("tax_rate") ?? "";
  if (mode === "none" && raw === "")
    return { expected, ok: true, policy: { mode: "none" } };
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(raw)) {
    return { error: t("settings.tax_rate_invalid"), ok: false };
  }
  const [whole, fraction = ""] = raw.split(".");
  const rateBasisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(rateBasisPoints)) {
    return { error: t("settings.tax_rate_invalid"), ok: false };
  }
  return {
    expected,
    ok: true,
    policy:
      mode === "none"
        ? { mode: "none" }
        : {
            mode: mode as "add_to_total" | "calculate_from_total",
            rateBasisPoints,
          },
  };
};

export const handleTaxPost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const parsed = parseTaxSettingsForm(form);
    if (!parsed.ok) return errorRedirect(destination, parsed.error, formId);
    if (!(await settings.update.tax(parsed.policy, parsed.expected))) {
      return errorRedirect(destination, t("settings.tax_stale"), formId);
    }
    const message = t("settings.tax_saved");
    await logActivity(message);
    return redirect(destination, message, true, { formId });
  });
