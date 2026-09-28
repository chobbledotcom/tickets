/**
 * The Liquid variables a confirmation email template can use, and a worked
 * loop over them — one declaration for every surface that shows the
 * reference: the advanced-settings form and the admin guide.
 *
 * The contract test in test/shared/email-renderer/variable-reference.test.ts
 * pins this list to the runtime TemplateData shape, so a field gained or lost
 * on either side fails the build.
 */

import { t } from "#i18n";
import { PRUNE_PAYMENTS_RETENTION_DAYS } from "#shared/limits.ts";

/** [what the owner types, the message key describing it]. */
export const TEMPLATE_VARIABLES: [code: string, key: string][] = [
  ["{{ listing_names }}", "listing_names"],
  ["{{ ticket_url }}", "ticket_url"],
  ["{{ currency }}", "currency"],
  ["{{ amount_owed | currency }}", "amount_owed"],
  ["{{ attendee.name }}", "attendee_name"],
  ["{{ attendee.email }}", "attendee_email"],
  ["{{ attendee.phone }}", "attendee_phone"],
  ["{{ attendee.address }}", "attendee_address"],
  ["{{ attendee.special_instructions }}", "attendee_special_instructions"],
  ["{{ attendee.quantity }}", "entry_attendee_quantity"],
  ["{{ attendee.price_paid | currency }}", "entry_attendee_price_paid"],
  ["{{ attendee.date }}", "entry_attendee_date"],
  ["{{ attendee.date_range_label }}", "entry_attendee_date_range_label"],
  ["{{ attendee.answers }}", "entry_attendee_answers"],
  ["{{ entries }}", "entries"],
  ["{{ entry.listing.name }}", "entry_listing_name"],
  ["{{ entry.listing.slug }}", "entry_listing_slug"],
  ["{{ entry.listing.is_paid }}", "entry_listing_is_paid"],
  ["{{ entry.attendee.name }}", "attendee_name"],
  ["{{ entry.attendee.email }}", "attendee_email"],
  ["{{ entry.attendee.phone }}", "attendee_phone"],
  ["{{ entry.attendee.address }}", "attendee_address"],
  [
    "{{ entry.attendee.special_instructions }}",
    "attendee_special_instructions",
  ],
  ["{{ entry.attendee.quantity }}", "entry_attendee_quantity"],
  ["{{ entry.attendee.price_paid | currency }}", "entry_attendee_price_paid"],
  ["{{ entry.attendee.date }}", "entry_attendee_date"],
  ["{{ entry.attendee.date_range_label }}", "entry_attendee_date_range_label"],
  ["{{ entry.attendee.answers }}", "entry_attendee_answers"],
  ["{{ answer.question }}", "answer_question"],
  ["{{ answer.text }}", "answer_text"],
  ['{{ 2 | pluralize: "ticket", "tickets" }}', "pluralize"],
];

/** What templates cannot show. A staged free-text answer is pruned on the
 * payments clock, so a later payment's email leaves it out. */
export const notAvailableNote = (): string =>
  t("settings.advanced.email_variables.not_available", {
    days: PRUNE_PAYMENTS_RETENTION_DAYS,
  });

/** A worked loop over `entries`: one line per booked listing, printing its
 * name, quantity, dates, and price. */
export const LOOP_EXAMPLE = `{% for entry in entries %}
{{ entry.listing.name }}: {{ entry.attendee.quantity }} {{ entry.attendee.quantity | pluralize: "ticket", "tickets" }}, {{ entry.attendee.date_range_label }}, {{ entry.attendee.price_paid | currency }}
{% endfor %}`;

/** A worked loop over `entry.attendee.answers`: one line per question the
 * buyer answered, printing the question and their answer. */
export const ANSWERS_LOOP_EXAMPLE = `{% for entry in entries %}
  {% for answer in entry.attendee.answers %}{{ answer.question }}: {{ answer.text }}
  {% endfor %}{% endfor %}`;
