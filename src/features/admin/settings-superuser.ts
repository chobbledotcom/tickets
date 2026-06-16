/**
 * Admin superuser settings route - POST /admin/settings/superuser.
 * Lets the owner decline recovery (self-managed) or enable a recovery
 * superuser, generating credentials and emailing them. Owner-only access
 * enforced via settingsRoute.
 */

import { settingsRoute } from "#routes/admin/settings-helpers.ts";
import { unwrapKeyWithToken } from "#shared/crypto/keys.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import { deleteUser } from "#shared/db/users.ts";
import { getEmailConfig, getHostEmailConfig } from "#shared/email.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { ok } from "#shared/response.ts";
import {
  createActivatedSuperuser,
  generateSuperuserPassword,
  getSuperuserState,
  sendSuperuserCredentialsEmail,
} from "#shared/superuser.ts";

/** Roll back a created superuser after email failure and return error page */
const rollbackSuperuser = async (
  userId: number,
  errorPage: (
    msg: string,
    status: number,
    id: string,
  ) => Response | Promise<Response>,
): Promise<Response> => {
  try {
    await deleteUser(userId);
  } catch (deleteErr) {
    const detail =
      deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
    logError({
      code: ErrorCode.DB_QUERY,
      detail: `Failed to delete superuser after email failure: ${detail}`,
    });
  }
  return errorPage(
    "Failed to send superuser credentials email. The user has not been created.",
    502,
    "settings-superuser",
  );
};

/**
 * Handle POST /admin/settings/superuser - owner only
 */
export const handleSuperuserPost = settingsRoute(
  async (form, errorPage, session) => {
    const superuser = await getSuperuserState();
    if (!superuser.available) {
      return errorPage("Superuser is not available", 400, "settings-superuser");
    }

    const choice = form.getString("superuser_choice");

    if (choice !== "self-managed" && choice !== "enable-superuser") {
      return errorPage("Invalid choice", 400, "settings-superuser");
    }

    if (superuser.userExists) {
      const existingUserMessage = superuser.activated
        ? `Superuser ${superuser.username} is already activated. You can delete them from your users page.`
        : `Username ${superuser.username} already exists. You can delete them from your users page before enabling a superuser.`;
      return errorPage(existingUserMessage, 400, "settings-superuser");
    }

    if (choice === "self-managed") {
      await settings.update.superuserChoice("self-managed");
      await logActivity("Superuser recovery declined");
      return ok("/admin/settings", "Superuser recovery declined", {
        formId: "settings-superuser",
      });
    }

    // Confirm email config
    const config = (await getEmailConfig()) ?? getHostEmailConfig();
    if (!config) {
      return errorPage(
        "Email must be configured before enabling a superuser",
        400,
        "settings-superuser",
      );
    }

    if (!session.wrappedDataKey) {
      return errorPage(
        "Cannot enable superuser: session lacks data key",
        500,
        "settings-superuser",
      );
    }

    const dataKey = await unwrapKeyWithToken(
      session.wrappedDataKey,
      session.token,
    );
    const password = generateSuperuserPassword(12);
    const user = await createActivatedSuperuser({
      dataKey,
      password,
      username: superuser.username,
    });

    const emailOk = await sendSuperuserCredentialsEmail(config, {
      email: superuser.email,
      password,
      username: superuser.username,
    });

    if (!emailOk) {
      return rollbackSuperuser(user.id, errorPage);
    }

    await settings.update.superuserChoice("enabled");
    await logActivity(`Superuser '${superuser.username}' enabled`);
    return ok("/admin/settings", "Superuser enabled and credentials sent", {
      formId: "settings-superuser",
    });
  },
);
