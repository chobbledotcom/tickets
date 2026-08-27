/**
 * The site builder form. It lives beside the other admin field definitions,
 * so the page template and the building route share one definition without
 * either importing the other.
 */

import { t } from "#i18n";
import { defineForm } from "#shared/forms/definition.ts";
import {
  builtSiteBox,
  denoDeployOption,
  providerChoices,
} from "#templates/fields/admin.ts";

export const builderForm = defineForm({
  fields: [
    {
      ...builtSiteBox("site_name", "name", "text" as const),
      maxlength: 64,
      minlength: 1,
      required: true,
    },
    ...providerChoices({
      db: [
        {
          label: t("fields.built_site.provider.bunny_db_auto"),
          value: "bunny",
        },
        { label: t("fields.built_site.provider.turso_auto"), value: "turso" },
        { label: t("fields.built_site.provider.manual_db"), value: "manual" },
      ],
      hosting: [
        { label: t("fields.built_site.provider.bunny_edge"), value: "bunny" },
        denoDeployOption(),
      ],
    }),
    {
      ...builtSiteBox("db_url", "db_url", "url" as const),
      hint: t("fields.built_site.auto_provision_hint"),
    },
    {
      ...builtSiteBox("db_token", "db_token", "password" as const),
      hint: t("fields.built_site.auto_provision_hint"),
    },
  ] as const,
});
