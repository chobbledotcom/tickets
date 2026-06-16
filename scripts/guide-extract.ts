/**
 * guide-extract — render the current guide and capture each FAQ's exact answer
 * HTML, so the answers can move into locale keys (guide.a.*) and be rendered via
 * <Raw> through a <Faq> helper with byte-identical output.
 *
 * Only "strict pattern" FAQs are captured: <Q> whose answer JSX is static
 * (contains no { expression } — no t(), conditionals, or interpolation). Those
 * collapse to <Faq id />. Dynamic answers are reported and left as manual <Q>.
 *
 * Output: .i18n-work/guide-keys.json (new guide.q.* / guide.a.* keys) and
 *         .i18n-work/guide-faqs.json (ordered [{id, static, keyed}] for the
 *          rewrite step), plus a summary to stdout.
 *
 * Usage: deno run -A scripts/guide-extract.ts
 */

import en from "#locales/en/index.ts";
import { adminGuidePage } from "#templates/admin/guide.tsx";

const messages = en as Record<string, string>;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// Render with owner + a fully-populated host config so every conditional
// section is present.
const hostConfig = {
  builderEnabled: true,
  bunnyDnsSubdomainSuffix: ".tickets",
  hostAppleWalletPassTypeId: "pass.com.example.tickets",
  hostEmailFromAddress: "tickets@example.com",
  hostEmailProvider: "resend",
  hostGoogleWalletIssuerId: "1234567890",
};
const html = adminGuidePage({ adminLevel: "owner" }, hostConfig);

// question text -> answer HTML, from the render
const rendered = new Map<string, string>();
for (const m of html.matchAll(
  /<details><summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g,
)) {
  rendered.set(norm(m[1]), m[2].trim());
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .slice(0, 7)
    .join("_");

const src = Deno.readTextFileSync("src/ui/templates/admin/guide.tsx");
const newKeys: Record<string, string> = {};
const faqs: {
  id: string;
  keyed: boolean;
  static: boolean;
  matched: boolean;
}[] = [];
let total = 0;
let staticCount = 0;
let matched = 0;
const unmatched: string[] = [];

// <Q q={t("guide.q.X")}>…</Q>  or  <Q q="literal">…</Q>
const Q_RE = /<Q\s+q=(?:\{t\("([^"]+)"\)\}|"([^"]+)")\s*>([\s\S]*?)<\/Q>/g;
for (const m of src.matchAll(Q_RE)) {
  total++;
  const qKey = m[1]; // e.g. guide.q.create_listing
  const literal = m[2];
  const answerSrc = m[3];
  const isStatic = !answerSrc.includes("{");
  if (isStatic) staticCount++;

  const question = qKey ? (messages[qKey] ?? "") : (literal ?? "");
  const id = qKey ? qKey.replace(/^guide\.q\./, "") : slug(literal ?? "");
  const answerHtml = rendered.get(norm(question));

  faqs.push({ id, keyed: !!qKey, matched: !!answerHtml, static: isStatic });
  if (!isStatic) continue;
  if (!answerHtml) {
    unmatched.push(question.slice(0, 60));
    continue;
  }
  matched++;
  if (!qKey) newKeys[`guide.q.${id}`] = question; // literal Q needs a q key too
  newKeys[`guide.a.${id}`] = answerHtml;
}

Deno.mkdirSync(".i18n-work", { recursive: true });
Deno.writeTextFileSync(
  ".i18n-work/guide-keys.json",
  `${JSON.stringify(newKeys, null, 2)}\n`,
);
Deno.writeTextFileSync(
  ".i18n-work/guide-faqs.json",
  `${JSON.stringify(faqs, null, 2)}\n`,
);

console.log(`total <Q>: ${total}`);
console.log(`static (strict pattern): ${staticCount}`);
console.log(`matched (answer captured): ${matched}`);
console.log(`dynamic (left manual): ${total - staticCount}`);
console.log(`new keys authored: ${Object.keys(newKeys).length}`);
console.log(`unmatched static (render not found): ${unmatched.length}`);
for (const u of unmatched.slice(0, 10)) console.log(`  ? ${u}`);
