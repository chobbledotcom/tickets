import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getImages", "images", "GET", "/admin/images"),
  route("getImagesByIdDelete", "images", "GET", "/admin/images/:id/delete"),
  route("getImagesByIdEdit", "images", "GET", "/admin/images/:id/edit"),
  route("getImagesNew", "images", "GET", "/admin/images/new"),
  route("postImages", "images", "POST", "/admin/images"),
  route("postImagesByIdDelete", "images", "POST", "/admin/images/:id/delete"),
  route("postImagesByIdEdit", "images", "POST", "/admin/images/:id/edit"),
] as const;
