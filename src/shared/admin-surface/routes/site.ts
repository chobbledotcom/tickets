import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getSite", "site", "GET", "/admin/site"),
  route("getSiteContact", "site", "GET", "/admin/site/contact"),
  route("getSiteOrder", "site", "GET", "/admin/site/order"),
  route("postSite", "site", "POST", "/admin/site"),
  route("postSiteContact", "site", "POST", "/admin/site/contact"),
  route("postSiteContactForm", "site", "POST", "/admin/site/contact/form"),
  route("postSiteOrder", "site", "POST", "/admin/site/order"),
  route("postSiteOrderToggle", "site", "POST", "/admin/site/order/toggle"),
] as const;
