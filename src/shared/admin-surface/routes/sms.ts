import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getSms", "sms", "GET", "/admin/sms"),
  route("postSms", "sms", "POST", "/admin/sms"),
] as const;
