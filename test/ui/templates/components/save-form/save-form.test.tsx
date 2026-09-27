import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SaveForm } from "#templates/components/save-form.tsx";

test("disables the submit button when told to", () => {
  const html = String(
    <SaveForm action="/x" disabled submitIcon="save" submitLabel="Save" />,
  );
  expect(html).toContain('<button disabled type="submit">');
});

test("keeps the submit button enabled without disabled", () => {
  const html = String(
    <SaveForm action="/x" submitIcon="save" submitLabel="Save" />,
  );
  expect(html).toContain('<button type="submit">');
});

test("passes the submit class through to the button", () => {
  const html = String(
    <SaveForm
      action="/x"
      submitClass="danger"
      submitIcon="save"
      submitLabel="Delete"
    />,
  );
  expect(html).toContain('<button class="danger" type="submit">');
});
