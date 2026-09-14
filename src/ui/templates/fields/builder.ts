/** Site builder form fields. */

/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import { defineForm } from "#shared/forms/definition.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
/* jscpd:ignore-end */
import {
  builtSiteBox,
  denoDeployOption,
  providerChoices,
} from "#templates/fields/admin.ts";

export const builderForm = defineForm({
  fields: [
    {
      ...builtSiteBox("site_name", "name", "text" as const),
      maxlength: MAX_INPUT_LENGTH,
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
      // A libsql auth token is a pasted machine credential, like the wallet
      // PEM keys: a real one runs past the single-line cap.
      maxlength: MAX_TEXTAREA_LENGTH,
    },
  ] as const,
});
