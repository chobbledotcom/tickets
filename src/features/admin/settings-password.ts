/**
 * Admin password settings route - POST /admin/settings (change password).
 * Owner-only access enforced via settingsRoute.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import { settingsRoute } from "#routes/admin/settings-helpers.ts";
import { clearSessionCookie } from "#shared/cookies.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import { requireUserById, verifyUserPassword } from "#shared/db/users.ts";
import type { FormParams } from "#shared/form-data.ts";
import { ok } from "#shared/response.ts";
import { getChangePasswordForm } from "#templates/fields/admin.ts";

// jscpd:ignore-end

/**
 * Validate change password form data
 */
type ChangePasswordValidation =
  | { valid: true; currentPassword: string; newPassword: string }
  | { valid: false; error: string };

const validateChangePasswordForm = (
  form: FormParams,
): ChangePasswordValidation => {
  const validation = getChangePasswordForm().validate(form);
  if (!validation.valid) {
    return validation;
  }

  const { current_password, new_password, new_password_confirm } =
    validation.values;

  if (new_password.length < 8) {
    return {
      error: t("error.new_password_min"),
      valid: false,
    };
  }
  if (new_password !== new_password_confirm) {
    return { error: t("error.new_passwords_mismatch"), valid: false };
  }

  return {
    currentPassword: current_password,
    newPassword: new_password,
    valid: true,
  };
};

/**
 * Handle POST /admin/settings - change password (owner only)
 */
export const handleAdminSettingsPost = settingsRoute(
  async (form, errorPage, session) => {
    const validation = validateChangePasswordForm(form);
    if (!validation.valid) {
      return errorPage(validation.error, "settings-password");
    }

    // Load current user (guaranteed to exist since session was just validated)
    const user = await requireUserById(session.userId);

    const passwordHash = await verifyUserPassword(
      user,
      validation.currentPassword,
    );
    if (!passwordHash) {
      return errorPage(
        t("error.current_password_incorrect"),
        "settings-password",
      );
    }

    const success = await settings.updateUserPassword(session.userId, {
      newPassword: validation.newPassword,
      oldKekVersion: user.kek_version,
      oldPassword: validation.currentPassword,
      oldPasswordHash: passwordHash,
      oldWrappedDataKey: user.wrapped_data_key!,
    });
    if (!success) {
      return errorPage(t("error.password_update_failed"), "settings-password");
    }

    await logActivity("Password changed");
    return ok("/admin", t("success.password_changed"), {
      cookie: clearSessionCookie(),
    });
  },
);
