import type { BlindIndex } from "#crypto/sealed.ts";

/** The name and slug pair that every listing and group write carries. */
export interface CatalogInput {
  name: string;
  slug: string;
  slugIndex: BlindIndex;
}
