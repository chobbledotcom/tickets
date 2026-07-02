/**
 * Admin email template settings routes - save and preview custom email templates
 * Owner-only access enforced via settingsHandler / withAuth
 */

import { settingsHandler } from "#routes/admin/settings-helpers.ts";
import { OWNER_FORM, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import {
  type EmailTemplateType,
  MAX_EMAIL_TEMPLATE_LENGTH,
  settings,
} from "#shared/db/settings.ts";
import {
  buildTemplateData,
  renderTemplate,
  validateTemplate,
} from "#shared/email-renderer.ts";

/** Valid template types for form submissions — derived from the EmailTemplateType union */
const VALID_TEMPLATE_TYPES: ReadonlySet<EmailTemplateType> =
  new Set<EmailTemplateType>(["confirmation", "admin"]);

/** Type guard: narrows a string to EmailTemplateType after Set membership check */
const isEmailTemplateType = (v: string): v is EmailTemplateType =>
  VALID_TEMPLATE_TYPES.has(v as EmailTemplateType);

/** Handle POST /admin/settings/email-templates/:type - save custom email templates */
type TemplateFormData = { subject: string; html: string; text: string };

const validateTemplateFields = ({
  subject,
  html,
  text,
}: TemplateFormData): string | null => {
  for (const [name, value] of [
    ["subject", subject],
    ["html", html],
    ["text", text],
  ] as const) {
    if (value.length > MAX_EMAIL_TEMPLATE_LENGTH) {
      return `Template ${name} exceeds maximum length of ${MAX_EMAIL_TEMPLATE_LENGTH} characters`;
    }
    if (value) {
      const error = validateTemplate(value);
      if (error) return `Invalid template syntax in ${name}: ${error}`;
    }
  }
  return null;
};

export const handleEmailTemplatePost = (type: EmailTemplateType) => {
  const label = type === "confirmation" ? "Confirmation" : "Admin notification";
  return settingsHandler<TemplateFormData>({
    advanced: true,
    extract: (form) => ({
      html: form.getString("html"),
      subject: form.getString("subject"),
      text: form.getString("text"),
    }),
    formId: `settings-email-tpl-${type}`,
    label: `${label} email template`,
    save: async ({ subject, html, text }) => {
      await Promise.all([
        settings.update.email.template(type, "subject", subject.trim()),
        settings.update.email.template(type, "html", html.trim()),
        settings.update.email.template(type, "text", text.trim()),
      ]);
    },
    validate: validateTemplateFields,
  });
};

/** Sample booking data used for email template previews */
const PREVIEW_BOOKINGS = [
  {
    attendee: {
      address: "123 High Street, London",
      date: null,
      email: "jane@example.com",
      end_date: null,
      id: 1,
      name: "Jane Smith",
      package_group_id: 0,
      payment_id: "pi_sample",
      phone: "+44 7700 900000",
      price_paid: "5000",
      quantity: 2,
      remaining_balance: 0,
      special_instructions: "Wheelchair access please",
      ticket_token: "SAMPLE123",
    },
    listing: {
      active: true,
      assign_built_site: false,
      attendee_count: 42,
      can_pay_more: false,
      customisable_days: false,
      date: "2026-07-15T19:00:00Z",
      day_prices: {},
      duration_days: 1,
      hidden: false,
      id: 1,
      initial_site_months: 0,
      listing_type: "standard" as const,
      location: "Town Hall",
      max_attendees: 100,
      months_per_unit: 0,
      name: "Summer Concert",
      purchase_only: false,
      slug: "summer-concert",
      unit_price: 2500,
      webhook_url: "",
    },
  },
  {
    attendee: {
      address: "123 High Street, London",
      date: "2026-04-15",
      email: "jane@example.com",
      end_date: "2026-04-18",
      id: 2,
      name: "Jane Smith",
      package_group_id: 0,
      payment_id: "",
      phone: "+44 7700 900000",
      price_paid: "0",
      quantity: 1,
      remaining_balance: 0,
      special_instructions: "Wheelchair access please",
      ticket_token: "SAMPLE456",
    },
    listing: {
      active: true,
      assign_built_site: false,
      attendee_count: 8,
      can_pay_more: false,
      customisable_days: false,
      date: "",
      day_prices: {},
      duration_days: 3,
      hidden: false,
      id: 2,
      initial_site_months: 0,
      listing_type: "daily" as const,
      location: "",
      max_attendees: 20,
      months_per_unit: 0,
      name: "Workshop",
      purchase_only: false,
      slug: "workshop",
      unit_price: 0,
      webhook_url: "",
    },
  },
];

const PREVIEW_CURRENCY = "GBP";
const PREVIEW_TICKET_URL = "https://example.com/t/SAMPLE123+SAMPLE456";

/** Handle POST /admin/settings/email-templates/preview - render template with sample data */
export const handleEmailTemplatePreviewPost = (
  request: Request,
): Promise<Response> =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const type = form.getString("type");
    const template = form.getString("template");
    const format = form.get("format") ?? "html";

    if (!isEmailTemplateType(type)) {
      return jsonResponse({ error: "Invalid template type" }, 400);
    }

    const error = validateTemplate(template);
    if (error) {
      return jsonResponse({ error: `Template syntax error: ${error}` }, 400);
    }

    const sampleData = await buildTemplateData(
      PREVIEW_BOOKINGS,
      PREVIEW_CURRENCY,
      PREVIEW_TICKET_URL,
    );

    try {
      const rendered = await renderTemplate(template, sampleData);
      return jsonResponse({ format, rendered });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 400);
    }
  });
