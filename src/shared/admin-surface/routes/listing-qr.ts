import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getListingByIdQrJson",
    "listingQr",
    "GET",
    "/admin/listing/:id/qr.json",
  ),
  route("postListingByIdQr", "listingQr", "POST", "/admin/listing/:id/qr"),
] as const;
