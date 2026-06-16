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
import type {
  CalcKind,
  ModifierDirection,
  ModifierScope,
  ModifierTrigger,
} from "#shared/price-modifier.ts";
import type { Modifier } from "#shared/types.ts";

/** Modifier input fields for create/update (camelCase, mapped to columns). */
export type ModifierInput = {
  name: string;
  calcKind: CalcKind;
  calcValue: number;
  direction: ModifierDirection;
  active?: boolean;
};

/** Modifiers table with CRUD operations. Name is encrypted at rest, matching
 * the other owner-defined entities. Behavioural columns (active, trigger,
 * scope, min_subtotal) have sensible defaults so the base create form need
 * only supply the pricing rule; later admin fields populate the rest. */
export const modifiersTable = defineIdTable<Modifier, ModifierInput>(
  "modifiers",
  {
    id: col.generated<number>(),
    ...encryptedNameSchema(encrypt, decrypt),
    active: col.boolean(true),
    calc_kind: col.simple<CalcKind>(),
    calc_value: col.simple<number>(),
    direction: col.simple<ModifierDirection>(),
    min_subtotal: col.withDefault(() => 0),
    scope: col.withDefault<ModifierScope>(() => "all"),
    trigger: col.withDefault<ModifierTrigger>(() => "automatic"),
  },
);

/** Execute a query and decrypt the resulting modifier rows. */
const queryModifiers = queryAndMap<Modifier, Modifier>((row) =>
  modifiersTable.fromDb(row),
);

/** Get all modifiers, decrypted, ordered by id. */
export const getAllModifiers = (): Promise<Modifier[]> =>
  queryModifiers("SELECT * FROM modifiers ORDER BY id ASC");

/** Get the active modifiers, decrypted, ordered by id. */
export const getActiveModifiers = (): Promise<Modifier[]> =>
  queryModifiers("SELECT * FROM modifiers WHERE active = 1 ORDER BY id ASC");
