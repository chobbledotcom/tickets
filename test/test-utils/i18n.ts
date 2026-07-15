import {
  ENGLISH_MESSAGE_LOADERS,
  MESSAGE_GROUPS,
  type MessageGroup,
  type Messages,
} from "#locales/manifest.ts";

/** Build a complete flat English catalog for catalog-wide assertions. */
export const allEnglishMessages = async (
  groups: readonly MessageGroup[] = MESSAGE_GROUPS,
): Promise<Messages> =>
  Object.assign(
    {},
    ...(await Promise.all(
      groups.map((group) => ENGLISH_MESSAGE_LOADERS[group]()),
    )),
  );
