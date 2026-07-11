import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getEmailsTemplatesByIdDelete",
    "bulkEmail",
    "GET",
    "/admin/emails/templates/:id/delete",
  ),
  route(
    "postEmailsTemplatesByIdDelete",
    "bulkEmail",
    "POST",
    "/admin/emails/templates/:id/delete",
  ),
  route("getEmails", "bulkEmail", "GET", "/admin/emails"),
  route("getEmailsPreview", "bulkEmail", "GET", "/admin/emails/preview"),
  route("postEmailsPreview", "bulkEmail", "POST", "/admin/emails/preview"),
  route("postEmailsSend", "bulkEmail", "POST", "/admin/emails/send"),
  route("postEmailsTemplates", "bulkEmail", "POST", "/admin/emails/templates"),
] as const;
