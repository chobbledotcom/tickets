import { CONFIG_KEYS, type ConfigKey } from "#shared/settings/keys.ts";

export type SettingsFormPage = "main" | "advanced";

export type FormCopyBase = {
  titleKey: string;
  descriptionKey: string;
  /** `true` renders the trusted-HTML description inside the usual paragraph;
   * `"block"` renders it bare, for catalog values carrying their own block
   * markup (their own `<p>` tags). */
  descriptionHtml?: true | "block";
};

export type FieldFormCopy = FormCopyBase & {
  labelKey: string;
  labelHint?: "formatting";
  /** Placeholder: a catalog key, or text built at render time (for example a
   * default template). Set at most one; omit both for no placeholder. */
  placeholderKey?: string;
  placeholderText?: () => string;
  submitLabelKey: string;
  /** Small note under the field: a catalog key, or text built at render time. */
  footerKey?: string;
  footerText?: () => string;
};

type BooleanFormCopy = FormCopyBase;

type SettingsFormBase<Copy extends FormCopyBase> = {
  name: string;
  page: SettingsFormPage;
  key: ConfigKey;
  action: string;
  formId: string;
  fieldName: string;
  routeLabel: string;
  stateField: string;
  copy: Copy;
};

export type TextSettingsFormConfig = SettingsFormBase<FieldFormCopy> & {
  kind: "text";
  inputType: "email" | "text" | "number" | "url";
  /** Input constraints, forwarded to the rendered field as-is. */
  min?: string;
  max?: string;
  step?: string;
  minlength?: number;
  required?: true;
  /** Show the placeholder as the value when nothing is saved yet. */
  valueFallback?: "placeholder";
};

export type TextareaSettingsFormConfig = SettingsFormBase<FieldFormCopy> & {
  kind: "textarea";
  markdownPreview?: true;
};

export type BooleanSettingsFormConfig = SettingsFormBase<BooleanFormCopy> & {
  kind: "boolean";
};

type SettingsFormConfig =
  | BooleanSettingsFormConfig
  | TextSettingsFormConfig
  | TextareaSettingsFormConfig;

const form = <const Definition extends SettingsFormConfig>(
  definition: Definition,
): Definition => definition;

export const SETTINGS_FORM_DEFINITIONS = [
  form({
    action: "/admin/settings/business-email",
    copy: {
      descriptionKey: "settings.business_email_hint",
      labelKey: "settings.business_email",
      placeholderKey: "settings.business_email_placeholder",
      submitLabelKey: "settings.save_business_email",
      titleKey: "settings.business_email",
    },
    fieldName: "business_email",
    formId: "settings-business-email",
    inputType: "email",
    key: CONFIG_KEYS.BUSINESS_EMAIL,
    kind: "text",
    name: "businessEmail",
    page: "main",
    routeLabel: "Business email",
    stateField: "businessEmail",
  }),
  form({
    action: "/admin/settings/terms",
    copy: {
      descriptionKey: "settings.terms_hint",
      labelHint: "formatting",
      labelKey: "settings.terms",
      placeholderKey: "settings.terms_placeholder",
      submitLabelKey: "settings.save_terms",
      titleKey: "settings.terms",
    },
    fieldName: "terms_and_conditions",
    formId: "settings-terms",
    key: CONFIG_KEYS.TERMS_AND_CONDITIONS,
    kind: "textarea",
    markdownPreview: true,
    name: "terms",
    page: "main",
    routeLabel: "Terms and conditions",
    stateField: "termsAndConditions",
  }),
  form({
    action: "/admin/settings/embed-hosts",
    copy: {
      descriptionKey: "settings.embed_hosts_hint",
      footerKey: "settings.embed_hosts_wildcard_hint",
      labelKey: "settings.embed_hosts_label",
      placeholderKey: "settings.embed_hosts_placeholder",
      submitLabelKey: "settings.save_embed_hosts",
      titleKey: "settings.embed_hosts",
    },
    fieldName: "embed_hosts",
    formId: "settings-embed-hosts",
    inputType: "text",
    key: CONFIG_KEYS.EMBED_HOSTS,
    kind: "text",
    name: "embedHosts",
    page: "main",
    routeLabel: "Embed host restrictions",
    stateField: "embedHosts",
  }),
  form({
    action: "/admin/settings/custom-css",
    copy: {
      descriptionKey: "settings.advanced.custom_css_hint",
      labelKey: "settings.advanced.custom_css_label",
      placeholderKey: "settings.advanced.custom_css_placeholder",
      submitLabelKey: "settings.advanced.save_custom_css",
      titleKey: "settings.advanced.custom_css",
    },
    fieldName: "custom_css",
    formId: "settings-custom-css",
    key: CONFIG_KEYS.CUSTOM_CSS,
    kind: "textarea",
    name: "customCss",
    page: "advanced",
    routeLabel: "Custom CSS",
    stateField: "customCss",
  }),
  form({
    action: "/admin/settings/show-public-api",
    copy: {
      descriptionHtml: true,
      descriptionKey: "settings.advanced.public_api_hint",
      titleKey: "settings.advanced.public_api",
    },
    fieldName: "show_public_api",
    formId: "settings-show-public-api",
    key: CONFIG_KEYS.SHOW_PUBLIC_API,
    kind: "boolean",
    name: "showPublicApi",
    page: "advanced",
    routeLabel: "Public API",
    stateField: "showPublicApi",
  }),
  form({
    action: "/admin/settings/external-order",
    copy: {
      descriptionKey: "settings.advanced.external_order_hint",
      titleKey: "settings.advanced.external_order",
    },
    fieldName: "external_order_enabled",
    formId: "settings-external-order",
    key: CONFIG_KEYS.EXTERNAL_ORDER_ENABLED,
    kind: "boolean",
    name: "externalOrder",
    page: "advanced",
    routeLabel: "External order buttons",
    stateField: "externalOrderEnabled",
  }),
] as const;

export type SettingsFormDefinition = (typeof SETTINGS_FORM_DEFINITIONS)[number];
export type SettingsFormName = SettingsFormDefinition["name"];

type SettingFormFor<Name extends SettingsFormName> = Extract<
  SettingsFormDefinition,
  { name: Name }
>;

export type SettingsFormsByName = {
  readonly [Name in SettingsFormName]: SettingFormFor<Name>;
};

export const SETTINGS_FORMS = Object.fromEntries(
  SETTINGS_FORM_DEFINITIONS.map((definition) => [definition.name, definition]),
) as SettingsFormsByName;
