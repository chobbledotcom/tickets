import { bracket } from "#fp";
import { addMessageGroup, ensureMessageGroups, resetI18nForTest } from "#i18n";
import {
  ENGLISH_MESSAGE_LOADERS,
  MESSAGE_GROUPS,
  type MessageGroup,
  type Messages,
} from "#locales/manifest.ts";

/** Build a complete flat English catalog for catalog-wide assertions. */
export const allEnglishMessages = async (
  groups: readonly MessageGroup[] = MESSAGE_GROUPS,
): Promise<Messages> => {
  const messages = new Map<string, string>();
  const owners = new Map<string, MessageGroup>();
  const catalogs = await Promise.all(
    groups.map(async (group) => ({
      group,
      messages: await ENGLISH_MESSAGE_LOADERS[group](),
    })),
  );
  for (const catalog of catalogs) {
    addMessageGroup(messages, owners, catalog.group, catalog.messages);
  }
  return Object.fromEntries(messages);
};

/** Run with only system copy loaded, then restore the complete test catalog. */
export const withColdMessages: (run: () => Promise<void>) => Promise<void> =
  bracket(
    () => resetI18nForTest(true),
    () => ensureMessageGroups(MESSAGE_GROUPS),
  );
