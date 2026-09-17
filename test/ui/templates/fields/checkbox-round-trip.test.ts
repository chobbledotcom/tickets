/**
 * Every yes/no control an edit form draws from a stored row. The stored yes
 * must draw the box ticked or the yes option chosen, and the stored no must
 * draw them clear. The check is driven by each real form's own fields, so a
 * yes/no control added to a form is swept along without anyone extending
 * this file.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Field } from "#shared/forms/field.ts";
import { renderFields } from "#shared/forms/rendering.tsx";
import { entityToFieldValues } from "#shared/forms/values.ts";
import { getGroupCreateForm, getGroupForm } from "#templates/fields/group.ts";
import { getListingEditForm } from "#templates/fields/listing.ts";
import { getModifierForm } from "#templates/fields/modifier.ts";
import { allEnglishMessages } from "#test-utils/i18n.ts";

await allEnglishMessages();

/** One yes/no box: a checkbox group whose only offered tick is worth 1.
 * Groups with several options are picked-from lists, not yes/no boxes. */
const isStoredYesNoBox = (field: Field): boolean =>
  field.type === "checkbox-group" &&
  field.options.length === 1 &&
  field.options[0].value === "1";

/** One yes/no select: a dropdown offering both a blank no and a 1-worth
 * yes. Dropdowns for other choices are not yes/no controls. */
const isStoredYesNoSelect = (field: Field): boolean =>
  field.type === "select" &&
  field.options.some((option) => option.value === "") &&
  field.options.some((option) => option.value === "1");

/** Every yes/no control on a form: its boxes and its yes/no dropdowns. */
const storedYesNoControls = (fields: readonly Field[]): readonly Field[] =>
  fields.filter(
    (field) => isStoredYesNoBox(field) || isStoredYesNoSelect(field),
  );

/** The box's own input markup, as the renderer draws it. */
const boxInput = (html: string): string =>
  html.match(/<input type="checkbox"[^>]*>/)?.[0] ?? "";

/** Whether one drawn control shows the yes the row stored. */
const drawnAsYes = (field: Field, html: string): boolean =>
  field.type === "select"
    ? html.includes('value="1" selected')
    : boxInput(html).includes(" checked");

/** The edit forms that draw a stored row, by the name a failure names. The
 * listing view turns every gated box on, so each stored yes/no is drawn. */
const editForms: readonly (readonly [string, readonly Field[]])[] = [
  ["group create", getGroupCreateForm().fields],
  ["group edit", getGroupForm().fields],
  [
    "listing edit",
    getListingEditForm({ builder: true, logistics: true, storage: true })
      .fields,
  ],
  ["modifier edit", getModifierForm().fields],
];

describe("an edit form keeps a stored yes/no", () => {
  for (const [formName, fields] of editForms) {
    test(`every yes/no control on the ${formName} form`, () => {
      const controls = storedYesNoControls(fields);
      // A form with no yes/no controls proves nothing, so each list must
      // keep at least one.
      expect(controls.length).toBeGreaterThan(0);
      for (const field of controls) {
        for (const stored of [true, false]) {
          const row = { [field.name]: stored };
          const values = entityToFieldValues(row, [field], {});
          const drawn = drawnAsYes(field, renderFields([field], values));
          const kept = `${formName} form, ${field.name} stored ${stored}`;
          expect(drawn, kept).toBe(stored);
        }
      }
    });
  }
});
