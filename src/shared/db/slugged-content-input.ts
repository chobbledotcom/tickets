import type { BlindIndex } from "#shared/crypto/sealed.ts";

/** The create/update fields shared by every slugged content record (site pages
 * and news posts): its slug and slug blind-index, its name, and the optional
 * SEO meta and main content. Each table adds its own extra fields on top. */
export type SluggedContentInput = {
  slug: string;
  slugIndex: BlindIndex;
  name: string;
  metaTitle?: string;
  metaDescription?: string;
  content?: string;
};
