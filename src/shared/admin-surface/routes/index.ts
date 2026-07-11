import * as apiKeys from "#shared/admin-surface/routes/api-keys.ts";
import * as attendeeNotes from "#shared/admin-surface/routes/attendee-notes.ts";
import * as attendeeRefunds from "#shared/admin-surface/routes/attendee-refunds.ts";
import * as attendees from "#shared/admin-surface/routes/attendees.ts";
import * as attributes from "#shared/admin-surface/routes/attributes.ts";
import * as auth from "#shared/admin-surface/routes/auth.ts";
import * as backup from "#shared/admin-surface/routes/backup.ts";
import * as builder from "#shared/admin-surface/routes/builder.ts";
import * as builtSites from "#shared/admin-surface/routes/built-sites.ts";
import * as bulkActions from "#shared/admin-surface/routes/bulk-actions.ts";
import * as bulkEmail from "#shared/admin-surface/routes/bulk-email.ts";
import * as calendar from "#shared/admin-surface/routes/calendar.ts";
import * as catalogTransfer from "#shared/admin-surface/routes/catalog-transfer.ts";
import * as contactHistory from "#shared/admin-surface/routes/contact-history.ts";
import * as dashboard from "#shared/admin-surface/routes/dashboard.ts";
import * as debug from "#shared/admin-surface/routes/debug.ts";
import * as deliveries from "#shared/admin-surface/routes/deliveries.ts";
import * as groups from "#shared/admin-surface/routes/groups.ts";
import * as guide from "#shared/admin-surface/routes/guide.ts";
import * as holidays from "#shared/admin-surface/routes/holidays.ts";
import * as images from "#shared/admin-surface/routes/images.ts";
import * as ledger from "#shared/admin-surface/routes/ledger.ts";
import * as listingQr from "#shared/admin-surface/routes/listing-qr.ts";
import * as listings from "#shared/admin-surface/routes/listings.ts";
import * as markdownPreview from "#shared/admin-surface/routes/markdown-preview.ts";
import * as modifiers from "#shared/admin-surface/routes/modifiers.ts";
import * as news from "#shared/admin-surface/routes/news.ts";
import * as privacy from "#shared/admin-surface/routes/privacy.ts";
import * as questions from "#shared/admin-surface/routes/questions.ts";
import * as scanner from "#shared/admin-surface/routes/scanner.ts";
import * as seeds from "#shared/admin-surface/routes/seeds.ts";
import * as servicing from "#shared/admin-surface/routes/servicing.ts";
import * as sessions from "#shared/admin-surface/routes/sessions.ts";
import * as settings from "#shared/admin-surface/routes/settings.ts";
import * as settingsLogistics from "#shared/admin-surface/routes/settings-logistics.ts";
import * as settingsStatuses from "#shared/admin-surface/routes/settings-statuses.ts";
import * as site from "#shared/admin-surface/routes/site.ts";
import * as sitePages from "#shared/admin-surface/routes/site-pages.ts";
import * as sms from "#shared/admin-surface/routes/sms.ts";
import * as support from "#shared/admin-surface/routes/support.ts";
import * as update from "#shared/admin-surface/routes/update.ts";
import * as users from "#shared/admin-surface/routes/users.ts";

export const ADMIN_ROUTES = [
  ...apiKeys.routes,
  ...attendeeNotes.routes,
  ...attendeeRefunds.routes,
  ...attendees.routes,
  ...attributes.routes,
  ...auth.routes,
  ...backup.routes,
  ...builder.routes,
  ...builtSites.routes,
  ...bulkActions.routes,
  ...bulkEmail.routes,
  ...calendar.routes,
  ...catalogTransfer.routes,
  ...contactHistory.routes,
  ...dashboard.routes,
  ...debug.routes,
  ...deliveries.routes,
  ...groups.routes,
  ...guide.routes,
  ...holidays.routes,
  ...images.routes,
  ...ledger.routes,
  ...listingQr.routes,
  ...listings.routes,
  ...markdownPreview.routes,
  ...modifiers.routes,
  ...news.routes,
  ...privacy.routes,
  ...questions.routes,
  ...scanner.routes,
  ...seeds.routes,
  ...servicing.routes,
  ...sessions.routes,
  ...settings.routes,
  ...settingsLogistics.routes,
  ...settingsStatuses.routes,
  ...site.routes,
  ...sitePages.routes,
  ...sms.routes,
  ...support.routes,
  ...update.routes,
  ...users.routes,
] as const;
