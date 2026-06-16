/**
 * Admin domain settings routes - custom domain and host subdomain management
 * Owner-only access enforced via advancedSettingsRoute
 */

import { t } from "#i18n";
import {
  advancedSettingsRoute,
  type ErrorPageFn,
} from "#routes/admin/settings-helpers.ts";
import {
  checkSubdomainAvailable,
  registerBunnySubdomain,
  validateCustomDomain,
} from "#shared/bunny-cdn.ts";
import { isBunnyCdnEnabled, isBunnyDnsEnabled } from "#shared/config.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import { DOMAIN_PATTERN } from "#shared/embed-hosts.ts";
import { fail, ok } from "#shared/response.ts";

/**
 * Run a task guarded by the global current-task lock, returning the task's
 * Response on success or a 409 error page when another task holds the lock.
 */
const runGuardedTask = async (
  taskName: string,
  formId: string,
  errorPage: ErrorPageFn,
  task: () => Promise<Response>,
): Promise<Response> => {
  const taskResult = await settings.withCurrentTask(taskName, task);
  if (!taskResult.ok) {
    return errorPage(taskResult.error, 409, formId);
  }
  return taskResult.value;
};

/** Handle POST /admin/settings/custom-domain - save custom domain */
export const handleCustomDomainPost = advancedSettingsRoute(
  async (form, errorPage) => {
    if (!isBunnyCdnEnabled()) {
      return errorPage(
        t("error.bunny_cdn_not_configured"),
        400,
        "settings-custom-domain",
      );
    }

    const raw = form.getString("custom_domain").toLowerCase();

    if (raw === "") {
      await settings.update.customDomain("");
      await logActivity("Custom domain cleared");
      return ok(
        "/admin/settings-advanced",
        t("success.custom_domain_cleared"),
        {
          formId: "settings-custom-domain",
        },
      );
    }

    // Basic domain validation: must look like a hostname
    if (!DOMAIN_PATTERN.test(raw)) {
      return errorPage(
        t("error.invalid_domain_format"),
        400,
        "settings-custom-domain",
      );
    }

    return runGuardedTask(
      "custom-domain",
      "settings-custom-domain",
      errorPage,
      async () => {
        await settings.update.customDomain(raw);
        await logActivity(`Custom domain set to ${raw}`);

        // Attempt validation immediately after saving
        const result = await validateCustomDomain(raw);
        if (result.ok) {
          await settings.update.customDomainLastValidated();
          await logActivity(`Custom domain validated: ${raw}`);
          return ok(
            "/admin/settings-advanced",
            t("success.custom_domain_saved_validated"),
            {
              formId: "settings-custom-domain",
            },
          );
        }

        return fail(
          "/admin/settings-advanced",
          `Custom domain saved but validation failed: ${result.error}`,
          { formId: "settings-custom-domain" },
        );
      },
    );
  },
);

/** Handle POST /admin/settings/custom-domain/validate - validate with Bunny CDN */
export const handleCustomDomainValidatePost = advancedSettingsRoute(
  (_form, errorPage) => {
    if (!isBunnyCdnEnabled()) {
      return errorPage(
        t("error.bunny_cdn_not_configured"),
        400,
        "settings-custom-domain-validate",
      );
    }

    const customDomain = settings.customDomain;
    if (!customDomain) {
      return errorPage(
        t("error.no_custom_domain"),
        400,
        "settings-custom-domain-validate",
      );
    }

    return runGuardedTask(
      "custom-domain-validate",
      "settings-custom-domain-validate",
      errorPage,
      async () => {
        const result = await validateCustomDomain(customDomain);
        if (!result.ok) {
          return errorPage(
            result.error,
            502,
            "settings-custom-domain-validate",
          );
        }

        await settings.update.customDomainLastValidated();
        await logActivity(`Custom domain validated: ${customDomain}`);
        return ok(
          "/admin/settings-advanced",
          t("success.custom_domain_validated"),
          {
            formId: "settings-custom-domain-validate",
          },
        );
      },
    );
  },
);

/** Valid subdomain pattern: lowercase alphanumeric + hyphens, no leading/trailing hyphen */
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const FORM_ID_HOST_SUBDOMAIN = "settings-host-subdomain";

/** Handle POST /admin/settings/host-subdomain - preview or register subdomain */
export const handleHostSubdomainPost = advancedSettingsRoute(
  async (form, errorPage) => {
    if (!isBunnyDnsEnabled()) {
      return errorPage("Not configured", 400, FORM_ID_HOST_SUBDOMAIN);
    }
    if (settings.bunnySubdomain) {
      return errorPage(
        "Subdomain has already been set and cannot be changed",
        400,
        FORM_ID_HOST_SUBDOMAIN,
      );
    }

    const raw = form.getString("subdomain").toLowerCase().trim();
    if (!raw || !SUBDOMAIN_PATTERN.test(raw)) {
      return errorPage("Invalid subdomain format", 400, FORM_ID_HOST_SUBDOMAIN);
    }

    const save = form.getString("save");

    if (!save) {
      // Preview: check availability only
      const check = await checkSubdomainAvailable(raw);
      if (!check.ok) {
        return errorPage(check.error, 502, FORM_ID_HOST_SUBDOMAIN);
      }
      if (!check.available) {
        return errorPage(
          `Subdomain "${raw}" is already taken`,
          409,
          FORM_ID_HOST_SUBDOMAIN,
        );
      }
      return ok(
        "/admin/settings-advanced",
        `${check.fullDomain} is available`,
        {
          formId: FORM_ID_HOST_SUBDOMAIN,
          result: `${raw}\n${check.fullDomain}`,
        },
      );
    }

    // Save: actually register (guarded by current_task)
    return runGuardedTask(
      "host-subdomain",
      FORM_ID_HOST_SUBDOMAIN,
      errorPage,
      async () => {
        const result = await registerBunnySubdomain(raw);
        if (!result.ok) {
          return errorPage(result.error, 502, FORM_ID_HOST_SUBDOMAIN);
        }

        await settings.update.bunnySubdomain(result.fullDomain);
        await logActivity(`Host subdomain set to ${result.fullDomain}`);
        return ok(
          "/admin/settings-advanced",
          `Subdomain registered: ${result.fullDomain}`,
          {
            formId: FORM_ID_HOST_SUBDOMAIN,
          },
        );
      },
    );
  },
);
