/**
 * Admin email template settings routes - save and preview custom email templates
 * Owner-only access enforced via settingsHandler / withAuth
 */

import { MAX_EMAIL_TEMPLATE_LENGTH } from "#db/settings/constants.ts";
import { settings } from "#db/settings.ts";
import { settingsHandler } from "#routes/admin/settings-helpers.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { formPost, OWNER_FORM } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import {
  buildTemplateData,
  renderTemplate,
  validateTemplate,
} from "#shared/email-renderer.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import type { EmailContent } from "#templates/email/shared.ts";
import {
  type EmailTemplateType,
  isEmailTemplateFormat,
  isEmailTemplateType,
} from "#types";

/** Handle POST /admin/settings/email-templates/:type - save custom email templates */
const validateTemplateFields = ({
  subject,
  html,
  text,
}: EmailContent): string | null => {
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
  return settingsHandler<EmailContent>({
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

/** Render an email template with sample data (owner-only preview). */
const renderEmailTemplatePreview = async (
  form: FormParams,
): Promise<Response> => {
  const type = form.getString("type");
  const template = form.getString("template");
  const rawFormat = form.get("format") ?? "html";

  if (!isEmailTemplateType(type)) {
    return apiErrorResponse("Invalid template type");
  }
  if (!isEmailTemplateFormat(rawFormat)) {
    return apiErrorResponse("Invalid template format");
  }
  const format = rawFormat;

  const error = validateTemplate(template);
  if (error) {
    return apiErrorResponse(`Template syntax error: ${error}`);
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
    return apiErrorResponse(String(err));
  }
};

/** Handle POST /admin/settings/email-templates/preview - render template with sample data */
export const handleEmailTemplatePreviewPost: RequestRoute = formPost(
  OWNER_FORM,
)(renderEmailTemplatePreview);
