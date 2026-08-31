import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  PageHeading,
  ProseHeading,
  ProseIntro,
  RawParagraph,
} from "#templates/components/prose-heading.tsx";

describe("prose headings and paragraphs", () => {
  test("ProseHeading renders a top-level heading inside the prose block", () => {
    const html = String(
      <ProseHeading heading="Ticket settings">
        <p>Introduction copy</p>
      </ProseHeading>,
    );
    expect(html).toBe(
      '<div class="prose"><h1>Ticket settings</h1><p>Introduction copy</p></div>',
    );
  });

  test("PageHeading renders the heading alone, for callers that wrap it", () => {
    expect(String(<PageHeading heading="Standalone" />)).toBe(
      "<h1>Standalone</h1>",
    );
  });

  test("RawParagraph wraps one trusted HTML string in a paragraph", () => {
    expect(String(<RawParagraph html="<b>Hi</b>" />)).toBe("<p><b>Hi</b></p>");
  });

  test("ProseIntro renders the paragraph inside the prose block", () => {
    expect(String(<ProseIntro html="<em>Note</em>" />)).toBe(
      '<div class="prose"><p><em>Note</em></p></div>',
    );
  });
});
