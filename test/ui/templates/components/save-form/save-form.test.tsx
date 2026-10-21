import { assertStringIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import { SaveForm } from "#templates/components/save-form.tsx";

test("disables the submit button when told to", () => {
  const html = String(
    <SaveForm action="/x" disabled submitIcon="save" submitLabel="Save" />,
  );
  assertStringIncludes(html, '<button disabled type="submit">');
});

test("keeps the submit button enabled without disabled", () => {
  const html = String(
    <SaveForm action="/x" submitIcon="save" submitLabel="Save" />,
  );
  assertStringIncludes(html, '<button type="submit">');
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
  assertStringIncludes(html, '<button class="danger" type="submit">');
});
