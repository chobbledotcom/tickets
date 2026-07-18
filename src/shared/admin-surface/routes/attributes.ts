import { moveRoutes, route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getAttributesByIdDelete",
    "attributes",
    "GET",
    "/admin/attributes/:id/delete",
  ),
  route(
    "postAttributesByIdDelete",
    "attributes",
    "POST",
    "/admin/attributes/:id/delete",
  ),
  route("getAttributes", "attributes", "GET", "/admin/attributes"),
  route("getAttributesById", "attributes", "GET", "/admin/attributes/:id"),
  route(
    "getAttributesByIdOptionsByOptionIdDelete",
    "attributes",
    "GET",
    "/admin/attributes/:id/options/:optionId/delete",
  ),
  route(
    "getAttributesByIdOptionsByOptionIdEdit",
    "attributes",
    "GET",
    "/admin/attributes/:id/options/:optionId/edit",
  ),
  route("postAttributes", "attributes", "POST", "/admin/attributes"),
  route(
    "postAttributesByIdEdit",
    "attributes",
    "POST",
    "/admin/attributes/:id/edit",
  ),
  ...moveRoutes("postAttributesById", "attributes", "/admin/attributes/:id"),
  route(
    "postAttributesByIdOptions",
    "attributes",
    "POST",
    "/admin/attributes/:id/options",
  ),
  route(
    "postAttributesByIdOptionsByOptionIdDelete",
    "attributes",
    "POST",
    "/admin/attributes/:id/options/:optionId/delete",
  ),
  route(
    "postAttributesByIdOptionsByOptionIdEdit",
    "attributes",
    "POST",
    "/admin/attributes/:id/options/:optionId/edit",
  ),
  ...moveRoutes(
    "postAttributesByIdOptionsByOptionId",
    "attributes",
    "/admin/attributes/:id/options/:optionId",
  ),
  route(
    "postListingByIdAttributes",
    "attributes",
    "POST",
    "/admin/listing/:id/attributes",
  ),
] as const;
