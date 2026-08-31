import {
  type FindingIdentity,
  identitiesAt,
} from "#scripts/unread-fields/identity.ts";

const RESOURCE_FIELDS = [
  "fields",
  "parseInput",
  "table",
  "verifyName",
] as const;
const SETTINGS_CONFIG_FIELDS = [
  "action",
  "formId",
  "kind",
  "name",
  "page",
  "routeLabel",
] as const;
const KEYED_SETTINGS_CONFIG_FIELDS = [
  ...SETTINGS_CONFIG_FIELDS,
  "key",
] as const;
const SINGLE_SETTINGS_FORM_FIELDS = [
  "action",
  "copy",
  "inputType",
  "key",
  "markdownPreview",
  "max",
  "min",
  "required",
  "stateField",
  "step",
  "valueFallback",
] as const;
const SETTINGS_FORM_FIELDS = [
  ...SINGLE_SETTINGS_FORM_FIELDS,
  "fields",
] as const;
const CONTENT_META_FIELDS = [
  "meta_description",
  "meta_title",
  "slug_index",
] as const;

export const SHARED_PROVIDER_Z_BASELINE: readonly FindingIdentity[] = [
  ...identitiesAt([
    [
      "src/shared/reservation-amount.ts",
      [{ name: "ReservationDepositAllocation" }],
    ],
  ])(["perItemTotals", "total"]),
  ...identitiesAt([
    ["src/shared/rest/resource.ts", [{ name: "NamedResource" }]],
    ["src/shared/rest/resource.ts", [{ name: "Resource" }]],
  ])(RESOURCE_FIELDS),
  ...identitiesAt([
    ["src/shared/schema-atlas/machine-spec.ts", [{ name: "DerivedNodeIds" }]],
  ])(["terminal"]),
  ...identitiesAt([
    [
      "src/shared/schema-atlas/machine-spec.ts",
      [{ name: "MachineMovesReader" }],
    ],
  ])(["splitTags"]),
  ...identitiesAt([
    [
      "src/shared/schema-atlas/types.ts",
      [{ name: "AtlasState" }, { name: "layout" }],
    ],
  ])(["x", "y"]),
  ...identitiesAt([
    [
      "src/shared/settings/form-schema.ts",
      [{ name: "BooleanSettingsFormConfig" }],
    ],
    ["src/shared/settings/form-schema.ts", [{ name: "SettingsFormConfig" }]],
    [
      "src/shared/settings/form-schema.ts",
      [{ name: "TextareaSettingsFormConfig" }],
    ],
    [
      "src/shared/settings/form-schema.ts",
      [{ name: "TextSettingsFormConfig" }],
    ],
  ])(KEYED_SETTINGS_CONFIG_FIELDS),
  ...identitiesAt([
    ["src/shared/settings/form-schema.ts", [{ name: "FieldFormCopy" }]],
  ])(["submitLabelKey"]),
  ...identitiesAt([
    [
      "src/shared/settings/form-schema.ts",
      [{ name: "FieldsSettingsFormConfig" }],
    ],
  ])(SETTINGS_CONFIG_FIELDS),
  ...identitiesAt([
    ["src/shared/settings/forms.ts", [{ name: "SettingsFormDefinition" }]],
    ["src/shared/settings/forms.ts", [{ name: "SettingsFormFor" }]],
  ])(SETTINGS_FORM_FIELDS),
  ...identitiesAt([
    ["src/shared/settings/forms.ts", [{ name: "SingleFieldSettingsForm" }]],
  ])(SINGLE_SETTINGS_FORM_FIELDS),
  ...identitiesAt([["src/shared/site-pages/types.ts", [{ name: "NavLevel" }]]])(
    ["label", "nodes"],
  ),
  ...identitiesAt([["src/shared/site-pages/types.ts", [{ name: "NavModel" }]]])(
    ["activeRootId"],
  ),
  ...identitiesAt([["src/shared/site-pages/types.ts", [{ name: "NavNode" }]]])([
    "active",
    "children",
    "href",
    "key",
    "label",
    "live",
  ]),
  ...identitiesAt([
    ["src/shared/sms/gateway.ts", [{ name: "EncryptedMessagePayload" }]],
  ])(["isEncrypted", "phoneNumbers", "textMessage", "withDeliveryReport"]),
  ...identitiesAt([
    ["src/shared/square/client.ts", [{ name: "SquareClient" }]],
  ])(["payments", "refunds"]),
  ...identitiesAt([
    [
      "src/shared/square/payment-outcomes.ts",
      [
        { name: "SquarePaymentClient" },
        { name: "payments" },
        { name: "get" },
        { way: "()" },
        { way: "input" },
      ],
    ],
  ])(["paymentId"]),
  ...identitiesAt([
    ["src/shared/stripe/client.ts", [{ name: "StripeCheckoutLineItemParams" }]],
  ])(["price_data", "quantity"]),
  ...identitiesAt([
    [
      "src/shared/stripe/client.ts",
      [{ name: "StripeCheckoutSessionCreateParams" }],
    ],
  ])([
    "cancel_url",
    "customer_email",
    "line_items",
    "metadata",
    "mode",
    "payment_method_types",
    "success_url",
  ]),
  ...identitiesAt([
    [
      "src/shared/stripe/client.ts",
      [{ name: "StripeWebhookEndpointCreateParams" }],
    ],
  ])(["api_version", "enabled_events", "url"]),
  ...identitiesAt([["src/shared/svg-ticket.ts", [{ name: "SvgTicketData" }]]])([
    "currency",
  ]),
  ...identitiesAt([
    [
      "src/shared/tables/column.ts",
      [{ name: "ReorderColumnOptions" }, { name: "titles" }],
    ],
  ])(["down", "up"]),
  ...identitiesAt([["src/shared/types.ts", [{ name: "ApiKey" }]]])([
    "created",
    "key_index",
    "last_used",
    "name",
  ]),
  ...identitiesAt([
    ["src/shared/types.ts", [{ name: "EncryptedContentRecord" }]],
    ["src/shared/types.ts", [{ name: "NewsPost" }]],
    ["src/shared/types.ts", [{ name: "SitePage" }]],
  ])(CONTENT_META_FIELDS),
  ...identitiesAt([["src/shared/types.ts", [{ name: "ImageUse" }]]])([
    "image_id",
    "sort_order",
  ]),
  ...identitiesAt([["src/shared/types.ts", [{ name: "PiiBlob" }]]])(["v"]),
  ...identitiesAt([["src/shared/types.ts", [{ name: "Session" }]]])([
    "csrf_token",
  ]),
  ...identitiesAt([["src/shared/types.ts", [{ name: "Settings" }]]])([
    "key",
    "value",
  ]),
  ...identitiesAt([["src/shared/types.ts", [{ name: "UserLogisticsAgent" }]]])([
    "agent_id",
    "id",
    "user_id",
  ]),
  ...identitiesAt([["src/shared/update.ts", [{ name: "ReleaseInfo" }]]])([
    "publishedAt",
  ]),
  ...identitiesAt([
    ["src/shared/uptime-kuma/socket.ts", [{ name: "UptimeKumaWebSocket" }]],
  ])(["onclose", "onerror", "onmessage"]),
  ...identitiesAt([
    [
      "src/shared/wallets/wallet-settings-types.ts",
      [{ name: "WalletReadSettings" }],
    ],
  ])(["dbConfig", "resetHostConfig", "setHostConfigForTest"]),
  ...identitiesAt([["src/shared/webhook.ts", [{ name: "WebhookListing" }]]])([
    "attendee_count",
    "can_pay_more",
    "day_prices",
    "max_attendees",
    "unit_price",
  ]),
  ...identitiesAt([["src/shared/webhook.ts", [{ name: "WebhookPayload" }]]])([
    "amount_owed",
    "business_email",
    "currency",
    "notification_type",
    "payment_id",
    "price_paid",
    "ticket_url",
    "tickets",
    "timestamp",
  ]),
  ...identitiesAt([["src/shared/webhook.ts", [{ name: "WebhookTicket" }]]])([
    "date",
    "listing_name",
    "listing_slug",
    "quantity",
    "ticket_token",
    "unit_price",
  ]),
  ...identitiesAt([
    ["src/shared/webhook/delivery.ts", [{ name: "WebhookDelivery" }]],
  ])(["delivered", "reason"]),
];
