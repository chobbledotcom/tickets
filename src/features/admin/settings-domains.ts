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
import { existingPaymentProviderState } from "#shared/existing-payment-provider.ts";
import { fail, ok } from "#shared/response.ts";

/**
 * Given a result that either succeeded or failed with an `error` string, show
 * the failure on `formId`, or hand the successful result to `onOk`. Every
 * domain step here follows this shape:
 * check `.ok`, show the error on the form, otherwise carry on.
 */
const orErrorPage = <S extends { ok: true }, R>(
  result: S | { ok: false; error: string },
  errorPage: ErrorPageFn,
  formId: string,
  onOk: (ok: S) => R | Promise<R>,
): ReturnType<ErrorPageFn> | R | Promise<R> =>
  result.ok ? onOk(result) : errorPage(result.error, formId);

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
  return orErrorPage(taskResult, errorPage, formId, (ok) => ok.value);
};

const requireSetting =
  (ready: () => boolean, errorKey: string) =>
  (errorPage: ErrorPageFn, formId: string): ReturnType<ErrorPageFn> | null =>
    ready() ? null : errorPage(t(errorKey), formId);

const requireBunnyCdn = requireSetting(
  isBunnyCdnEnabled,
  "error.bunny_cdn_not_configured",
);
const requirePaymentProviderRecovery = requireSetting(
  () => existingPaymentProviderState().recoveryChoices.length === 0,
  "error.payment_provider_recovery_required",
);

/** Handle POST /admin/settings/custom-domain - save custom domain */
export const handleCustomDomainPost = advancedSettingsRoute(
  async (form, errorPage) => {
    const cdnError = requireBunnyCdn(errorPage, "settings-custom-domain");
    if (cdnError) return cdnError;
    const recoveryError = requirePaymentProviderRecovery(
      errorPage,
      "settings-custom-domain",
    );
    if (recoveryError) return recoveryError;

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
    const cdnError = requireBunnyCdn(
      errorPage,
      "settings-custom-domain-validate",
    );
    if (cdnError) return cdnError;

    const customDomain = settings.customDomain;
    if (!customDomain) {
      return errorPage(
        t("error.no_custom_domain"),
        "settings-custom-domain-validate",
      );
    }

    return runGuardedTask(
      "custom-domain-validate",
      "settings-custom-domain-validate",
      errorPage,
      async () => {
        const result = await validateCustomDomain(customDomain);
        return orErrorPage(
          result,
          errorPage,
          "settings-custom-domain-validate",
          async () => {
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
  },
);

/** Valid subdomain pattern: lowercase alphanumeric + hyphens, no leading/trailing hyphen */
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const FORM_ID_HOST_SUBDOMAIN = "settings-host-subdomain";

/** Handle POST /admin/settings/host-subdomain - preview or register subdomain */
export const handleHostSubdomainPost = advancedSettingsRoute(
  async (form, errorPage) => {
    if (!isBunnyDnsEnabled()) {
      return errorPage("Not configured", FORM_ID_HOST_SUBDOMAIN);
    }
    if (settings.bunnySubdomain) {
      return errorPage(
        "Subdomain has already been set and cannot be changed",
        FORM_ID_HOST_SUBDOMAIN,
      );
    }

    const raw = form.getString("subdomain").toLowerCase().trim();
    if (!raw || !SUBDOMAIN_PATTERN.test(raw)) {
      return errorPage("Invalid subdomain format", FORM_ID_HOST_SUBDOMAIN);
    }

    const save = form.getString("save");

    if (!save) {
      // Preview: check availability only
      const check = await checkSubdomainAvailable(raw);
      if (!check.ok) {
        return errorPage(check.error, FORM_ID_HOST_SUBDOMAIN);
      }
      if (!check.available) {
        return errorPage(
          `Subdomain "${raw}" is already taken`,
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

    const recoveryError = requirePaymentProviderRecovery(
      errorPage,
      FORM_ID_HOST_SUBDOMAIN,
    );
    if (recoveryError) return recoveryError;

    // Save: actually register (guarded by current_task)
    return runGuardedTask(
      "host-subdomain",
      FORM_ID_HOST_SUBDOMAIN,
      errorPage,
      async () => {
        const result = await registerBunnySubdomain(raw);
        return orErrorPage(
          result,
          errorPage,
          FORM_ID_HOST_SUBDOMAIN,
          async (ok_) => {
            await settings.update.bunnySubdomain(ok_.fullDomain);
            await logActivity(`Host subdomain set to ${ok_.fullDomain}`);
            return ok(
              "/admin/settings-advanced",
              `Subdomain registered: ${ok_.fullDomain}`,
              {
                formId: FORM_ID_HOST_SUBDOMAIN,
              },
            );
          },
        );
      },
    );
  },
);
