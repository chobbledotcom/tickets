/**
 * The M-Z half of the admin areas table, folded into its routes. A path here
 * is one another module links to, a person types, or a route table binds, so
 * each one is pinned.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { AREAS_M_Z } from "#shared/admin-surface/areas-m-z.ts";
import { foldAdminAreas } from "#shared/admin-surface/definitions.ts";

const { areas, destinations } = foldAdminAreas(AREAS_M_Z);
const routes = Object.values(destinations);

/* jscpd:ignore-start -- a list of strings, not code */
const PATHS = {
  answerAdd: "/admin/questions/:id/answers",
  answerDelete: "/admin/questions/:id/answers/:answerId/delete",
  answerEdit: "/admin/questions/:id/answers/:answerId/edit",
  answerMoveDown: "/admin/questions/:id/answers/:answerId/move-down",
  answerMoveUp: "/admin/questions/:id/answers/:answerId/move-up",
  answerRecalculate: "/admin/questions/:id/answers/:answerId/recalculate",
  doors: "/admin/scanner",
  feature: "/admin/features/:slug",
  groupScan: "/admin/groups/:id/scan",
  groupScanCache: "/admin/groups/:id/scan-cache",
  groupScanner: "/admin/groups/:id/scanner",
  listingDefaults: "/admin/listing-defaults",
  listingScan: "/admin/listing/:id/scan",
  listingScanCache: "/admin/listing/:id/scan-cache",
  listingScanner: "/admin/listing/:id/scanner",
  logistics: "/admin/logistics",
  logisticsAgent: "/admin/logistics/:id",
  logisticsDelete: "/admin/logistics/:id/delete",
  logisticsEdit: "/admin/logistics/:id/edit",
  logisticsNew: "/admin/logistics/new",
  markdownPreview: "/admin/markdown-preview",
  migrateRebuildPayments: "/admin/migrate/rebuild-payment-references",
  modifier: "/admin/modifiers/:id",
  modifierAnswers: "/admin/modifiers/:id/answers",
  modifierDelete: "/admin/modifiers/:id/delete",
  modifierEdit: "/admin/modifiers/:id/edit",
  modifierLinks: "/admin/modifiers/:id/links",
  modifierNew: "/admin/modifiers/new",
  modifierRecalculate: "/admin/modifiers/recalculate/:modifierId",
  modifierRevenue: "/admin/modifiers/:id/revenue",
  modifiers: "/admin/modifiers",
  news: "/admin/site/news",
  newsActions: "/admin/site/news/:id/actions",
  newsDelete: "/admin/site/news/:id/delete",
  newsEdit: "/admin/site/news/:id/edit",
  newsImages: "/admin/site/news/:id/images",
  newsImagesUpload: "/admin/site/news/:id/images/upload",
  newsNew: "/admin/site/news/new",
  newsPost: "/admin/site/news/:id",
  privacy: "/admin/privacy",
  privacyErase: "/admin/privacy/erase",
  privacyOrphans: "/admin/privacy/orphans",
  privacyRefund: "/admin/privacy/refunds/:id",
  question: "/admin/questions/:id",
  questionDelete: "/admin/questions/:id/delete",
  questionEdit: "/admin/questions/:id/edit",
  questionListings: "/admin/questions/:id/listings",
  questionMoveDown: "/admin/questions/:id/move-down",
  questionMoveUp: "/admin/questions/:id/move-up",
  questions: "/admin/questions",
  schemaAtlas: "/admin/schema",
  seeds: "/admin/seeds",
  servicing: "/admin/servicing",
  servicingCost: "/admin/servicing/:id/cost/:costId",
  servicingDelete: "/admin/servicing/:id/delete",
  servicingDuplicate: "/admin/servicing/:id/duplicate",
  servicingEdit: "/admin/servicing/:id",
  servicingNew: "/admin/servicing/new",
  sessions: "/admin/sessions",
  settings: "/admin/settings",
  settingsAddressLookup: "/admin/settings/address-lookup",
  settingsAdvanced: "/admin/settings-advanced",
  settingsAppleWallet: "/admin/settings/apple-wallet",
  settingsAttendeeColumnOrder: "/admin/settings/attendee-column-order",
  settingsBookingFee: "/admin/settings/booking-fee",
  settingsBusinessEmail: "/admin/settings/business-email",
  settingsCalendarFeeds: "/admin/settings/calendar-feeds",
  settingsCustomCss: "/admin/settings/custom-css",
  settingsCustomDomain: "/admin/settings/custom-domain",
  settingsCustomDomainValidate: "/admin/settings/custom-domain/validate",
  settingsEmail: "/admin/settings/email",
  settingsEmailTemplatesAdmin: "/admin/settings/email-templates/admin",
  settingsEmailTemplatesConfirmation:
    "/admin/settings/email-templates/confirmation",
  settingsEmailTest: "/admin/settings/email/test",
  settingsEmbedHosts: "/admin/settings/embed-hosts",
  settingsExternalOrder: "/admin/settings/external-order",
  settingsGoogleWallet: "/admin/settings/google-wallet",
  settingsHeaderImage: "/admin/settings/header-image",
  settingsHeaderImageDelete: "/admin/settings/header-image/delete",
  settingsHostSubdomain: "/admin/settings/host-subdomain",
  settingsListingColumnOrder: "/admin/settings/listing-column-order",
  settingsLogisticsRunSheet: "/admin/settings/logistics-run-sheet",
  settingsPaymentProvider: "/admin/settings/payment-provider",
  settingsPaymentProviderRecovery: "/admin/settings/payment-provider-recovery",
  settingsResetDatabase: "/admin/settings/reset-database",
  settingsShowPublicApi: "/admin/settings/show-public-api",
  settingsSiteFooter: "/admin/settings/site-footer",
  settingsSmsGateway: "/admin/settings/sms-gateway",
  settingsSquare: "/admin/settings/square",
  settingsSquareTest: "/admin/settings/square/test",
  settingsSquareWebhook: "/admin/settings/square-webhook",
  settingsStripe: "/admin/settings/stripe",
  settingsStripeTest: "/admin/settings/stripe/test",
  settingsSumup: "/admin/settings/sumup",
  settingsSumupTest: "/admin/settings/sumup/test",
  settingsSuperuser: "/admin/settings/superuser",
  settingsTax: "/admin/settings/tax",
  settingsTerms: "/admin/settings/terms",
  settingsTheme: "/admin/settings/theme",
  site: "/admin/site",
  siteContact: "/admin/site/contact",
  siteContactFormToggle: "/admin/site/contact/form",
  siteOrder: "/admin/site/order",
  siteOrderToggle: "/admin/site/order/toggle",
  sitePage: "/admin/site/pages/:id",
  sitePageActions: "/admin/site/pages/:id/actions",
  sitePageDelete: "/admin/site/pages/:id/delete",
  sitePageEdit: "/admin/site/pages/:id/edit",
  sitePageImages: "/admin/site/pages/:id/images",
  sitePageImagesUpload: "/admin/site/pages/:id/images/upload",
  sitePageItemMoveDown:
    "/admin/site/pages/:id/items/:itemType/:itemId/move-down",
  sitePageItemMoveUp: "/admin/site/pages/:id/items/:itemType/:itemId/move-up",
  sitePageItemRemove: "/admin/site/pages/:id/items/:itemType/:itemId/remove",
  sitePageItems: "/admin/site/pages/:id/items",
  sitePageMoveDown: "/admin/site/pages/:id/move-down",
  sitePageMoveUp: "/admin/site/pages/:id/move-up",
  sitePageNew: "/admin/site/pages/new",
  sitePages: "/admin/site/pages",
  sms: "/admin/sms",
  status: "/admin/settings/statuses/:id",
  statusDelete: "/admin/settings/statuses/:id/delete",
  statusEdit: "/admin/settings/statuses/:id/edit",
  statuses: "/admin/settings/statuses",
  statusMoveDown: "/admin/settings/statuses/:id/move-down",
  statusMoveUp: "/admin/settings/statuses/:id/move-up",
  statusNew: "/admin/settings/statuses/new",
  support: "/admin/support",
  update: "/admin/update",
  updateCheck: "/admin/update/check",
  user: "/admin/users/:id",
  userAgents: "/admin/users/:id/agents",
  userDelete: "/admin/users/:id/delete",
  userNew: "/admin/users/new",
  users: "/admin/users",
};
/* jscpd:ignore-end */

describe("the M-Z admin areas", () => {
  test("declare each route at its own path", () => {
    expect(
      Object.fromEntries(routes.map((route) => [route.id, route.pattern])),
    ).toEqual(PATHS);
  });

  test("serve each area under the segments its paths name", () => {
    expect(areas).toEqual({
      markdownPreview: ["markdown-preview"],
      migrate: ["migrate"],
      modifiers: ["modifiers"],
      news: ["site"],
      privacy: ["privacy"],
      questions: ["questions", "listing"],
      scanner: ["scanner", "groups", "listing"],
      schemaAtlas: ["schema"],
      seeds: ["seeds"],
      servicing: ["servicing"],
      sessions: ["sessions"],
      settings: [
        "features",
        "listing-defaults",
        "settings",
        "settings-advanced",
      ],
      settingsLogistics: ["logistics"],
      settingsStatuses: ["settings"],
      site: ["site"],
      sitePages: ["site"],
      sms: ["sms"],
      support: ["support"],
      update: ["update"],
      users: ["users"],
    });
  });

  test("keep the scans and the support page open in read-only mode", () => {
    expect(
      routes
        .filter((route) => route.readOnlyWrite !== undefined)
        .map((route) => [route.id, route.readOnlyWrite]),
    ).toEqual([
      ["groupScan", "read-only"],
      ["listingScan", "read-only"],
      ["support", "read-only"],
    ]);
    expect(routes.filter((route) => route.readOnlyGet)).toEqual([]);
  });

  test("land a status save on the status page, and a list save on the list", () => {
    expect(
      routes
        .filter((route) => route.afterSave !== undefined)
        .map((route) => [route.id, route.afterSave]),
    ).toEqual([["statusEdit", "status"]]);
  });

  test("let only the owner see modifier revenue", () => {
    expect(destinations.modifierRevenue?.audience).toEqual(["owner"]);
    expect(destinations.modifierEdit?.audience).toEqual(["owner", "manager"]);
  });

  test("name the record each record area serves", () => {
    expect(AREAS_M_Z.questions.record).toEqual({
      detail: "question",
      list: "questions",
      newPage: false,
      remove: "questionDelete",
    });
    expect(AREAS_M_Z.news.record).toEqual({
      detail: "newsPost",
      list: "news",
      newPage: true,
      remove: "newsDelete",
    });
    expect(AREAS_M_Z.users.record.newPage).toBe(true);
  });
});
