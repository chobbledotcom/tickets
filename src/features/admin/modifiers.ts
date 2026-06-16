/**
 * Admin price-modifier management routes — accessible to owners and managers.
 */

import { createCrudHandlers } from "#routes/admin/owner-crud.ts";
import {
  getAllModifiers,
  type ModifierInput,
  modifiersTable,
} from "#shared/db/modifiers.ts";
import {
  type CalcKind,
  isCalcKind,
  isModifierDirection,
  type ModifierDirection,
  validateCalcValue,
} from "#shared/price-modifier.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import type { Modifier } from "#shared/types.ts";
import {
  adminModifierDeletePage,
  adminModifierEditPage,
  adminModifierNewPage,
  adminModifiersPage,
} from "#templates/admin/modifiers.tsx";
import type { ModifierFormValues } from "#templates/fields.ts";
import { modifierFields } from "#templates/fields.ts";

/** Build modifier input from validated form values. The value is stored as the
 * positive magnitude the owner typed; converting it to the signed engine value
 * happens where modifiers are applied to a checkout. */
const extractModifierInput = (values: ModifierFormValues): ModifierInput => ({
  active: values.active === "1",
  calcKind: values.calc_kind as CalcKind,
  calcValue: values.calc_value,
  direction: values.direction as ModifierDirection,
  name: values.name,
});

/** Validate a modifier's kind, direction, and value (the select options can be
 * bypassed by a crafted POST, so re-check membership here). */
const validateModifier = (input: ModifierInput): Promise<string | null> => {
  if (!isCalcKind(input.calcKind)) {
    return Promise.resolve("Invalid modifier type");
  }
  if (!isModifierDirection(input.direction)) {
    return Promise.resolve("Invalid direction");
  }
  return Promise.resolve(validateCalcValue(input.calcKind, input.calcValue));
};

const modifiersResource = defineNamedResource<
  Modifier,
  ModifierInput,
  number,
  ModifierFormValues
>({
  fields: modifierFields,
  nameField: "name",
  table: modifiersTable,
  toInput: extractModifierInput,
  validate: validateModifier,
});

const crud = createCrudHandlers({
  getAll: getAllModifiers,
  getName: (m: Modifier) => m.name,
  listPath: "/admin/modifiers",
  renderDelete: adminModifierDeletePage,
  renderEdit: adminModifierEditPage,
  renderList: adminModifiersPage,
  renderNew: adminModifierNewPage,
  resource: modifiersResource,
  singular: "Modifier",
});

/** Modifier routes */
export const modifiersRoutes = { ...crud.routes };
