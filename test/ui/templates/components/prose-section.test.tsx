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

test("a bare section drops the page-block padding class", () => {
  const html = String(
    <ProseSection bare footer={<pre>Output</pre>} title="Bulk export">
      <p>What the export contains</p>
    </ProseSection>,
  );

  expect(html).toBe(
    '<section><div class="prose"><h2>Bulk export</h2><p>What the export contains</p></div><pre>Output</pre></section>',
  );
});

test("a nested panel can pass a deeper heading tag", () => {
  const html = String(
    <ProseSection headingTag="h4" title="Legend">
      <p>Explains each state</p>
    </ProseSection>,
  );

  expect(html).toBe(
    '<section class="page-block"><div class="prose"><h4>Legend</h4><p>Explains each state</p></div></section>',
  );
});
