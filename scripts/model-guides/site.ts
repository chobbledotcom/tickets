import { Marked, type Token } from "marked";
import { escapeHtml } from "#jsx/escape-html.ts";

/** The repository that holds the model and source files. */
const REPOSITORY = "https://github.com/chobbledotcom/tickets";

/** A generated guide link that points into the repository. */
const SOURCE_PREFIX = "../../";

/** The repository link for the model verification method. */
const MODEL_VERIFICATION = "../model-verification.md";
const MODEL_VERIFICATION_HREF = `${REPOSITORY}/blob/main/docs/model-verification.md`;

const hasScheme = (href: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(href);

const pageName = (name: string): string =>
  name === "README.md" ? "index.html" : `${name.slice(0, -3)}.html`;

/** Turn one guide link into a link that works on GitHub Pages.
 *
 * Repository paths become GitHub blob links. Page links become their HTML
 * file. External links stay as written. */
export const siteHref = (href: string): string => {
  if (href.startsWith(SOURCE_PREFIX)) {
    return `${REPOSITORY}/blob/main/${href.slice(SOURCE_PREFIX.length)}`;
  }
  if (href === MODEL_VERIFICATION) return MODEL_VERIFICATION_HREF;
  if (hasScheme(href)) return href;
  return href.endsWith(".md") ? pageName(href) : href;
};

type LinkToken = Token & { href: string };

const isLink = (token: Token): token is LinkToken =>
  token.type === "link" && "href" in token && typeof token.href === "string";

const rewriteLink = (token: Token): void => {
  if (isLink(token)) token.href = siteHref(token.href);
};

const markdown = new Marked();

const renderBody = (text: string): string =>
  markdown.parse(text, { walkTokens: rewriteLink }) as string;

const headingOf = (text: string): string => {
  const match = /^# (.+)$/m.exec(text);
  return match === null ? "Model walkthroughs" : match[1]!.trim();
};

/* jscpd:ignore-start -- static data, not code */
const STYLE = `
:root { color-scheme: light dark; }
body {
  max-width: 52rem;
  margin: 0 auto;
  padding: 2rem 1rem;
  font: 16px/1.6 system-ui, sans-serif;
}
nav { margin-bottom: 2rem; font-size: 0.95rem; }
a { color: inherit; }
code, pre { font-family: ui-monospace, monospace; }
pre {
  padding: 1rem;
  overflow-x: auto;
  background: color-mix(in srgb, currentColor 6%, transparent);
}
table {
  display: block;
  width: 100%;
  margin: 1rem 0;
  border-collapse: collapse;
  overflow-x: auto;
}
th, td {
  padding: 0.4rem 0.6rem;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  text-align: left;
  vertical-align: top;
}
blockquote {
  margin-left: 0;
  padding-left: 1rem;
  border-left: 3px solid color-mix(in srgb, currentColor 30%, transparent);
}
`.trim();

const NAV = [
  '<nav><a href="./index.html">All models</a>',
  '<a href="../doc.ts/index.html">API reference</a>',
  '<a href="https://github.com/chobbledotcom/tickets">Repository</a></nav>',
].join(" · ");
/* jscpd:ignore-end */

/** Render one guide as a complete GitHub Pages document. */
export const renderSitePage = (text: string): string =>
  [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(headingOf(text))} · Chobble Tickets</title>`,
    "<style>",
    STYLE,
    "</style>",
    "</head>",
    "<body>",
    NAV,
    "<main>",
    renderBody(text),
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

/** Render every guide under its GitHub Pages file name. */
export const renderSitePages = (
  pages: ReadonlyMap<string, string>,
): Map<string, string> =>
  new Map(
    [...pages].map(([name, text]) => [pageName(name), renderSitePage(text)]),
  );
