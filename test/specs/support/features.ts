/**
 * The owner choosing which features their site shows. Every feature here is
 * named the way the settings page prints it — "API keys", not `apiKeys` — so
 * a story reads as the owner's own screen does.
 */

// jscpd:ignore-start

import { execute } from "#db/client.ts";
import { ensureMessageGroups, t } from "#i18n";
import {
  ADMIN_FEATURES,
  type AdminFeatureDefinition,
} from "#shared/admin-features.ts";
import {
  adminPageHtmlAt,
  ORGANISER,
  submitRenderedAdminForm,
} from "#test/specs/support/browser.ts";
import {
  keepWhatTheyWereTold,
  scenarioEnv,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

const SETTINGS_PATH = "/admin/settings";

/** The feature copy, loaded before anything reads it. A step runs outside a
 * request, so nothing has pulled this group in yet and `t` throws rather than
 * guessing at a name. */
const featureCopy = (): Promise<void> => ensureMessageGroups(["features"]);

/** The one feature the site prints under this name. A story naming a feature
 * the site does not have would otherwise open a page that 404s, and the
 * failure would name a missing heading rather than the made-up word. */
export const featureNamed = async (
  printed: string,
): Promise<AdminFeatureDefinition> => {
  await featureCopy();
  const found = ADMIN_FEATURES.find(
    (feature) => t(feature.labelKey) === printed,
  );
  if (!found) throw new Error(`The site has no feature called "${printed}"`);
  return found;
};

/** Every feature's printed name, in the order the settings page lists them. */
export const everyFeatureName = async (): Promise<string[]> => {
  await featureCopy();
  return ADMIN_FEATURES.map((feature) => t(feature.labelKey));
};

/** The address of one feature's own page, as the list should link to it. */
export const linkToFeature = (feature: AdminFeatureDefinition): string =>
  `href="/admin/features/${feature.slug}"`;

const featurePathFor = async (printed: string): Promise<string> =>
  `/admin/features/${(await featureNamed(printed)).slug}`;

/** What one feature's own page says right now. */
export const featurePageHtml = async (
  world: TicketsWorld,
  printed: string,
): Promise<string> => adminPageHtmlAt(world, await featurePathFor(printed));

/** The owner opens one feature's page, keeping what it said so the Then steps
 * read the same page the When opened. */
export const ownerOpensFeature = async (
  world: TicketsWorld,
  printed: string,
): Promise<void> => {
  keepWhatTheyWereTold(world, ORGANISER, await featurePageHtml(world, printed));
};

/** The owner makes one feature's choice through the form the page really
 * serves, so a page that stopped offering the choice fails here. */
export const ownerChoosesFeature =
  (enabled: boolean) =>
  async (world: TicketsWorld, printed: string): Promise<void> => {
    const browser = await submitRenderedAdminForm(
      world,
      await featurePathFor(printed),
      t("features.save"),
      { enabled: String(enabled) },
    );
    keepWhatTheyWereTold(world, ORGANISER, browser.currentHtml);
  };

/** Just the feature list out of the settings page. The page names features
 * elsewhere too, so a word found anywhere on it proves nothing about the
 * list. */
export const featureListOn = (html: string): string => {
  const start = html.indexOf('id="settings-features"');
  if (start < 0) throw new Error("The settings page shows no feature list");
  const end = html.indexOf("</article>", start);
  if (end < 0) throw new Error("The feature list never closes");
  return html.slice(start, end);
};

/** The owner opens their settings, keeping the feature list for the Then
 * steps. */
export const ownerLooksAtSettings = async (
  world: TicketsWorld,
): Promise<void> => {
  const page = await adminPageHtmlAt(world, SETTINGS_PATH);
  keepWhatTheyWereTold(world, ORGANISER, featureListOn(page));
};

/** The word one feature's own row says, read from that row alone. The list's
 * own introduction uses both words, and every other feature has a row of its
 * own, so anything wider than one row answers for the wrong feature. */
export const statusShownFor = async (
  list: string,
  printed: string,
): Promise<string> => {
  const start = list.indexOf(linkToFeature(await featureNamed(printed)));
  if (start < 0) throw new Error(`The list does not offer "${printed}"`);
  const row = list.slice(start, list.indexOf("</tr>", start));
  const enabled = t("features.status.enabled");
  return row.includes(enabled) ? enabled : t("features.status.disabled");
};

/** A saved Modifiers item, which is what puts that feature in use. */
export const saveAModifiersItem = (): Promise<unknown> =>
  execute(
    "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Fee', 'fixed', 1, 'increase')",
  );

/** A site nobody can change anything on, undone when the scenario ends. */
export const keepSiteForReadingOnly = (world: TicketsWorld): void => {
  scenarioEnv(world, { READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
};
