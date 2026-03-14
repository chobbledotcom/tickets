/**
 * Default Liquid email templates
 * These are the built-in templates used when the admin has not customised them.
 */

export const DEFAULT_CONFIRMATION_SUBJECT =
  `Your tickets for {{ event_names }}`;

export const DEFAULT_CONFIRMATION_HTML =
  `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2>Thanks for registering!</h2>
<p>You're confirmed for <strong>{{ event_names }}</strong>.</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:8px">Event</th><th style="padding:8px">Qty</th><th style="padding:8px">Price</th></tr>
{% for entry in entries %}<tr><td>{{ entry.event.name }}{% if entry.attendee.date %} <small>({{ entry.attendee.date }})</small>{% endif %}</td><td style="text-align:center">{{ entry.attendee.quantity }}</td><td style="text-align:center">{% if entry.event.is_paid %}{{ entry.attendee.price_paid | currency }}{% endif %}</td></tr>
{% endfor %}</table>
<p><a href="{{ ticket_url }}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:4px">View your tickets</a></p>
<p style="color:#666;font-size:14px">Or copy this link: {{ ticket_url }}</p>
</div>`;

export const DEFAULT_CONFIRMATION_TEXT = `Thanks for registering!

You're confirmed for {{ event_names }}.

{% for entry in entries %}{{ entry.event.name }}{% if entry.attendee.date %} ({{ entry.attendee.date }}){% endif %}: {{ entry.attendee.quantity }} {{ entry.attendee.quantity | pluralize: "ticket", "tickets" }}{% if entry.event.is_paid %} — {{ entry.attendee.price_paid | currency }}{% endif %}
{% endfor %}
View your tickets: {{ ticket_url }}`;

export const DEFAULT_ADMIN_SUBJECT =
  `New registration: {{ attendee.name }} for {{ event_names }}`;

export const DEFAULT_ADMIN_HTML =
  `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2>New registration</h2>
<ul style="list-style:none;padding:0">
<li>Name: {{ attendee.name }}</li>
{% if attendee.email != "" %}<li>Email: {{ attendee.email }}</li>{% endif %}
{% if attendee.phone != "" %}<li>Phone: {{ attendee.phone }}</li>{% endif %}
{% if attendee.address != "" %}<li>Address: {{ attendee.address }}</li>{% endif %}
{% if attendee.special_instructions != "" %}<li>Notes: {{ attendee.special_instructions }}</li>{% endif %}
</ul>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:8px">Event</th><th style="padding:8px">Qty</th><th style="padding:8px">Price</th></tr>
{% for entry in entries %}<tr><td>{{ entry.event.name }}{% if entry.attendee.date %} <small>({{ entry.attendee.date }})</small>{% endif %}</td><td style="text-align:center">{{ entry.attendee.quantity }}</td><td style="text-align:center">{% if entry.event.is_paid %}{{ entry.attendee.price_paid | currency }}{% endif %}</td></tr>
{% endfor %}</table>
</div>`;

export const DEFAULT_ADMIN_TEXT = `New registration

Name: {{ attendee.name }}
{% if attendee.email != "" %}Email: {{ attendee.email }}
{% endif %}{% if attendee.phone != "" %}Phone: {{ attendee.phone }}
{% endif %}{% if attendee.address != "" %}Address: {{ attendee.address }}
{% endif %}{% if attendee.special_instructions != "" %}Notes: {{ attendee.special_instructions }}
{% endif %}
{% for entry in entries %}{{ entry.event.name }}{% if entry.attendee.date %} ({{ entry.attendee.date }}){% endif %}: {{ entry.attendee.quantity }} {{ entry.attendee.quantity | pluralize: "ticket", "tickets" }}{% if entry.event.is_paid %} — {{ entry.attendee.price_paid | currency }}{% endif %}
{% endfor %}`;

/** Map of template type to default templates */
export const DEFAULT_TEMPLATES = {
  confirmation: {
    subject: DEFAULT_CONFIRMATION_SUBJECT,
    html: DEFAULT_CONFIRMATION_HTML,
    text: DEFAULT_CONFIRMATION_TEXT,
  },
  admin: {
    subject: DEFAULT_ADMIN_SUBJECT,
    html: DEFAULT_ADMIN_HTML,
    text: DEFAULT_ADMIN_TEXT,
  },
} as const;
