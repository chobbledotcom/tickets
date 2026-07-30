import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";

// The question form's hint renders copy at module load, so the group must be
// in place before the route module is imported — as the area loader
// guarantees in production.
await ensureMessageGroups(["common"]);
const { answerTextForm, questionTextForm } = await import(
  "#routes/admin/questions/forms.ts"
);

// Focused rendering coverage for the two question/answer forms, kept in its own
// small file so mutation runs over questions.ts only have to execute these
// cases (not the whole admin-questions template suite) per mutant.
describe("question/answer form field rendering", () => {
  test("questionTextForm renders the markdown text field with its placeholder", () => {
    const html = questionTextForm.render();
    expect(html).toContain("Question text");
    expect(html).toContain("<textarea");
    expect(html).toContain('placeholder="e.g. What is your T-shirt size?"');
    // markdown: true enables the in-editor preview hook
    expect(html).toContain("data-markdown-preview");
  });

  test("questionTextForm renders the display-type select with mapped labels", () => {
    const html = questionTextForm.render();
    expect(html).toContain("Display as");
    expect(html).toContain("<select");
    // Each stored value maps to its own human label; a swapped ternary arm or
    // flipped === would mislabel one of these.
    expect(html).toContain('<option value="radio">Radio buttons</option>');
    expect(html).toContain('<option value="select">Select box</option>');
    expect(html).toContain('<option value="free_text">Free text</option>');
  });

  test("answerTextForm renders a text input with its placeholder", () => {
    const html = answerTextForm.render();
    expect(html).toContain('type="text"');
    expect(html).toContain('placeholder="e.g. Medium"');
  });
});
