/**
 * The built-in Markdown body for an invoice.
 *
 * The create page fills this template with the booking's facts and hands the
 * text to the operator to edit. The create step renders it once and stores the
 * output, so the invoice keeps the prices and lines it billed even after the
 * booking changes.
 *
 * The body owns the invoice's headings. The public page adds none of its own,
 * so an invoice shows its number once.
 */

export const INVOICE_BODY_TEMPLATE = `# {{ labels.heading }}

{{ invoice.date }}

{{ customer.name }}
{{ customer.email }}

| {{ labels.item }} | {{ labels.quantity }} |
| --- | --- |
{% for line in lines %}| {{ line.name }} | {{ line.quantity }} |
{% endfor %}

{{ labels.total }}: {{ totals.total | currency }}

{{ labels.paid }}: {{ totals.paid | currency }}

**{{ labels.due }}: {{ totals.due | currency }}**`;
