/**
 * guide-i18n — collapse static FAQ <Q>…</Q> blocks into <Faq id /> and move
 * their answers into guide.a.* locale keys, in a single consistent pass.
 *
 * For each <Q>: render the guide to get the answer's EXACT HTML; keep it only
 * if that HTML is ICU-safe (parses AND formats with no params — excludes
 * answers with interpolation like {minPriceFormatted} or literal braces like
 * {{name}}). Safe ones get a guide.a.<id> key (+ guide.q.<id> for literal
 * questions) and their <Q> becomes <Faq id />. Dynamic answers stay manual.
 *
 * Idempotent-ish: only converts <Q> (never touches existing <Faq>). Verify
 * with a golden-render diff. Usage: deno run -A scripts/guide-i18n.ts
 */

import { IntlMessageFormat } from "intl-messageformat";
import en from "#locales/en/index.ts";
import { adminGuidePage } from "#templates/admin/guide.tsx";

const messages = en as Record<string, string>;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

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

/** ICU-safe = parses and formats with no required params/placeholders. */
const icuSafe = (v: string): boolean => {
  try {
    new IntlMessageFormat(v, "en", undefined, { ignoreTag: true }).format({});
    return true;
  } catch {
    return false;
  }
};

const guidePath = "src/ui/templates/admin/guide.tsx";
let src = Deno.readTextFileSync(guidePath);
const keysPath = "src/locales/en/guide.json";
const guideJson = JSON.parse(Deno.readTextFileSync(keysPath)) as Record<
  string,
  string
>;

const Q_RE = /<Q\s+q=(?:\{t\("([^"]+)"\)\}|"([^"]+)")\s*>([\s\S]*?)<\/Q>/g;
const repls: [string, string][] = [];
let total = 0;
let converted = 0;
let dynamic = 0;
for (const m of src.matchAll(Q_RE)) {
  total++;
  const qKey = m[1];
  const literal = m[2];
  const id = qKey ? qKey.replace(/^guide\.q\./, "") : slug(literal ?? "");
  const question = qKey ? (messages[qKey] ?? "") : (literal ?? "");
  const answerHtml = rendered.get(norm(question));
  // Source-static: the JSX answer must have no real interpolation. Strip
  // string-literal expressions ({" "}, {"x"}) first, then any remaining {…}
  // is a config-dependent value ({minPriceFormatted}) — keep those manual,
  // since the rendered HTML would otherwise bake in this script's hostConfig.
  const staticSrc = !m[3]
    .replace(/\{\s*(["'])[^"']*\1\s*\}/g, "")
    .includes("{");
  if (!answerHtml || !staticSrc || !icuSafe(answerHtml)) {
    dynamic++;
    continue;
  }
  if (!qKey) guideJson[`guide.q.${id}`] = question;
  guideJson[`guide.a.${id}`] = answerHtml;
  repls.push([m[0], `<Faq id="${id}" />`]);
  converted++;
}
for (const [from, to] of repls) src = src.replace(from, to);

Deno.writeTextFileSync(guidePath, src);
Deno.writeTextFileSync(keysPath, `${JSON.stringify(guideJson, null, 2)}\n`);
console.log(
  `<Q> total: ${total}, converted: ${converted}, dynamic: ${dynamic}`,
);
