/**
 * English locale — eagerly loads and merges the JSON message files, EXCEPT the
 * guide bundle.
 *
 * `guide.json` is deliberately NOT merged here: it is by far the largest locale
 * file (~120KB) and its keys are only used by the two guide routes (the admin
 * guide page and the markdown formatting-help page), so merging it at module
 * load would put that weight on every cold boot. It is loaded on demand instead
 * — see `src/locales/en/guide.ts` and `ensureGuideMessages` in
 * `src/shared/guide-messages.ts`, which those routes await before rendering.
 */

import addressLookup from "./address-lookup.json" with { type: "json" };
import admin from "./admin.json" with { type: "json" };
import attendees from "./attendees.json" with { type: "json" };
import attributes from "./attributes.json" with { type: "json" };
import availability from "./availability.json" with { type: "json" };
import backup from "./backup.json" with { type: "json" };
import builder from "./builder.json" with { type: "json" };
import builtSites from "./built-sites.json" with { type: "json" };
import bulkActions from "./bulk-actions.json" with { type: "json" };
import bulkEmail from "./bulk-email.json" with { type: "json" };
import capacity from "./capacity.json" with { type: "json" };
import catalogTransfer from "./catalog-transfer.json" with { type: "json" };
import common from "./common.json" with { type: "json" };
import csv from "./csv.json" with { type: "json" };
import datePicker from "./date-picker.json" with { type: "json" };
import debug from "./debug.json" with { type: "json" };
import deliveries from "./deliveries.json" with { type: "json" };
import detailRows from "./detail-rows.json" with { type: "json" };
import entityPages from "./entity-pages.json" with { type: "json" };
import errors from "./errors.json" with { type: "json" };
import features from "./features.json" with { type: "json" };
import fields from "./fields.json" with { type: "json" };
import groups from "./groups.json" with { type: "json" };
import holidays from "./holidays.json" with { type: "json" };
import images from "./images.json" with { type: "json" };
import listingDefaults from "./listing-defaults.json" with { type: "json" };
import listingQr from "./listing-qr.json" with { type: "json" };
import listingsTable from "./listings-table.json" with { type: "json" };
import login from "./login.json" with { type: "json" };
import logistics from "./logistics.json" with { type: "json" };
import modifiers from "./modifiers.json" with { type: "json" };
import nav from "./nav.json" with { type: "json" };
import news from "./news.json" with { type: "json" };
import notes from "./notes.json" with { type: "json" };
import payment from "./payment.json" with { type: "json" };
import privacy from "./privacy.json" with { type: "json" };
import publicMessages from "./public.json" with { type: "json" };
import questions from "./questions.json" with { type: "json" };
import servicing from "./servicing.json" with { type: "json" };
import settings from "./settings.json" with { type: "json" };
import setup from "./setup.json" with { type: "json" };
import site from "./site.json" with { type: "json" };
import sitePages from "./site-pages.json" with { type: "json" };
import sms from "./sms.json" with { type: "json" };
import statuses from "./statuses.json" with { type: "json" };
import support from "./support.json" with { type: "json" };
import terms from "./terms.json" with { type: "json" };
import tickets from "./tickets.json" with { type: "json" };
import update from "./update.json" with { type: "json" };
import users from "./users.json" with { type: "json" };

const en: Record<string, string> = {
  ...addressLookup,
  ...admin,
  ...attributes,
  ...availability,
  ...attendees,
  ...backup,
  ...builder,
  ...builtSites,
  ...bulkActions,
  ...bulkEmail,
  ...capacity,
  ...catalogTransfer,
  ...common,
  ...csv,
  ...datePicker,
  ...debug,
  ...deliveries,
  ...detailRows,
  ...entityPages,
  ...errors,
  ...fields,
  ...features,
  ...groups,
  ...holidays,
  ...images,
  ...listingDefaults,
  ...listingQr,
  ...listingsTable,
  ...login,
  ...logistics,
  ...modifiers,
  ...nav,
  ...news,
  ...notes,
  ...payment,
  ...privacy,
  ...publicMessages,
  ...questions,
  ...settings,
  ...servicing,
  ...setup,
  ...site,
  ...sitePages,
  ...sms,
  ...statuses,
  ...support,
  ...terms,
  ...tickets,
  ...update,
  ...users,
};

export default en;
