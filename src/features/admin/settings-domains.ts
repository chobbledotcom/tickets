/**
 * Admin domain settings routes - custom domain and host subdomain management
 * Owner-only access enforced via advancedSettingsRoute
 */

/* jscpd:ignore-start -- imports */
import { logActivity } from "#db/activity-log.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  advancedSettingsRoute,
  type ErrorPageFn,
  withSettingsFields,
} from "#routes/admin/settings-helpers.ts";
/* jscpd:ignore-end */
import {
  checkSubdomainAvailable,
  registerBunnySubdomain,
  validateCustomDomain,
} from "#shared/bunny-cdn.ts";
import { isBunnyCdnEnabled, isBunnyDnsEnabled } from "#shared/config.ts";
import { DOMAIN_PATTERN } from "#shared/embed-hosts.ts";
import { existingPaymentProviderState } from "#shared/existing-payment-provider.ts";
import type { FormParams } from "#shared/form-data.ts";
import { fail, ok } from "#shared/response.ts";

const orErrorPage = <S extends { ok: true }, R>(
  result: S | { ok: false; error: string },
  errorPage: ErrorPageFn,
  formId: string,
  onOk: (ok: S) => R | Promise<R>,
): ReturnType<ErrorPageFn> | R | Promise<R> =>
  result.ok ? onOk(result) : errorPage(result.error, formId);

const requireSetting =
  (ready: () => boolean, errorKey: string) =>
  (errorPage: ErrorPageFn, formId: string): ReturnType<ErrorPageFn> | null =>
    ready() ? null : errorPage(t(errorKey), formId);

const requireBunnyCdn = requireSetting(
  isBunnyCdnEnabled,
  "error.bunny_cdn_not_configured",
);
const requireRecovery = requireSetting(
  () => existingPaymentProviderState().recoveryChoices.length === 0,
  "error.payment_provider_recovery_required",
);
/** Run a domain command while no other settings task is active. Every domain
 * command waits for the owner to settle existing payments first, because any
 * of them can move the domain the payment webhook points at. */
const runGuardedTask = async (
  taskName: string,
  formId: string,
  errorPage: ErrorPageFn,
  expectedVersion: number | null,
  task: () => Promise<Response>,
): Promise<Response> => {
  const run = () =>
    Promise.resolve(requireRecovery(errorPage, formId) ?? task());
  const result = await settings.withCurrentTask(taskName, run, expectedVersion);
  return orErrorPage(result, errorPage, formId, (ok) => ok.value);
};

/** Run one Bunny API call as a domain task: hold the task lock, wait for any
 * payment-provider recovery, then report the call's failure on this form. */
const runBunnyDomainTask = <T extends { ok: true }>(
  taskName: string,
  formId: string,
  errorPage: ErrorPageFn,
  form: FormParams,
  call: () => Promise<T | { ok: false; error: string }>,
  onOk: (value: T) => Promise<Response>,
): Promise<Response> =>
  runGuardedTask(
    taskName,
    formId,
    errorPage,
    form.getOptionalInt("settings_version"),
    async () => orErrorPage(await call(), errorPage, formId, onOk),
  );

/** Handle POST /admin/settings/custom-domain - save custom domain */
export const handleCustomDomainPost = advancedSettingsRoute(
  withSettingsFields("settings-custom-domain", async (form, errorPage) => {
    const cdnError = requireBunnyCdn(errorPage, "settings-custom-domain");
    if (cdnError) return cdnError;
    const raw = form.getString("custom_domain").toLowerCase();

    if (raw !== "" && !DOMAIN_PATTERN.test(raw)) {
      return errorPage(
        t("error.invalid_domain_format"),
        "settings-custom-domain",
      );
    }

    return runGuardedTask(
      "custom-domain",
      "settings-custom-domain",
      errorPage,
      form.getOptionalInt("settings_version"),
      async () => {
        if (raw === "") {
          await settings.update.customDomain("");
          await logActivity("Custom domain cleared");
          return ok(
            "/admin/settings-advanced",
            t("success.custom_domain_cleared"),
            { formId: "settings-custom-domain" },
          );
        }
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
          t("settings.advanced.custom_domain_saved_unvalidated", {
            error: result.error,
          }),
          { formId: "settings-custom-domain" },
        );
      },
    );
  }),
);

/** Handle POST /admin/settings/custom-domain/validate - validate with Bunny CDN */
export const handleCustomDomainValidatePost = advancedSettingsRoute(
  (form, errorPage) => {
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

    return runBunnyDomainTask(
      "custom-domain-validate",
      "settings-custom-domain-validate",
      errorPage,
      form,
      () => validateCustomDomain(customDomain),
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

/** Valid subdomain pattern: lowercase alphanumeric + hyphens, no leading/trailing hyphen */
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const FORM_ID_HOST_SUBDOMAIN = "settings-host-subdomain";

/** Handle POST /admin/settings/host-subdomain - preview or register subdomain */
export const handleHostSubdomainPost = advancedSettingsRoute(
  withSettingsFields("settings-host-subdomain", async (form, errorPage) => {
    if (!isBunnyDnsEnabled()) {
      return errorPage(
        t("settings.subdomain.flash.not_configured"),
        FORM_ID_HOST_SUBDOMAIN,
      );
    }
    if (settings.bunnySubdomain) {
      return errorPage(
        t("settings.subdomain.flash.already_set"),
        FORM_ID_HOST_SUBDOMAIN,
      );
    }

    const raw = form.getString("subdomain").toLowerCase().trim();
    if (!raw || !SUBDOMAIN_PATTERN.test(raw)) {
      return errorPage(
        t("settings.subdomain.flash.invalid"),
        FORM_ID_HOST_SUBDOMAIN,
      );
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
          t("settings.subdomain.flash.taken", { name: raw }),
          FORM_ID_HOST_SUBDOMAIN,
        );
      }
      return ok(
        "/admin/settings-advanced",
        t("settings.subdomain.flash.available", { domain: check.fullDomain }),
        {
          formId: FORM_ID_HOST_SUBDOMAIN,
          result: `${raw}\n${check.fullDomain}`,
        },
      );
    }

    return runBunnyDomainTask(
      "host-subdomain",
      FORM_ID_HOST_SUBDOMAIN,
      errorPage,
      form,
      () => registerBunnySubdomain(raw),
      async (ok_) => {
        await settings.update.bunnySubdomain(ok_.fullDomain);
        await logActivity(`Host subdomain set to ${ok_.fullDomain}`);
        return ok(
          "/admin/settings-advanced",
          t("settings.subdomain.flash.registered", {
            domain: ok_.fullDomain,
          }),
          {
            formId: FORM_ID_HOST_SUBDOMAIN,
          },
        );
      },
    );
  }),
);
