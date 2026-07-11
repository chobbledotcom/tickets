import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getHistoryByHmac", "contactHistory", "GET", "/admin/history/:hmac"),
  route("postHistoryByHmac", "contactHistory", "POST", "/admin/history/:hmac"),
] as const;
