/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import { OWNER_FORM, requireOwnerOr, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import {
  type AdminFeatureDefinition,
  type AdminFeatureKey,
  enabledFeaturesWithUsage,
  featureBySlug,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAdminFeatureUsage } from "#shared/db/admin-features.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { adminFeaturePage } from "#templates/admin/features.tsx";

/* jscpd:ignore-end */

const noFeatureSave = (): Promise<void> => Promise.resolve();

const clearLogisticsDefault = async (): Promise<void> => {
  const defaults = settings.listingDefaults;
  if (defaults.usesLogistics === undefined) return;
  const next = { ...defaults };
  delete next.usesLogistics;
  await settings.update.listingDefaults(next);
  invalidateListingsCache();
};

const afterFeatureSave: Record<
  AdminFeatureKey,
  (enabled: boolean) => Promise<void>
> = {
  apiKeys: noFeatureSave,
  logistics: (enabled) => (enabled ? noFeatureSave() : clearLogisticsDefault()),
  modifiers: noFeatureSave,
  money: noFeatureSave,
  servingEvents: noFeatureSave,
};

const withAdminFeature = (
  slug: string,
  use: (feature: AdminFeatureDefinition) => Promise<Response>,
): Promise<Response> => {
  const feature = featureBySlug(slug);
  return feature ? use(feature) : Promise.resolve(notFoundResponse());
};

export const handleFeatureGet: TypedRouteHandler<
  "GET /admin/features/:slug"
> = (request, { slug }) =>
  requireOwnerOr(request, (session) =>
    withAdminFeature(slug, async (feature) => {
      const usage = await getAdminFeatureUsage();
      const enabled = enabledFeaturesWithUsage(settings.enabledFeatures, usage)[
        feature.key
      ];
      const flash = applyFlash(request);
      return htmlResponse(
        adminFeaturePage({
          enabled,
          error: flash.error,
          feature,
          inUse: usage[feature.key],
          session,
          success: flash.success,
          theme: settings.theme,
        }),
      );
    }),
  );

export const handleFeaturePost: TypedRouteHandler<
  "POST /admin/features/:slug"
> = (request, { slug }) =>
  withAuth(request, OWNER_FORM, (_session, form) =>
    withAdminFeature(slug, async (feature) => {
      const path = `/admin/features/${feature.slug}`;
      const value = form.getString("enabled");
      if (value !== "true" && value !== "false") {
        return errorRedirect(path, t("features.invalid_value"));
      }
      const enabled = value === "true";
      if (!enabled && (await getAdminFeatureUsage())[feature.key]) {
        return errorRedirect(path, t("features.in_use_help"));
      }
      await settings.update.enabledFeatures(
        setFeatureEnabled(settings.enabledFeatures, feature.key, enabled),
      );
      await afterFeatureSave[feature.key](enabled);
      const message = t(
        enabled ? "features.enabled_success" : "features.disabled_success",
        { feature: t(feature.labelKey) },
      );
      await logActivity(message);
      return redirect(path, message, true);
    }),
  );
