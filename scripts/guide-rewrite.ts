/**
 * guide-rewrite — replace each static <Q>…</Q> (strict pattern, no { expr })
 * with <Faq id="…" /> and inject the <Faq> helper. Dynamic <Q> are left as-is.
 * Run AFTER guide-extract.ts + merging guide-keys.json into guide.json.
 *
 * Verify with the golden-render diff (the suite doesn't cover guide).
 *
 * Usage: deno run -A scripts/guide-rewrite.ts
 */

let src = Deno.readTextFileSync("src/ui/templates/admin/guide.tsx");

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

const Q_RE = /<Q\s+q=(?:\{t\("([^"]+)"\)\}|"([^"]+)")\s*>([\s\S]*?)<\/Q>/g;
const repls: [string, string][] = [];
for (const m of src.matchAll(Q_RE)) {
  const qKey = m[1];
  const literal = m[2];
  const answerSrc = m[3];
  if (answerSrc.includes("{")) continue; // dynamic — leave as manual <Q>
  const id = qKey ? qKey.replace(/^guide\.q\./, "") : slug(literal ?? "");
  repls.push([m[0], `<Faq id="${id}" />`]);
}
for (const [from, to] of repls) src = src.replace(from, to);

// Inject the Faq helper just before adminGuidePage.
const faqDef =
  "const Faq = ({ id }: { id: string }): JSX.Element => (\n" +
  "  <Q q={t(`guide.q.${id}`)}>\n" +
  "    <Raw html={t(`guide.a.${id}`)} />\n" +
  "  </Q>\n" +
  ");\n\n";
src = src.replace(
  "export const adminGuidePage",
  `${faqDef}export const adminGuidePage`,
);

Deno.writeTextFileSync("src/ui/templates/admin/guide.tsx", src);
console.log(`replaced ${repls.length} static <Q> with <Faq>`);
