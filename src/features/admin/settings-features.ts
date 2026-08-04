/* jscpd:ignore-start -- imports */

import * as v from "valibot";
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
  enabledFeaturesWithUsage,
  featureBySlug,
} from "#shared/admin-features.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import {
  getAdminFeatureUsage,
  setAdminFeatureEnabled,
} from "#shared/db/admin-features.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { adminFeaturePage } from "#templates/admin/features.tsx";

/* jscpd:ignore-end */

const FeatureChoiceSchema = v.picklist(["true", "false"]);

const withAdminFeature = (
  slug: string,
  use: (feature: AdminFeatureDefinition) => Promise<Response>,
): Promise<Response> => {
  const feature = featureBySlug(slug);
  return feature ? use(feature) : Promise.resolve(notFoundResponse());
};

/** Validate and save one feature choice from its detail form. */
const saveFeatureChoice = async (
  feature: AdminFeatureDefinition,
  form: FormParams,
): Promise<Response> => {
  const path = `/admin/features/${feature.slug}`;
  const choice = v.safeParse(FeatureChoiceSchema, form.getString("enabled"));
  if (!choice.success) {
    return errorRedirect(path, t("features.invalid_value"));
  }
  const enabled = choice.output === "true";
  if (!enabled && (await getAdminFeatureUsage())[feature.key]) {
    return errorRedirect(path, t("features.in_use_help"));
  }
  if (!(await setAdminFeatureEnabled(feature.key, enabled))) {
    return errorRedirect(path, t("features.in_use_help"));
  }
  const message = t(
    enabled ? "features.enabled_success" : "features.disabled_success",
    { feature: t(feature.labelKey) },
  );
  await logActivity(message);
  return redirect(path, message, true);
};

export const handleFeatureGet: TypedRouteHandler<
  "GET /admin/features/:slug"
> = (request, { slug }) =>
  requireOwnerOr(request, (session) =>
    withAdminFeature(slug, async (feature) => {
      const usage = await getAdminFeatureUsage();
      const enabled = enabledFeaturesWithUsage(settings.features, usage)[
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
    withAdminFeature(slug, (feature) => saveFeatureChoice(feature, form)),
  );
