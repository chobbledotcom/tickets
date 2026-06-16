/**
 * Modifiers table operations.
 *
 * Modifiers are owner-defined price rules (surcharges, discounts, add-ons).
 * There are typically only a handful, they are read on admin pages, and
 * (for now) nothing reads them on the hot public path, so this layer talks to
 * the table directly without a cache.
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import {
  defineIdTable,
  encryptedNameSchema,
} from "#shared/db/common-schema.ts";
import { queryAndMap } from "#shared/db/query.ts";
import { col } from "#shared/db/table.ts";
import type { CalcKind, ModifierDirection } from "#shared/price-modifier.ts";
import type { Modifier } from "#shared/types.ts";

/** Modifier input fields for create/update (camelCase, mapped to columns). */
export type ModifierInput = {
  name: string;
  calcKind: CalcKind;
  calcValue: number;
  direction: ModifierDirection;
};

/** Modifiers table with CRUD operations. Name is encrypted at rest, matching
 * the other owner-defined entities. */
export const modifiersTable = defineIdTable<Modifier, ModifierInput>(
  "modifiers",
  {
    id: col.generated<number>(),
    ...encryptedNameSchema(encrypt, decrypt),
    calc_kind: col.simple<CalcKind>(),
    calc_value: col.simple<number>(),
    direction: col.simple<ModifierDirection>(),
  },
);

/** Execute a query and decrypt the resulting modifier rows. */
const queryModifiers = queryAndMap<Modifier, Modifier>((row) =>
  modifiersTable.fromDb(row),
);

/** Get all modifiers, decrypted, ordered by id. */
export const getAllModifiers = (): Promise<Modifier[]> =>
  queryModifiers("SELECT * FROM modifiers ORDER BY id ASC");
