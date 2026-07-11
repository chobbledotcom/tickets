import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getGroupsByIdDelete", "groups", "GET", "/admin/groups/:id/delete"),
  route("postGroupsByIdDelete", "groups", "POST", "/admin/groups/:id/delete"),
  route("getGroups", "groups", "GET", "/admin/groups"),
  route("getGroupsNew", "groups", "GET", "/admin/groups/new"),
  route("postGroups", "groups", "POST", "/admin/groups"),
  route("postGroupsByIdEdit", "groups", "POST", "/admin/groups/:id/edit"),
  route("getGroupsById", "groups", "GET", "/admin/groups/:id"),
  route("getGroupsByIdByTab", "groups", "GET", "/admin/groups/:id/:tab"),
  route(
    "postGroupsByIdAddListings",
    "groups",
    "POST",
    "/admin/groups/:id/add-listings",
  ),
  route("postGroupsByIdImages", "groups", "POST", "/admin/groups/:id/images"),
  route(
    "postGroupsByIdImagesUpload",
    "groups",
    "POST",
    "/admin/groups/:id/images/upload",
  ),
] as const;
