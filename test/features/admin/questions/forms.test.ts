import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ensureMessageGroups } from "#i18n";
import { says } from "#test-utils/says.ts";

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
    says(html, "Question text");
    says(html, "<textarea");
    says(html, 'placeholder="e.g. What is your T-shirt size?"');
    // markdown: true enables the in-editor preview hook
    says(html, "data-markdown-preview");
  });

  test("questionTextForm requires both of its fields", () => {
    const html = questionTextForm.render();
    // A question without text, or without a display type, must be refused by
    // the browser itself — dropping either `required` would let one through.
    expect(html).toMatch(/<textarea[^>]* required>/);
    expect(html).toMatch(/<select[^>]* required>/);
  });

  test("questionTextForm renders the display-type select with mapped labels", () => {
    const html = questionTextForm.render();
    says(html, "Display as");
    says(html, "<select");
    // Each stored value maps to its own human label; a swapped ternary arm or
    // flipped === would mislabel one of these.
    says(html, '<option value="radio">Radio buttons</option>');
    says(html, '<option value="select">Select box</option>');
    says(html, '<option value="free_text">Free text</option>');
  });

  test("answerTextForm renders a text input with its placeholder", () => {
    const html = answerTextForm.render();
    says(html, "Answer text");
    says(html, 'type="text"');
    says(html, 'placeholder="e.g. Medium"');
  });
});
