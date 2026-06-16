/**
 * English locale — loads and merges all JSON message files
 */

import admin from "./admin.json" with { type: "json" };
import backup from "./backup.json" with { type: "json" };
import bulkEmail from "./bulk-email.json" with { type: "json" };
import common from "./common.json" with { type: "json" };
import debug from "./debug.json" with { type: "json" };
import errors from "./errors.json" with { type: "json" };
import fields from "./fields.json" with { type: "json" };
import groups from "./groups.json" with { type: "json" };
import guide from "./guide.json" with { type: "json" };
import holidays from "./holidays.json" with { type: "json" };
import login from "./login.json" with { type: "json" };
import nav from "./nav.json" with { type: "json" };
import payment from "./payment.json" with { type: "json" };
import publicMessages from "./public.json" with { type: "json" };
import questions from "./questions.json" with { type: "json" };
import settings from "./settings.json" with { type: "json" };
import setup from "./setup.json" with { type: "json" };
import site from "./site.json" with { type: "json" };
import tickets from "./tickets.json" with { type: "json" };
import unsubscribe from "./unsubscribe.json" with { type: "json" };
import users from "./users.json" with { type: "json" };

const en: Record<string, string> = {
  ...common,
  ...nav,
  ...publicMessages,
  ...tickets,
  ...payment,
  ...setup,
  ...login,
  ...admin,
  ...settings,
  ...users,
  ...groups,
  ...holidays,
  ...questions,
  ...site,
  ...errors,
  ...debug,
  ...fields,
  ...guide,
  ...backup,
  ...bulkEmail,
  ...unsubscribe,
};

export default en;
