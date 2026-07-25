import {
  AstBuilder,
  GherkinClassicTokenMatcher,
  Parser,
} from "@cucumber/gherkin";
import type { GherkinDocument } from "@cucumber/messages";
import { invalidSpec } from "./errors.ts";
import type { SpecSource } from "./types.ts";

const parseErrorLine = (message: string): number => {
  // Gherkin parser errors always include their first `(line:column)` location.
  return Number(message.replace(/^[\s\S]*?\((\d+):\d+\)[\s\S]*$/, "$1"));
};

export const parseGherkinSource = (
  source: SpecSource,
  newId: () => string,
): GherkinDocument => {
  try {
    const parser = new Parser(
      new AstBuilder(newId),
      new GherkinClassicTokenMatcher(),
    );
    const document = parser.parse(source.data);
    document.uri = source.uri;
    return document;
  } catch (error) {
    const message = String(error);
    return invalidSpec(source.uri, parseErrorLine(message), message);
  }
};
