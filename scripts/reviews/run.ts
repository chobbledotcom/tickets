/** Generate the reviews data module from the one reviews markdown file. */

import { parseReviewsSource } from "#shared/reviews/parse.ts";
import { renderReviewsJson } from "./render.ts";

const SOURCE = "content/reviews.md";
const OUTPUT = "src/shared/reviews.generated.json";

const source = await Deno.readTextFile(SOURCE);
const page = parseReviewsSource(SOURCE, source);
await Deno.writeTextFile(OUTPUT, renderReviewsJson(source, page));
console.log(`Reviews generated: ${page.reviews.length} review(s)`);
