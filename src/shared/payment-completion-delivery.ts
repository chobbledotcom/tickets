import * as v from "valibot";
import { EmailSchema } from "#shared/validation/email.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

const EmailAttachmentSchema = v.strictObject({
  content: v.string(),
  contentType: v.string(),
  filename: v.string(),
});

const EmailMessageSchema = v.strictObject({
  attachments: v.optional(v.array(EmailAttachmentSchema)),
  html: v.string(),
  replyTo: v.optional(EmailSchema),
  subject: v.string(),
  text: v.string(),
  to: EmailSchema,
});

const EmailConfigFactsSchema = v.strictObject({
  fromAddress: EmailSchema,
  provider: v.string(),
});

const RegistrationEmailDeliverySchema = v.strictObject({
  config: EmailConfigFactsSchema,
  kind: v.literal("registration_email"),
  message: EmailMessageSchema,
});

const WebhookTicketSchema = v.strictObject({
  date: v.nullable(v.string()),
  listing_name: v.string(),
  listing_slug: v.string(),
  quantity: v.number(),
  ticket_token: v.string(),
  unit_price: v.number(),
});

const WebhookPayloadSchema = v.strictObject({
  address: v.string(),
  amount_owed: v.number(),
  business_email: v.string(),
  currency: v.string(),
  email: v.string(),
  name: v.string(),
  notification_type: v.literal("registration.completed"),
  payment_id: v.nullable(v.string()),
  phone: v.string(),
  price_paid: v.nullable(v.number()),
  special_instructions: v.string(),
  ticket_url: v.string(),
  tickets: v.array(WebhookTicketSchema),
  timestamp: v.string(),
});

const RegistrationWebhookDeliverySchema = v.strictObject({
  kind: v.literal("registration_webhook"),
  listingId: v.optional(integerAtLeast(1)),
  payload: WebhookPayloadSchema,
  url: v.string(),
});

const HostingSiteFields = {
  hostingId: v.string(),
  hostingProvider: v.picklist(["bunny", "deno"]),
  siteId: integerAtLeast(1),
  siteName: v.string(),
} as const;

const RenewalDeadlineFields = {
  previousReadOnlyFrom: v.string(),
  readOnlyFrom: v.string(),
} as const;

export const SiteAssignmentFactsSchema = v.strictObject({
  ...HostingSiteFields,
  ...RenewalDeadlineFields,
  previousRenewalTokenIndex: v.nullable(v.string()),
  renewalToken: v.string(),
  renewalTokenIndex: v.string(),
  renewalUrl: v.string(),
  siteUrl: v.string(),
});

const SiteAssignmentDeliverySchema = v.strictObject({
  attendeeId: integerAtLeast(1),
  effectId: v.string(),
  initialSiteMonths: integerAtLeast(1),
  kind: v.literal("site_assignment"),
  listingId: integerAtLeast(1),
  listingName: v.string(),
  site: v.nullable(SiteAssignmentFactsSchema),
});

const SiteAssignmentEmailDeliverySchema = v.strictObject({
  assignmentKeys: v.pipe(v.array(v.string()), v.minLength(1)),
  config: EmailConfigFactsSchema,
  kind: v.literal("site_assignment_email"),
  recipient: EmailSchema,
});

const RenewalDeliverySchema = v.strictObject({
  ...HostingSiteFields,
  ...RenewalDeadlineFields,
  kind: v.literal("renewal"),
  listingId: integerAtLeast(1),
  months: integerAtLeast(1),
  renewalTokenIndex: v.string(),
});

export const PaymentCompletionDeliveryDataSchema = v.variant("kind", [
  RegistrationEmailDeliverySchema,
  RegistrationWebhookDeliverySchema,
  SiteAssignmentDeliverySchema,
  SiteAssignmentEmailDeliverySchema,
  RenewalDeliverySchema,
]);

export type PaymentCompletionDeliveryData = v.InferOutput<
  typeof PaymentCompletionDeliveryDataSchema
>;
export type RegistrationEmailDelivery = v.InferOutput<
  typeof RegistrationEmailDeliverySchema
>;
export type RegistrationWebhookDelivery = v.InferOutput<
  typeof RegistrationWebhookDeliverySchema
>;
export type SiteAssignmentDelivery = v.InferOutput<
  typeof SiteAssignmentDeliverySchema
>;
/** What a paid site assignment knows about the site once it has one. */
export type SiteAssignmentFacts = v.InferOutput<
  typeof SiteAssignmentFactsSchema
>;
export type SiteAssignmentEmailDelivery = v.InferOutput<
  typeof SiteAssignmentEmailDeliverySchema
>;
export type RenewalDelivery = v.InferOutput<typeof RenewalDeliverySchema>;

export interface PreparedPaymentCompletionDelivery {
  data: PaymentCompletionDeliveryData;
  key: string;
}
