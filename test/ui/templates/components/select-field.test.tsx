import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  SelectField,
  type SelectOption,
} from "#templates/components/select-field.tsx";

const opts = (...pairs: [value: string, label: string][]): SelectOption[] =>
  pairs.map(([value, label]) => ({ label, value }));

describe("SelectField", () => {
  test("renders one <option> per choice, in order, selecting the matching value", () => {
    const html = String(
      SelectField({
        name: "agent",
        options: opts(["a", "Alpha"], ["b", "Bravo"], ["c", "Charlie"]),
        value: "b",
      }),
    );
    expect(html).toBe(
      '<select name="agent">' +
        '<option value="a">Alpha</option>' +
        '<option selected value="b">Bravo</option>' +
        '<option value="c">Charlie</option>' +
        "</select>",
    );
  });

  test("selects the empty-value option when the current value is ''", () => {
    // The documented contract: pass value "" so the same === comparison marks
    // the leading "none"/empty choice as selected.
    const html = String(
      SelectField({
        name: "agent",
        options: opts(["", "None"], ["a", "Alpha"]),
        value: "",
      }),
    );
    expect(html).toBe(
      '<select name="agent">' +
        '<option selected value="">None</option>' +
        '<option value="a">Alpha</option>' +
        "</select>",
    );
  });

  test("marks no option selected when no value matches", () => {
    const html = String(
      SelectField({
        name: "agent",
        options: opts(["a", "Alpha"], ["b", "Bravo"]),
        value: "zzz",
      }),
    );
    expect(html).toBe(
      '<select name="agent">' +
        '<option value="a">Alpha</option>' +
        '<option value="b">Bravo</option>' +
        "</select>",
    );
    expect(html).not.toContain("selected");
  });

  test("selects exactly one option — the empty value does not match a non-empty one", () => {
    // Guards the strict comparison: value "" must not select value "a".
    const html = String(
      SelectField({
        name: "agent",
        options: opts(["a", "Alpha"]),
        value: "",
      }),
    );
    expect(html).toBe(
      '<select name="agent"><option value="a">Alpha</option></select>',
    );
  });

  test("adds the id attribute (before name) when an id is given", () => {
    const html = String(
      SelectField({
        id: "agent-sel",
        name: "agent",
        options: opts(["a", "Alpha"]),
        value: "a",
      }),
    );
    expect(html).toBe(
      '<select id="agent-sel" name="agent">' +
        '<option selected value="a">Alpha</option>' +
        "</select>",
    );
  });

  test("omits the id attribute when no id is given", () => {
    const html = String(
      SelectField({
        name: "agent",
        options: opts(["a", "Alpha"]),
        value: "a",
      }),
    );
    expect(html).toBe(
      '<select name="agent"><option selected value="a">Alpha</option></select>',
    );
    expect(html).not.toContain("id=");
  });

  test("renders an empty <select> when there are no options", () => {
    const html = String(SelectField({ name: "agent", options: [], value: "" }));
    expect(html).toBe('<select name="agent"></select>');
  });
});
