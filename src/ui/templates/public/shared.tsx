import { t } from "#i18n";
import { isContactFormActive } from "#shared/contact-form.ts";
import { formatCurrency } from "#shared/currency.ts";
import { settings } from "#shared/db/settings.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { NavModel } from "#shared/site-pages/types.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import type { Group, ItemImageProjection } from "#shared/types.ts";
import {
  type LeveledNavNode,
  leveledNav,
  nodeLis,
} from "#templates/components/nav.tsx";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Everything {@link PublicNav} renders: the settings-driven page flags, the
 * news flag (any post exists), plus the site-pages tree (built per request by
 * `publicNavProps`, site-nav.ts). */
export type PublicNavProps = {
  hasTerms: boolean;
  hasContact: boolean;
  hasNews: boolean;
  hasOrder: boolean;
  pages: NavModel;
};

/** The fixed root links, with the root page nodes spliced between Listings and
 * the Order/News/Terms/Contact group ("between listings and contact"). Each
 * page `<li>` may carry extra children (the desktop nesting), supplied per
 * node. */
const rootItems = (
  { hasTerms, hasContact, hasNews, hasOrder, pages }: PublicNavProps,
  nested: (node: LeveledNavNode) => JSX.Element | null,
): JSX.Element[] => [
  <li>
    <a href="/">{t("nav.public.home")}</a>
  </li>,
  <li>
    <a href="/listings">{t("terms.listings")}</a>
  </li>,
  ...nodeLis(pages.rootPageNodes, nested),
  ...(hasOrder
    ? [
        <li>
          <a href="/order">{t("nav.public.order")}</a>
        </li>,
      ]
    : []),
  ...(hasNews
    ? [
        <li>
          <a href="/news">{t("nav.public.news")}</a>
        </li>,
      ]
    : []),
  ...(hasTerms
    ? [
        <li>
          <a href="/terms">
            <Raw html={t("nav.public.terms")} />
          </a>
        </li>,
      ]
    : []),
  ...(hasContact
    ? [
        <li>
          <a href="/contact">{t("nav.public.contact")}</a>
        </li>,
      ]
    : []),
];

/**
 * Public site navigation: the fixed links (Home, Listings, Order/Terms/Contact
 * when enabled) with the operator's root pages spliced in between, plus the
 * recursive contextual submenus along the active chain — rendered by the same
 * shared `leveledNav` the admin nav uses. It must NOT carry the admin nav's
 * `#main-nav` id: the stylesheet reads that id as "this is an admin page"
 * (full-bleed main, admin textarea sizing), while a public page keeps the
 * shared 800px reading width.
 */
export const PublicNav = (props: PublicNavProps): JSX.Element =>
  leveledNav({
    label: t("nav.public.main"),
    levels: props.pages.submenuLevels,
    rootLis: (nested) => rootItems(props, nested),
  });

/** Compute which public pages have content.
 * The Contact link also shows when the contact form is active, even if the
 * contact page has no descriptive text of its own. The Order link shows
 * whenever the owner has enabled the order page. */
export const navFlags = () => ({
  hasContact: !!settings.contactPageText || isContactFormActive(),
  hasOrder: settings.orderEnabled,
  hasTerms: !!settings.terms,
});

/** The footer every public page ends with: the one admin-login link. */
export const LoginFooter = (): JSX.Element => (
  <footer class="homepage-footer">
    <p>
      <a href="/admin/login">{t("common.login")}</a>
    </p>
  </footer>
);

/** Operator-authored markdown rendered into the shared `.prose` block —
 * nothing at all when the markdown is empty. */
export const MarkdownProse = ({
  markdown,
}: {
  markdown: string;
}): JSX.Element | null =>
  markdown ? (
    <div class="prose">
      <Raw html={renderMarkdown(markdown)} />
    </div>
  ) : null;

/** One `<link rel="alternate">` feed-discovery tag for the shared head. */
const feedDiscoveryTag = (
  type: string,
  titleKey: string,
  href: string,
): string => {
  const attributes = [
    ["rel", "alternate"],
    ["type", type],
    ["title", t(titleKey)],
    ["href", href],
  ]
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  return `<link ${attributes} />`;
};

export const RSS_DISCOVERY_TAG = feedDiscoveryTag(
  "application/rss+xml",
  "terms.listings",
  "/feeds/listings.rss",
);

export const NEWS_RSS_DISCOVERY_TAG = feedDiscoveryTag(
  "application/rss+xml",
  "nav.public.news",
  "/feeds/news.rss",
);

export const ICS_DISCOVERY_TAG = feedDiscoveryTag(
  "text/calendar",
  "terms.listings",
  "/feeds/listings.ics",
);

export const FEED_DISCOVERY_TAGS = `${RSS_DISCOVERY_TAG}\n${NEWS_RSS_DISCOVERY_TAG}\n${ICS_DISCOVERY_TAG}`;

/** The `<title>` and head extras for an operator-authored page with SEO
 * fields: the title prefers `meta_title` over the display name (suffixed with
 * the website title), and a non-empty `meta_description` becomes an escaped
 * description tag after the shared feed-discovery links. */
const seoPageHead = (
  page: { name: string; meta_title: string; meta_description: string },
  websiteTitle: string,
): { title: string; headExtra: string } => {
  const base = page.meta_title || page.name;
  const metaTag = page.meta_description
    ? `\n<meta name="description" content="${escapeHtml(page.meta_description)}" />`
    : "";
  return {
    headExtra: FEED_DISCOVERY_TAGS + metaTag,
    title: websiteTitle ? `${base} - ${websiteTitle}` : base,
  };
};

/** Curried shell for an operator-authored page with SEO fields (a site page,
 * a news post): the SEO head, the public nav, and the page's own name as the
 * `<h1>` — the caller supplies just the body under that heading. */
export const publicSeoPage =
  (
    page: { name: string; meta_title: string; meta_description: string },
    nav: PublicNavProps,
    websiteTitle: string,
  ) =>
  (body: Child): string => {
    const { title, headExtra } = seoPageHead(page, websiteTitle);
    return String(
      <Layout headExtra={headExtra} title={title}>
        <PublicNav {...nav} />
        <h1>{page.name}</h1>
        {body}
      </Layout>,
    );
  };

export const compareGroupsByName = (a: Group, b: Group): number =>
  a.name.localeCompare(b.name);

/** A `<p><strong>{label}</strong> {formatCurrency(amount)}</p>` money line —
 *  the order-total rows shared by the public balance page and the admin
 *  attendee-balance panel. `label` carries its own trailing punctuation. */
export const AmountLine = ({
  label,
  amount,
}: {
  label: Child;
  amount: number;
}): JSX.Element => (
  <p>
    <strong>{label}</strong> {formatCurrency(amount)}
  </p>
);

/** The "Packages" heading that opens both the homepage listings and the order
 *  gallery: shown only when the page has package groups, with the caller
 *  supplying the package-card markup. */
export const PackagesSection = ({
  groups,
  children,
}: {
  groups: Group[];
  children: Child;
}): JSX.Element | null =>
  groups.length > 0 ? (
    <>
      <h2>{t("public.packages")}</h2>
      {children}
    </>
  ) : null;

/** Curried public-page helper. The homepage, order-gallery, and basic-pages
 *  all open with
 *    String(<Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
 *      {websiteTitle && <h1>{websiteTitle}</h1>}<PublicNav {...nav} />
 *      {body}{showLoginFooter && <LoginFooter />}</Layout>)
 *  — this captures that so they only declare their differences (title, body).
 *  The login link is a "you've found the site, here's the door to the admin"
 *  affordance that belongs only on the true homepage — every other public
 *  page (listings, order, terms, contact, ...) leaves it out. */
export const publicPage =
  (
    title: string,
    websiteTitle: string,
    nav: PublicNavProps,
    showLoginFooter = false,
    headExtra: string = FEED_DISCOVERY_TAGS,
  ) =>
  (body: Child): string =>
    String(
      <Layout headExtra={headExtra} title={title}>
        {websiteTitle && <h1>{websiteTitle}</h1>}
        <PublicNav {...nav} />
        {body}
        {showLoginFooter && <LoginFooter />}
      </Layout>,
    );

/** The `<Layout title><div class="prose"><h1>{heading}</h1>{prose}</div>
 *  {afterProse}</Layout>` shell. {@link simplePublicPage} wraps its whole body
 *  in the prose block; the balance page keeps its recap intro in prose but
 *  renders its table/form as siblings after it. */
export const prosePage =
  (title: string, heading: string) =>
  (prose: Child, afterProse?: Child): string =>
    String(
      <Layout title={title}>
        <div class="prose">
          <h1>{heading}</h1>
          {prose}
        </div>
        {afterProse}
      </Layout>,
    );

/** Curried simple public page: <Layout title={title}><div class="prose">
 *  <h1>{heading}</h1>{body}</div></Layout>. No nav, no footer — used by the
 *  simple status pages (balance errors, rate-limited, check-in, renewal).
 *  Takes the page title and heading text, returns a body receiver. */
export const simplePublicPage =
  (title: string, heading: string) =>
  (body: Child): string =>
    prosePage(title, heading)(body);

/** Render listing image HTML if an image is set.
 *
 * In `thumb` contexts (list rows, gallery cards) the linked thumbnail is used
 * when one is stored, falling back to the full image for records without a
 * thumbnail filename. */
export const renderListingImage = (
  listing: Pick<ItemImageProjection, "image_url" | "image_thumb_url"> & {
    image_alt_text?: string | undefined;
  },
  className = "listing-image",
  options: { thumb?: boolean } = {},
): string => {
  const src =
    options.thumb && listing.image_thumb_url
      ? listing.image_thumb_url
      : listing.image_url;
  return src
    ? `<img src="${escapeHtml(getImageProxyUrl(src))}" alt="${escapeHtml(
        listing.image_alt_text ?? "",
      )}" class="${className}" />`
    : "";
};
