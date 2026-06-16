import { t } from "#i18n";
import { CsrfForm } from "#shared/forms.tsx";
import { escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { SuperuserState } from "#shared/superuser.ts";
import { SubmitButton } from "#templates/components/actions.tsx";

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
          <label class="radio-label">
            <input
              checked={superuser.choice === "self-managed"}
              disabled={disabled}
              name="superuser_choice"
              required
              type="radio"
              value="self-managed"
            />
            <span>{t("settings.superuser.self_managed")}</span>
          </label>

          <label class="radio-label">
            <input
              checked={superuser.choice === "enabled"}
              disabled={disabled}
              name="superuser_choice"
              required
              type="radio"
              value="enable-superuser"
            />
            <span>
              {t("settings.superuser.enable_super", { email: superuser.email })}
            </span>
          </label>

          <SubmitButton icon="save">{t("common.save")}</SubmitButton>
        </>
      )}
    </CsrfForm>
  );
};
