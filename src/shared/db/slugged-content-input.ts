/** The create/update fields shared by every slugged content record: its slug,
 * its name, and the optional SEO meta and main content. Site pages and news
 * posts both use it. Each table adds its own extra fields on top. The write
 * computes the slug blind index. */
export type SluggedContentInput = {
  slug: string;
  name: string;
  metaTitle?: string;
  metaDescription?: string;
  content?: string;
};

/** The columns of the shared content fields. */
export const contentValues = (input: Required<SluggedContentInput>) => ({
  content: input.content,
  metaDescription: input.metaDescription,
  metaTitle: input.metaTitle,
  name: input.name,
  slug: input.slug,
});
