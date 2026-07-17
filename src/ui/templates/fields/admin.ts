/**
 * Admin/operator form fields — login, setup, password change, payment-provider
 * keys, invite user, holidays, and built-site management. Each is a per-request
 * builder because every label/hint flows through the i18n layer.
 */

import { t } from "#i18n";
import {
  defineForm,
  type FormDefinition,
  type FormValues,
} from "#shared/forms/definition.ts";
import type { Field, InputField } from "#shared/forms/field.ts";
import { AdminLevelSchema } from "#shared/types.ts";
import { checkboxField } from "#templates/fields/checkbox-field.ts";
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
const getLoginFields = () =>
  [
    { ...getUsernameFieldBase(), autocomplete: "username" },
    {
      autocomplete: "current-password",
      label: t("fields.login.password"),
      name: "password",
      required: true,
      type: "password",
    },
  ] as const satisfies readonly Field[];

type LoginForm = FormDefinition<ReturnType<typeof getLoginFields>>;

export const getLoginForm = (): LoginForm =>
  defineForm({ fields: getLoginFields(), id: "login" });

/**
 * Holiday form field definitions (per-request builder)
 */
const getHolidayFields = () =>
  [
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
  ] as const satisfies readonly Field[];

type HolidayForm = FormDefinition<ReturnType<typeof getHolidayFields>>;

export const getHolidayForm = (): HolidayForm =>
  defineForm({ fields: getHolidayFields(), id: "holiday" });

/**
 * Built site form field definitions (per-request builder)
 */
const getBuiltSiteFields = () =>
  [
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
    checkboxField("assignable", {
      hint: t("fields.built_site.assignable_hint"),
      label: t("fields.built_site.assignable"),
      optionLabel: t("fields.built_site.assignable_label"),
    }),
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
  ] as const satisfies readonly Field[];

type BuiltSiteForm = FormDefinition<ReturnType<typeof getBuiltSiteFields>>;

export const getBuiltSiteForm = (): BuiltSiteForm =>
  defineForm({ fields: getBuiltSiteFields(), id: "built-site" });

/** Password field with new-password autocomplete (reused across setup, change password, and join forms) */
const newPasswordField = <TName extends string>(
  name: TName,
  label: string,
  { confirm }: { confirm?: boolean } = {},
): InputField<TName> & { required: true } => ({
  autocomplete: "new-password",
  label,
  name,
  required: true,
  type: "password",
  ...(!confirm && { hint: t("fields.setup.password_hint"), minlength: 8 }),
});

const newPasswordFields = <TName extends string, TConfirmName extends string>(
  name: TName,
  label: string,
  confirmName: TConfirmName,
  confirmLabel: string,
) =>
  [
    newPasswordField(name, label),
    newPasswordField(confirmName, confirmLabel, { confirm: true }),
  ] as const;

/**
 * Setup form field definitions (per-request builder)
 * Note: Stripe keys are now configured via environment variables
 */
const getSetupFields = () =>
  [
    {
      autocomplete: "username",
      hint: t("fields.setup.username_hint"),
      label: t("fields.setup.username"),
      name: "admin_username",
      required: true,
      type: "text",
      validate: validateUsername,
    },
    ...newPasswordFields(
      "admin_password",
      t("fields.setup.password"),
      "admin_password_confirm",
      t("fields.setup.confirm_password"),
    ),
  ] as const satisfies readonly Field[];

type SetupForm = FormDefinition<ReturnType<typeof getSetupFields>>;

export const getSetupForm = (): SetupForm =>
  defineForm({ fields: getSetupFields(), id: "setup" });

/**
 * Change password form field definitions (per-request builder)
 */
const getChangePasswordFields = () =>
  [
    {
      autocomplete: "current-password",
      label: t("fields.change_password.current"),
      name: "current_password",
      required: true,
      type: "password",
    },
    ...newPasswordFields(
      "new_password",
      t("fields.change_password.new"),
      "new_password_confirm",
      t("fields.change_password.confirm"),
    ),
  ] as const satisfies readonly Field[];

type ChangePasswordForm = FormDefinition<
  ReturnType<typeof getChangePasswordFields>
>;

export const getChangePasswordForm = (): ChangePasswordForm =>
  defineForm({ fields: getChangePasswordFields(), id: "change-password" });

/** A required payment-provider credential field: never autofilled, always
 * carries a hint, and (when given) a placeholder. `type` is "password" for
 * secret keys/tokens and "text" for public ids like a location or merchant
 * code. */
const secretField = ({
  hint,
  label,
  name,
  placeholder,
  type = "password",
}: {
  hint: string;
  label: string;
  name: string;
  placeholder?: string;
  type?: "password" | "text";
}): Field => ({
  autocomplete: "off",
  hint,
  label,
  name,
  ...(placeholder !== undefined && { placeholder }),
  required: true,
  type,
});

/**
 * Stripe key settings form field definitions (per-request builder)
 */
export const getStripeKeyFields = (): Field[] => [
  secretField({
    hint: t("fields.stripe.secret_key_hint"),
    label: t("fields.stripe.secret_key"),
    name: "stripe_secret_key",
    placeholder: t("fields.stripe.secret_key_placeholder"),
  }),
];

/**
 * Square access token and location form field definitions (per-request builder)
 */
export const getSquareAccessTokenFields = (): Field[] => [
  secretField({
    hint: t("fields.square.access_token_hint"),
    label: t("fields.square.access_token"),
    name: "square_access_token",
    placeholder: t("fields.square.access_token_placeholder"),
  }),
  secretField({
    hint: t("fields.square.location_id_hint"),
    label: t("fields.square.location_id"),
    name: "square_location_id",
    placeholder: t("fields.square.location_id_placeholder"),
    type: "text",
  }),
];

/**
 * Square webhook settings form field definitions (per-request builder)
 */
export const getSquareWebhookFields = (): Field[] => [
  secretField({
    hint: t("fields.square.webhook_key_hint"),
    label: t("fields.square.webhook_key"),
    name: "square_webhook_signature_key",
  }),
];

/**
 * SumUp API key and merchant code form field definitions (per-request builder)
 */
export const getSumupFields = (): Field[] => [
  secretField({
    hint: t("fields.sumup.api_key_hint"),
    label: t("fields.sumup.api_key"),
    name: "sumup_api_key",
    placeholder: t("fields.sumup.api_key_placeholder"),
  }),
  secretField({
    hint: t("fields.sumup.merchant_code_hint"),
    label: t("fields.sumup.merchant_code"),
    name: "sumup_merchant_code",
    placeholder: t("fields.sumup.merchant_code_placeholder"),
    type: "text",
  }),
];

/**
 * Invite user form field definitions (per-request builder)
 */
const getInviteUserFields = () =>
  [
    {
      ...getUsernameFieldBase(),
      hint: t("fields.user.username_hint"),
      validate: validateUsername,
    },
    {
      // A blank option leads so nothing is pre-selected: the role is required, so
      // an unchanged form is rejected ("Role is required") rather than silently
      // granting whatever option happens to sit first (AdminLevelSchema lists
      // owner first). The operator must pick a role deliberately.
      invalidMessage: "Invalid role",
      label: t("fields.user.role"),
      name: "admin_level",
      options: [
        { label: t("fields.user.role_placeholder"), value: "" },
        ...picklistOptions(AdminLevelSchema, "fields.user"),
      ],
      required: true,
      type: "select",
    },
  ] as const satisfies readonly Field[];

type InviteUserForm = FormDefinition<ReturnType<typeof getInviteUserFields>>;

export const getInviteUserForm = (): InviteUserForm =>
  defineForm({ fields: getInviteUserFields(), id: "invite-user" });

export type InviteUserFormValues = FormValues<InviteUserForm>;
