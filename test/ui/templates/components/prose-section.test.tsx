import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ProseSection } from "#templates/components/prose-section.tsx";

test("renders its title, prose, and footer in a semantic page block", () => {
  const html = String(
    <ProseSection footer={<form>Controls</form>} title="Details">
      <p>Introduction</p>
    </ProseSection>,
  );

  expect(html).toBe(
    '<section class="page-block"><div class="prose"><h2>Details</h2><p>Introduction</p></div><form>Controls</form></section>',
  );
});
