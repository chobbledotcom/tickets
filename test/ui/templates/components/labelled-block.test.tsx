import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { LabelledBlock } from "#templates/components/labelled-block.tsx";

describe("LabelledBlock", () => {
  test("puts the bold label line above the block", () => {
    const html = String(
      <LabelledBlock label="Fields:">
        <pre>body</pre>
      </LabelledBlock>,
    );

    expect(html).toBe("<p><strong>Fields:</strong></p><pre>body</pre>");
  });
});
