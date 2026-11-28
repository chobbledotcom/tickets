/**
 * The codec of each column whose stored value is not the value that the code
 * uses. A typed read decodes these columns, and `encoded` encodes them before
 * a write. A column that is not here reads and writes as it is stored.
 *
 * Each codec reaches its helpers through an arrow, so this module can load
 * before the modules that it names.
 */

import { encrypt } from "#crypto/encryption.ts";
import type {
  BlindIndex,
  EnvKeyEncrypted,
  KeyEncrypted,
  OwnerKeyEncrypted,
  WrappedKey,
} from "#crypto/sealed.ts";
import { fieldCodecs, sealed } from "#db/codecs/fields.ts";
import {
  blankAsItself,
  type Codec,
  type ColumnCodec,
  json,
  nullable,
  typed,
  yesNo,
} from "#db/codecs/kinds.ts";
import type { ExternalLinkKind } from "#db/external-sources/types.ts";
import type {
  QuestionAnswerLevel,
  QuestionDisplayType,
} from "#db/question-types.ts";
import type { DeclaredRow, TableName } from "#db/select/tables.ts";
import { decryptImageFilename } from "#shared/images/broken.ts";
import type { InvoiceStatus } from "#shared/invoices/status.ts";
import type {
  CalcKind,
  ModifierDirection,
  ModifierScope,
  ModifierTrigger,
} from "#shared/price-modifier.ts";
import { ATTRIBUTE_FIELDS } from "#shared/records/attribute-fields.ts";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { HOLIDAY_FIELDS } from "#shared/records/holiday-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { LOGISTICS_AGENT_FIELDS } from "#shared/records/logistics-agent-fields.ts";
import { REDIRECT_FIELDS } from "#shared/records/redirect-fields.ts";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import type {
  RecurringIntervalChoice,
  SubscriptionStatus,
} from "#shared/subscriptions/plan.ts";
import { TaxAssessmentSchema } from "#shared/tax/types.ts";
import type { NonEmptyString } from "#shared/validation/string.ts";
import type { ImageUseItemType, SitePageItemType } from "#types";

/** Text that an admin typed, sealed under the owner key. Only an admin
 *  request can read it. The sealing helpers read the settings, which read
 *  through the client, so they load on first use. */
const adminSealed: Codec<OwnerKeyEncrypted, string> = {
  decode: async (stored) =>
    (await import("#db/external-sources/sealing.ts")).openForAdmin(stored),
  encode: async (app) =>
    (await import("#db/external-sources/sealing.ts")).sealForAdmin(app),
};

/** An image filename. One that will not open reads as the broken-image
 *  marker, so one bad record does not break every page with images. */
const imageFilename = (
  label: string,
): Codec<EnvKeyEncrypted, NonEmptyString> => ({
  decode: (stored, rowId) =>
    decryptImageFilename(stored, `image ${String(rowId)} ${label}`),
  encode: (app) => encrypt(app),
});

/** The sealed name, content and meta text of an operator page. */
const SEALED_PAGE_TEXT = {
  content: blankAsItself(sealed),
  meta_description: blankAsItself(sealed),
  meta_title: blankAsItself(sealed),
  name: sealed,
  slug: sealed,
  slug_index: typed<BlindIndex>(),
} as const;

/** The codecs that a table can give its columns. */
type CodecMap = {
  readonly [Name in TableName]?: {
    readonly [Column in keyof DeclaredRow<Name>]?: ColumnCodec;
  };
};

export const CODECS = {
  activity_log: { message: typed<OwnerKeyEncrypted | EnvKeyEncrypted>() },
  answers: { active: yesNo, text: sealed },
  answers_at_booking: {
    answer_text: nullable(sealed),
    free_text: typed<OwnerKeyEncrypted | null>(),
    question_text: sealed,
  },
  api_keys: {
    key_index: typed<BlindIndex>(),
    name: sealed,
    wrapped_data_key: typed<WrappedKey>(),
  },
  attendee_statuses: fieldCodecs("attendee_statuses", STATUS_FIELDS),
  attendees: { pii_blob: typed<OwnerKeyEncrypted | "">() },
  attribute_options: { text: sealed },
  attributes: fieldCodecs("attributes", ATTRIBUTE_FIELDS),
  booking_tax_assessments: {
    assessment: json(TaxAssessmentSchema, "Booking tax assessment"),
  },
  built_sites: { site_data: sealed },
  contact_preferences: { stats_blob: typed<OwnerKeyEncrypted | "">() },
  email_templates: {
    body: typed<OwnerKeyEncrypted>(),
    subject: typed<OwnerKeyEncrypted>(),
  },
  external_source_links: {
    external_id: nullable(adminSealed),
    external_id_index: typed<BlindIndex | null>(),
    link_type: typed<ExternalLinkKind>(),
  },
  external_sources: { name: adminSealed, url_pattern: adminSealed },
  groups: {
    ...fieldCodecs("groups", GROUP_FIELDS),
    slug: sealed,
    slug_index: typed<BlindIndex>(),
  },
  holidays: fieldCodecs("holidays", HOLIDAY_FIELDS),
  image_uses: { item_type: typed<ImageUseItemType>() },
  images: {
    alt_text: blankAsItself(sealed),
    filename: imageFilename("filename"),
    filename_thumb: imageFilename("thumbnail filename"),
    name: blankAsItself(sealed),
  },
  invoices: {
    body: typed<KeyEncrypted>(),
    share_token: typed<OwnerKeyEncrypted>(),
    share_token_index: typed<BlindIndex>(),
    status: typed<InvoiceStatus>(),
  },
  listing_attendees: {
    recurring_interval: typed<RecurringIntervalChoice>(),
    subscription_status: typed<SubscriptionStatus | "">(),
  },
  listings: {
    ...fieldCodecs("listings", LISTING_FIELDS),
    attachment_name: blankAsItself(sealed),
    attachment_url: blankAsItself(sealed),
    slug: sealed,
    // Every listing gets its slug when it is made, so the index is never
    // empty.
    slug_index: typed<BlindIndex>(),
  },
  logistics_agents: fieldCodecs("logistics_agents", LOGISTICS_AGENT_FIELDS),
  modifiers: {
    active: yesNo,
    calc_kind: typed<CalcKind>(),
    code: blankAsItself(sealed),
    direction: typed<ModifierDirection>(),
    name: sealed,
    scope: typed<ModifierScope>(),
    trigger: typed<ModifierTrigger>(),
  },
  news_posts: { ...SEALED_PAGE_TEXT, snippet: blankAsItself(sealed) },
  processed_payments: {
    failure_data: typed<EnvKeyEncrypted | "">(),
    payment_reference: typed<OwnerKeyEncrypted | "">(),
    ticket_tokens: typed<EnvKeyEncrypted | "">(),
  },
  questions: {
    answer_level: typed<QuestionAnswerLevel>(),
    assign_all: yesNo,
    display_type: typed<QuestionDisplayType>(),
    text: sealed,
  },
  redirects: {
    ...fieldCodecs("redirects", REDIRECT_FIELDS),
    from_index: typed<BlindIndex>(),
    to_index: typed<BlindIndex | null>(),
  },
  reviews: {
    name: sealed,
    text: sealed,
    url: nullable(sealed),
    url_index: typed<BlindIndex | null>(),
  },
  site_page_items: { item_type: typed<SitePageItemType>() },
  site_pages: { ...SEALED_PAGE_TEXT, hidden: yesNo },
  system_notes: { note: typed<EnvKeyEncrypted | OwnerKeyEncrypted>() },
  users: {
    admin_level: typed<EnvKeyEncrypted>(),
    username_hash: typed<EnvKeyEncrypted>(),
  },
} as const satisfies CodecMap;
