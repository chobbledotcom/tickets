/**
 * Admin/operator form fields — login, setup, password change, payment-provider
 * keys, invite user, holidays, and built-site management. Each is a per-request
 * builder because every label/hint flows through the i18n layer.
 */

import { t } from "#i18n";
import type { Field } from "#shared/forms.tsx";
import { AdminLevelSchema } from "#shared/types.ts";
import { picklistOptions } from "#templates/fields/picklist-options.ts";
import {
  getUsernameFieldBase,
  validateDate,
  validateHttpsDomainUrl,
  validateUpdateTier,
  validateUsername,
} from "#templates/fields/validators.ts";

/**
 * Login form field definitions (per-request builder)
 */
export const getLoginFields = (): Field[] => [
  { ...getUsernameFieldBase(), autocomplete: "username" },
  {
    autocomplete: "current-password",
    label: t("fields.login.password"),
    name: "password",
    required: true,
    type: "password",
  },
];

/**
 * Holiday form field definitions (per-request builder)
 */
export const getHolidayFields = (): Field[] => [
  {
    label: t("fields.holiday.name"),
    name: "name",
    placeholder: t("fields.holiday.name_placeholder"),
    required: true,
    type: "text",
  },
  {
    label: t("fields.holiday.start_date"),
    name: "start_date",
    required: true,
    type: "date",
    validate: validateDate,
  },
  {
    hint: t("fields.holiday.end_date_hint"),
    label: t("fields.holiday.end_date"),
    name: "end_date",
    required: true,
    type: "date",
    validate: validateDate,
  },
];

/**
 * Built site form field definitions (per-request builder)
 */
export const getBuiltSiteFields = (): Field[] => [
  {
    label: t("fields.built_site.name"),
    name: "name",
    placeholder: t("fields.built_site.name_placeholder"),
    required: true,
    type: "text",
  },
  {
    label: t("fields.built_site.site_url"),
    name: "site_url",
    placeholder: t("fields.built_site.site_url_placeholder"),
    required: true,
    type: "url",
    validate: validateHttpsDomainUrl,
  },
  {
    label: t("fields.built_site.db_url"),
    name: "db_url",
    placeholder: t("fields.built_site.db_url_placeholder"),
    type: "url",
  },
  {
    label: t("fields.built_site.db_token"),
    name: "db_token",
    placeholder: t("fields.built_site.db_token_placeholder"),
    type: "password",
  },
  {
    label: t("fields.built_site.hosting_id"),
    name: "hosting_id",
    placeholder: t("fields.built_site.hosting_id_placeholder"),
    type: "text",
  },
  {
    label: t("fields.built_site.hosting_provider"),
    name: "hosting_provider",
    options: [
      { label: "Bunny", value: "bunny" },
      { label: "Deno Deploy", value: "deno" },
    ],
    type: "select",
  },
  {
    label: t("fields.built_site.db_provider"),
    name: "db_provider",
    options: [
      { label: "Bunny DB", value: "bunny" },
      { label: "Turso", value: "turso" },
    ],
    type: "select",
  },
  {
    hint: t("fields.built_site.assignable_hint"),
    label: t("fields.built_site.assignable"),
    name: "assignable",
    options: [{ label: t("fields.built_site.assignable_label"), value: "1" }],
    type: "checkbox-group",
  },
  {
    hint: t("fields.built_site.updates_hint"),
    label: t("fields.built_site.updates"),
    name: "updates",
    // Ordered safest-first so release heads the dropdown (the create form
    // pre-selects it and the table layer defaults to it). No `defaultValue`: it
    // would make validation fill an OMITTED field with the default, which on an
    // edit silently overwrites an existing channel — the route only carries a
    // recognised value so an absent field preserves the stored channel instead.
    options: [
      { label: t("fields.built_site.updates_release"), value: "release" },
      { label: t("fields.built_site.updates_beta"), value: "beta" },
      { label: t("fields.built_site.updates_alpha"), value: "alpha" },
    ],
    type: "select",
    validate: validateUpdateTier,
  },
];

/** Password field with new-password autocomplete (reused across setup, change password, and join forms) */
const newPasswordField = (
  name: string,
  label: string,
  { confirm }: { confirm?: boolean } = {},
): Field => ({
  autocomplete: "new-password",
  label,
  name,
  required: true,
  type: "password",
  ...(!confirm && { hint: t("fields.setup.password_hint"), minlength: 8 }),
});

/**
 * Setup form field definitions (per-request builder)
 * Note: Stripe keys are now configured via environment variables
 */
export const getSetupFields = (): Field[] => [
  {
    autocomplete: "username",
    hint: t("fields.setup.username_hint"),
    label: t("fields.setup.username"),
    name: "admin_username",
    required: true,
    type: "text",
    validate: validateUsername,
  },
  newPasswordField("admin_password", t("fields.setup.password")),
  newPasswordField(
    "admin_password_confirm",
    t("fields.setup.confirm_password"),
    {
      confirm: true,
    },
  ),
];

/**
 * Change password form field definitions (per-request builder)
 */
export const getChangePasswordFields = (): Field[] => [
  {
    autocomplete: "current-password",
    label: t("fields.change_password.current"),
    name: "current_password",
    required: true,
    type: "password",
  },
  newPasswordField("new_password", t("fields.change_password.new")),
  newPasswordField(
    "new_password_confirm",
    t("fields.change_password.confirm"),
    {
      confirm: true,
    },
  ),
];

/**
 * Stripe key settings form field definitions (per-request builder)
 */
export const getStripeKeyFields = (): Field[] => [
  {
    autocomplete: "off",
    hint: t("fields.stripe.secret_key_hint"),
    label: t("fields.stripe.secret_key"),
    name: "stripe_secret_key",
    placeholder: t("fields.stripe.secret_key_placeholder"),
    required: true,
    type: "password",
  },
];

/**
 * Square access token and location form field definitions (per-request builder)
 */
export const getSquareAccessTokenFields = (): Field[] => [
  {
    autocomplete: "off",
    hint: t("fields.square.access_token_hint"),
    label: t("fields.square.access_token"),
    name: "square_access_token",
    placeholder: t("fields.square.access_token_placeholder"),
    required: true,
    type: "password",
  },
  {
    autocomplete: "off",
    hint: t("fields.square.location_id_hint"),
    label: t("fields.square.location_id"),
    name: "square_location_id",
    placeholder: t("fields.square.location_id_placeholder"),
    required: true,
    type: "text",
  },
];

/**
 * Square webhook settings form field definitions (per-request builder)
 */
export const getSquareWebhookFields = (): Field[] => [
  {
    autocomplete: "off",
    hint: t("fields.square.webhook_key_hint"),
    label: t("fields.square.webhook_key"),
    name: "square_webhook_signature_key",
    required: true,
    type: "password",
  },
];

/**
 * SumUp API key and merchant code form field definitions (per-request builder)
 */
export const getSumupFields = (): Field[] => [
  {
    autocomplete: "off",
    hint: t("fields.sumup.api_key_hint"),
    label: t("fields.sumup.api_key"),
    name: "sumup_api_key",
    placeholder: t("fields.sumup.api_key_placeholder"),
    required: true,
    type: "password",
  },
  {
    autocomplete: "off",
    hint: t("fields.sumup.merchant_code_hint"),
    label: t("fields.sumup.merchant_code"),
    name: "sumup_merchant_code",
    placeholder: t("fields.sumup.merchant_code_placeholder"),
    required: true,
    type: "text",
  },
];

/**
 * Invite user form field definitions (per-request builder)
 */
export const getInviteUserFields = (): Field[] => [
  {
    ...getUsernameFieldBase(),
    hint: t("fields.user.username_hint"),
    validate: validateUsername,
  },
  {
    label: t("fields.user.role"),
    name: "admin_level",
    options: picklistOptions(AdminLevelSchema, "fields.user"),
    required: true,
    type: "select",
  },
];
