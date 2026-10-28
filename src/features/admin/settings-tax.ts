/* jscpd:ignore-start */
import { logActivity } from "#db/activity-log.ts";
import { parseTaxPolicy } from "#db/settings/tax.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { formPost, OWNER_FORM } from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { TaxPolicy } from "#shared/tax/types.ts";

/* jscpd:ignore-end */

const formId = "settings-tax";
const destination = "/admin/settings";

type TaxFormResult =
  | { ok: true; policy: TaxPolicy; expected: TaxPolicy }
  | { ok: false; error: string };

/** Reads the posted rate into basis points: "12" or "12.5" or "12.50". The
 * settings page shows one error for every bad rate, so the parser carries no
 * message of its own. */
const parseTaxRate = (
  raw: string,
): { ok: true; rateBasisPoints: number } | { ok: false } => {
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(raw)) return { ok: false };
  const [whole, fraction = ""] = raw.split(".");
  const rateBasisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(rateBasisPoints)) return { ok: false };
  return { ok: true, rateBasisPoints };
};

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
  const rate = parseTaxRate(raw);
  if (!rate.ok) return { error: t("settings.tax_rate_invalid"), ok: false };
  return {
    expected,
    ok: true,
    policy:
      mode === "none"
        ? { mode: "none" }
        : {
            mode: mode as "add_to_total" | "calculate_from_total",
            rateBasisPoints: rate.rateBasisPoints,
          },
  };
};

export const handleTaxPost = formPost(OWNER_FORM)(async (form) => {
  const parsed = parseTaxSettingsForm(form);
  if (!parsed.ok) return errorRedirect(destination, parsed.error, formId);
  if (!(await settings.update.tax(parsed.policy, parsed.expected))) {
    return errorRedirect(destination, t("settings.tax_stale"), formId);
  }
  const message = t("settings.tax_saved");
  await logActivity(message);
  return redirect(destination, message, true, { formId });
});
