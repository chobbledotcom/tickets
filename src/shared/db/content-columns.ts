import {
  encryptedNameSchema,
  encryptedSeoContentSchema,
} from "#db/common-schema.ts";

/**
 * The encrypted name + SEO/content columns shared by every content table (news
 * posts, site pages). One merged column set so the two spreads live in a single
 * place rather than being repeated at each `defineIdTable` call.
 */
export const encryptedNameAndSeoSchema = (
  ...args: Parameters<typeof encryptedNameSchema>
): ReturnType<typeof encryptedNameSchema> &
  ReturnType<typeof encryptedSeoContentSchema> => ({
  ...encryptedNameSchema(...args),
  ...encryptedSeoContentSchema(...args),
});
