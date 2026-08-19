import { t } from "#i18n";
/* jscpd:ignore-start -- imports */
import { escapeHtml } from "#jsx/escape-html.ts";
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import type { SuperuserState } from "#shared/superuser.ts";
/* jscpd:ignore-end */
import { SaveButton } from "#templates/components/actions.tsx";
import type { SuperuserChoice } from "#types";

/** A radio-label option for the superuser choice. `checkedValue` is the
 *  SuperuserChoice that should mark this option checked — note the radio's
 *  submitted value ("enable-superuser") differs from the stored choice
 *  ("enabled"), so they're passed separately. */
const superuserChoiceOption = (
  choice: SuperuserChoice,
  checkedValue: SuperuserChoice,
  value: string,
  label: Child,
): JSX.Element => (
  <label class="radio-label">
    <input
      checked={choice === checkedValue}
      name="superuser_choice"
      required
      type="radio"
      value={value}
    />
    <span>{label}</span>
  </label>
);

export const SuperuserForm = (s: {
  superuser: SuperuserState;
}): JSX.Element | null => {
  const { superuser } = s;
  if (!superuser.available) {
    return null;
  }

  const disabled = superuser.activated;

  return (
    <CsrfForm action="/admin/settings/superuser" id="settings-superuser">
      <h2>{t("settings.superuser.heading")}</h2>

      {disabled ? (
        <p>
          <Raw
            html={t("settings.superuser.activated", {
              username: escapeHtml(superuser.username),
            })}
          />
        </p>
      ) : (
        <>
          <p>{t("settings.superuser.intro")}</p>
          {superuserChoiceOption(
            superuser.choice,
            "self-managed",
            "self-managed",
            t("settings.superuser.self_managed"),
          )}
          {superuserChoiceOption(
            superuser.choice,
            "enabled",
            "enable-superuser",
            t("settings.superuser.enable_super", { email: superuser.email }),
          )}
          {SaveButton()}
        </>
      )}
    </CsrfForm>
  );
};
