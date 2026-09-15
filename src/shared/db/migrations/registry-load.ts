/**
 * The registry's shared loader: the entry shape every migration list builds
 * with, and the one constructor that keeps entries uniform.
 */

import type { MigrationBuilder } from "./types.ts";

export type MigrationRegistryEntry = {
  id: string;
  /** Load the module whose default export builds this migration. */
  load: () => Promise<{ default: MigrationBuilder }>;
};

export const entry = (
  id: string,
  load: () => Promise<{ default: MigrationBuilder }>,
): MigrationRegistryEntry => ({ id, load });
