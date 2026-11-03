/**
 * The built-in Liquid body for an invoice.
 *
 * The create route renders this once and stores the output, so the invoice
 * keeps the prices and lines it billed even after the booking changes.
 */

export const INVOICE_BODY_TEMPLATE = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2>{{ labels.heading }}</h2>
<p>{{ invoice.date }}</p>
<p>{{ customer.name }}<br>{{ customer.email }}</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
<tr style="border-bottom:1px solid #ddd"><th style="text-align:left;padding:8px">{{ labels.item }}</th><th style="padding:8px">{{ labels.quantity }}</th></tr>
{% for line in lines %}<tr><td style="padding:8px">{{ line.name }}</td><td style="text-align:center;padding:8px">{{ line.quantity }}</td></tr>
{% endfor %}</table>
<p>{{ labels.total }}: {{ totals.total | currency }}</p>
<p>{{ labels.paid }}: {{ totals.paid | currency }}</p>
<p><strong>{{ labels.due }}: {{ totals.due | currency }}</strong></p>
</div>`;
