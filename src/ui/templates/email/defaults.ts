/**
 * Default Liquid email templates
 * These are the built-in templates used when the admin has not customised them.
 */

import type { EmailContent } from "#templates/email/shared.ts";
import type { EmailTemplateType } from "#types";

/** A site-plan row names the booked months instead of a ticket count. */
const PLAN_MONTHS_LIQUID = `{{ entry.attendee.quantity_months }} {{ entry.attendee.quantity_months | pluralize: "month of service", "months of service" }}`;

/** The HTML qty cell names a site-plan row's months; a ticket row keeps the
 * bare count its Qty header gives. The comparison is explicit: Liquid reads
 * a plain 0 as true, like Ruby. */
const QTY_CELL_LIQUID = `{% if entry.attendee.quantity_months > 0 %}${PLAN_MONTHS_LIQUID}{% else %}{{ entry.attendee.quantity }}{% endif %}`;

/** The text row states a unit, since it has no Qty header: months of service
 * for a site-plan row, tickets for every other row. */
const TEXT_ROW_QUANTITY_LIQUID = `{% if entry.attendee.quantity_months > 0 %}${PLAN_MONTHS_LIQUID}{% else %}{{ entry.attendee.quantity }} {{ entry.attendee.quantity | pluralize: "ticket", "tickets" }}{% endif %}`;

export const DEFAULT_CONFIRMATION_SUBJECT =
  "Your tickets for {{ listing_names }}";

export const DEFAULT_CONFIRMATION_HTML = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2>Thanks for registering!</h2>
<p>You're confirmed for <strong>{{ listing_names }}</strong>.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:8px">Listing</th><th style="padding:8px">Qty</th><th style="padding:8px">Price</th></tr>
{% for entry in entries %}<tr><td>{{ entry.listing.name }}{% if entry.attendee.date %} <small>({{ entry.attendee.date }})</small>{% endif %}</td><td style="text-align:center">${QTY_CELL_LIQUID}</td><td style="text-align:center">{% if entry.listing.is_paid %}{{ entry.attendee.price_paid | currency }}{% endif %}</td></tr>
{% endfor %}</table>
{% if amount_owed != "0" %}<p><strong>Amount owed:</strong> {{ amount_owed | currency }}</p>
{% endif %}<p><a href="{{ ticket_url }}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:4px">View your tickets</a></p>
<p style="color:#666;font-size:14px">Or copy this link: {{ ticket_url }}</p>
</div>`;

export const DEFAULT_CONFIRMATION_TEXT = `Thanks for registering!

You're confirmed for {{ listing_names }}.

{% for entry in entries %}{{ entry.listing.name }}{% if entry.attendee.date %} ({{ entry.attendee.date }}){% endif %}: ${TEXT_ROW_QUANTITY_LIQUID}{% if entry.listing.is_paid %} — {{ entry.attendee.price_paid | currency }}{% endif %}
{% endfor %}{% if amount_owed != "0" %}Amount owed: {{ amount_owed | currency }}
{% endif %}
View your tickets: {{ ticket_url }}`;

export const DEFAULT_ADMIN_SUBJECT =
  "New registration: {{ attendee.name }} for {{ listing_names }}";

export const DEFAULT_ADMIN_HTML = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2>New registration</h2>
<ul style="list-style:none;padding:0">
<li>Name: {{ attendee.name }}</li>
{% if attendee.email != "" %}<li>Email: {{ attendee.email }}</li>{% endif %}
{% if attendee.phone != "" %}<li>Phone: {{ attendee.phone }}</li>{% endif %}
{% if attendee.address != "" %}<li>Address: {{ attendee.address }}</li>{% endif %}
{% if attendee.special_instructions != "" %}<li>Notes: {{ attendee.special_instructions }}</li>{% endif %}
</ul>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:8px">Listing</th><th style="padding:8px">Qty</th><th style="padding:8px">Price</th></tr>
{% for entry in entries %}<tr><td>{{ entry.listing.name }}{% if entry.attendee.date %} <small>({{ entry.attendee.date }})</small>{% endif %}</td><td style="text-align:center">${QTY_CELL_LIQUID}</td><td style="text-align:center">{% if entry.listing.is_paid %}{{ entry.attendee.price_paid | currency }}{% endif %}</td></tr>
{% endfor %}</table>
{% if amount_owed != "0" %}<p><strong>Amount owed:</strong> {{ amount_owed | currency }}</p>
{% endif %}</div>`;

export const DEFAULT_ADMIN_TEXT = `New registration

Name: {{ attendee.name }}
{% if attendee.email != "" %}Email: {{ attendee.email }}
{% endif %}{% if attendee.phone != "" %}Phone: {{ attendee.phone }}
{% endif %}{% if attendee.address != "" %}Address: {{ attendee.address }}
{% endif %}{% if attendee.special_instructions != "" %}Notes: {{ attendee.special_instructions }}
{% endif %}
{% for entry in entries %}{{ entry.listing.name }}{% if entry.attendee.date %} ({{ entry.attendee.date }}){% endif %}: ${TEXT_ROW_QUANTITY_LIQUID}{% if entry.listing.is_paid %} — {{ entry.attendee.price_paid | currency }}{% endif %}
{% endfor %}{% if amount_owed != "0" %}Amount owed: {{ amount_owed | currency }}
{% endif %}`;

/** Map of template type to default templates */
export const DEFAULT_TEMPLATES = {
  admin: {
    html: DEFAULT_ADMIN_HTML,
    subject: DEFAULT_ADMIN_SUBJECT,
    text: DEFAULT_ADMIN_TEXT,
  },
  confirmation: {
    html: DEFAULT_CONFIRMATION_HTML,
    subject: DEFAULT_CONFIRMATION_SUBJECT,
    text: DEFAULT_CONFIRMATION_TEXT,
  },
} as const satisfies Record<EmailTemplateType, EmailContent>;
