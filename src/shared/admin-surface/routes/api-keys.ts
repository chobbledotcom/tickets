import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getApiKeysByApiKeyIdDelete",
    "apiKeys",
    "GET",
    "/admin/api-keys/:apiKeyId/delete",
  ),
  route(
    "postApiKeysByApiKeyIdDelete",
    "apiKeys",
    "POST",
    "/admin/api-keys/:apiKeyId/delete",
  ),
  route("getApiKeys", "apiKeys", "GET", "/admin/api-keys"),
  route("getApiKeysByApiKeyId", "apiKeys", "GET", "/admin/api-keys/:apiKeyId"),
  route("getApiKeysDocs", "apiKeys", "GET", "/admin/api-keys/docs"),
  route("postApiKeys", "apiKeys", "POST", "/admin/api-keys"),
] as const;
