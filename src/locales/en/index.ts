/**
 * English locale — loads and merges all JSON message files
 */

import admin from "./admin.json" with { type: "json" };
import attendees from "./attendees.json" with { type: "json" };
import backup from "./backup.json" with { type: "json" };
import builder from "./builder.json" with { type: "json" };
import builtSites from "./built-sites.json" with { type: "json" };
import bulkActions from "./bulk-actions.json" with { type: "json" };
import bulkEmail from "./bulk-email.json" with { type: "json" };
import common from "./common.json" with { type: "json" };
import csv from "./csv.json" with { type: "json" };
import datePicker from "./date-picker.json" with { type: "json" };
import debug from "./debug.json" with { type: "json" };
import deliveries from "./deliveries.json" with { type: "json" };
import detailRows from "./detail-rows.json" with { type: "json" };
import errors from "./errors.json" with { type: "json" };
import fields from "./fields.json" with { type: "json" };
import groups from "./groups.json" with { type: "json" };
import guide from "./guide.json" with { type: "json" };
import holidays from "./holidays.json" with { type: "json" };
import listingQr from "./listing-qr.json" with { type: "json" };
import listingsTable from "./listings-table.json" with { type: "json" };
import login from "./login.json" with { type: "json" };
import nav from "./nav.json" with { type: "json" };
import payment from "./payment.json" with { type: "json" };
import publicMessages from "./public.json" with { type: "json" };
import questions from "./questions.json" with { type: "json" };
import settings from "./settings.json" with { type: "json" };
import setup from "./setup.json" with { type: "json" };
import site from "./site.json" with { type: "json" };
import statuses from "./statuses.json" with { type: "json" };
import support from "./support.json" with { type: "json" };
import terms from "./terms.json" with { type: "json" };
import tickets from "./tickets.json" with { type: "json" };
import update from "./update.json" with { type: "json" };
import users from "./users.json" with { type: "json" };

const en: Record<string, string> = {
  ...admin,
  ...attendees,
  ...backup,
  ...builder,
  ...builtSites,
  ...bulkActions,
  ...bulkEmail,
  ...common,
  ...csv,
  ...datePicker,
  ...debug,
  ...deliveries,
  ...detailRows,
  ...errors,
  ...fields,
  ...groups,
  ...guide,
  ...holidays,
  ...listingQr,
  ...listingsTable,
  ...login,
  ...nav,
  ...payment,
  ...publicMessages,
  ...questions,
  ...settings,
  ...setup,
  ...site,
  ...statuses,
  ...support,
  ...terms,
  ...tickets,
  ...update,
  ...users,
};

export default en;
