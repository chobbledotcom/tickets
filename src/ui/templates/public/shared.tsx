import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { type Child, Raw } from "#jsx/jsx-runtime.ts";
import { isContactFormActive } from "#shared/contact-form.ts";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { NavModel } from "#shared/site-pages/types.ts";
import {
  LabelledAmount,
  type LabelledAmountProps,
} from "#templates/components/labelled-amount.tsx";
import {
  type LeveledNavNode,
  leveledNav,
  nodeLis,
} from "#templates/components/nav.tsx";
import { Layout } from "#templates/layout.tsx";
import type { Group, Image, ItemImageColumns } from "#types";

/** Everything {@link PublicNav} renders: the settings-driven page flags, the
 * news and reviews flags, plus the site-pages tree (built per request by
 * `publicNavProps`, site-nav.ts). */
export type PublicNavProps = {
  hasTerms: boolean;
  hasContact: boolean;
  hasNews: boolean;
  hasOrder: boolean;
  hasReviews: boolean;
  pages: NavModel;
};

/** The fixed root links, with the root page nodes spliced between Listings and
 * the Order/News/Terms/Contact group ("between listings and contact"). Each
 * page `<li>` may carry extra children. The desktop nesting supplies them. */
/** A root nav `<li>` link, included only when `show` is true. The result is a
 *  one-element array so it splices cleanly into the root list, or nothing when
 *  the page is disabled. `label` is the link body. It is plain text, or
 *  `<Raw>` for the terms link that carries markup. */
const optionalNavItem = (
  show: boolean,
  href: string,
  label: Child,
): JSX.Element[] =>
  show
    ? [
        <li>
          <a href={href}>{label}</a>
        </li>,
      ]
    : [];

const rootItems = (
  {
    hasTerms,
    hasContact,
    hasNews,
    hasOrder,
    hasReviews,
    pages,
  }: PublicNavProps,
  nested: (node: LeveledNavNode) => JSX.Element | null,
): JSX.Element[] => [
  <li>
    <a href="/">{t("nav.public.home")}</a>
  </li>,
  <li>
    <a href="/listings">{t("terms.listings")}</a>
  </li>,
  ...nodeLis(pages.rootPageNodes, nested),
  ...optionalNavItem(hasOrder, "/order", t("nav.public.order")),
  ...optionalNavItem(hasNews, "/news", t("nav.public.news")),
  ...optionalNavItem(hasReviews, "/reviews", t("nav.public.reviews")),
  ...optionalNavItem(hasTerms, "/terms", <Raw html={t("nav.public.terms")} />),
  ...optionalNavItem(hasContact, "/contact", t("nav.public.contact")),
];

/**
 * Public site navigation: the fixed links (Home, Listings, Order/Terms/Contact
 * when enabled) with the operator's root pages spliced in between, plus the
 * recursive contextual submenus along the active chain — rendered by the same
 * shared `leveledNav` the admin nav uses. It must NOT carry the admin nav's
 * `#main-nav` id: the stylesheet reads that id as "this is an admin page"
 * (full-bleed main, admin textarea sizing), while a public page keeps the
 * shared 1080px reading width.
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
 * whenever the owner has enabled the order page. The Reviews link follows its
 * feature switch. The generated reviews data always holds at least one card,
 * so an enabled switch never renders a dead link. */
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
 * nothing at all when the markdown is empty. The render resolves the page's
 * img#N references through the request's page-image slot. */
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

/** One gallery entry: the radio, its full-size image, and (when the collection
 * has more than one image, so there is something to swap to) its thumbnail
 * label. The three stay adjacent siblings — the stylesheet's `+` selectors
 * depend on that order. */
const galleryEntry = (
  image: Image,
  index: number,
  withThumb: boolean,
): JSX.Element => (
  <>
    <input
      checked={index === 0}
      class="news-gallery-radio"
      id={`news-gallery-${index}`}
      name="news-gallery"
      type="radio"
    />
    <img
      alt={image.altText || image.name}
      class="news-gallery-full"
      src={getImageProxyUrl(image.filename)}
    />
    {withThumb && (
      <label class="news-gallery-thumb" for={`news-gallery-${index}`}>
        <img
          alt={t("public.gallery_thumb", { number: index + 1 })}
          src={getImageProxyUrl(image.filenameThumb)}
        />
      </label>
    )}
  </>
);

/** A CSS-only image gallery shared by the public news post and content pages:
 * nothing without images; with them, the first image shows full-width and the
 * rest (if any) as thumbnails that swap it in via radio inputs — no script. */
export const PublicImageGallery = ({
  images,
}: {
  images: readonly Image[];
}): JSX.Element | null =>
  images.length === 0 ? null : (
    <fieldset class="news-gallery">
      <legend class="visually-hidden">{t("public.gallery_label")}</legend>
      {images.map((image, index) =>
        galleryEntry(image, index, images.length > 1),
      )}
    </fieldset>
  );

/** A page title with the website title after it, when the site has one. */
export const titleWithSiteName = (
  base: string,
  websiteTitle: string,
): string => (websiteTitle ? `${base} - ${websiteTitle}` : base);

/** One `<link rel="alternate">` feed-discovery tag for the shared head. */
export const feedDiscoveryTag = (
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

/**
 * Feed-discovery `<link>` tags for the page head — built on demand, not at
 * module scope. Each calls `t()`, and a module-level `t()` would construct the
 * isolate's first `IntlMessageFormat` at import time, which loads ~13ms of ICU
 * locale data. This module is eager (the public layout imports it), so a
 * module-level `t()` here paid that ICU init on every cold boot. As a function
 * the cost lands only when a page renders, so requests that render nothing
 * (feeds, webhooks, redirects) never pay it.
 *
 * The news tag appears only when the site has a post. `/news` and the feed
 * both answer 404 until one exists, so the head never advertises a dead feed.
 */
export const feedDiscoveryTags = (hasNews: boolean): string =>
  [
    feedDiscoveryTag(
      "application/rss+xml",
      "terms.listings",
      "/feeds/listings.rss",
    ),
    ...(hasNews
      ? [
          feedDiscoveryTag(
            "application/rss+xml",
            "nav.public.news",
            "/feeds/news.rss",
          ),
        ]
      : []),
    feedDiscoveryTag("text/calendar", "terms.listings", "/feeds/listings.ics"),
  ].join("\n");

/** The `<title>` and head extras for an operator-authored page with SEO
 * fields: the title prefers `metaTitle` over the display name (suffixed with
 * the website title), and a non-empty `metaDescription` becomes an escaped
 * description tag after the shared feed-discovery links. */
const seoPageHead = (
  page: { name: string; metaTitle: string; metaDescription: string },
  websiteTitle: string,
  hasNews: boolean,
): { title: string; headExtra: string } => {
  const base = page.metaTitle || page.name;
  const metaTag = page.metaDescription
    ? `\n<meta name="description" content="${escapeHtml(page.metaDescription)}" />`
    : "";
  return {
    headExtra: feedDiscoveryTags(hasNews) + metaTag,
    title: titleWithSiteName(base, websiteTitle),
  };
};

/** Curried shell for an operator-authored page with SEO fields (a site page,
 * a news post): the SEO head, the public nav, and — unless `showHeading` is
 * false — the page's own name as the `<h1>`. A caller that renders its own
 * heading inside the body (the news post page, which folds the heading into its
 * `.prose` block) passes `showHeading: false`. */
/** The `<Layout>` shell every public page shares: the `public-page` content
 *  class, the head extras, the page title, and a `beforeContent` slot for the
 *  nav (and any homepage heading). Both public-page helpers render through it so
 *  the Layout prop block lives in one place. */
const PublicLayout = ({
  title,
  headExtra,
  beforeContent,
  children,
}: {
  title: string;
  headExtra: string;
  beforeContent: Child;
  children: Child;
}): JSX.Element => (
  <Layout
    beforeContent={beforeContent}
    contentClassName="public-page"
    family="public"
    headExtra={headExtra}
    title={title}
  >
    {children}
  </Layout>
);

export const publicSeoPage =
  (
    page: { name: string; metaTitle: string; metaDescription: string },
    nav: PublicNavProps,
    websiteTitle: string,
    { showHeading = true }: { showHeading?: boolean } = {},
  ) =>
  (body: Child): string => {
    const { title, headExtra } = seoPageHead(page, websiteTitle, nav.hasNews);
    return String(
      <PublicLayout
        beforeContent={<PublicNav {...nav} />}
        headExtra={headExtra}
        title={title}
      >
        {showHeading && <h1>{page.name}</h1>}
        {body}
      </PublicLayout>,
    );
  };

export const compareGroupsByName = (a: Group, b: Group): number =>
  a.name.localeCompare(b.name);

/** A `<p>`-wrapped money line — the order-total rows shared by the public
 *  balance page and the admin attendee-balance panel. `label` carries its own
 *  trailing punctuation. */
export const AmountLine = (props: LabelledAmountProps): JSX.Element => (
  <p>
    <LabelledAmount {...props} />
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
 *    String(<PublicLayout beforeContent={...}>
 *      {websiteTitle && <h1>{websiteTitle}</h1>}{body}{showLoginFooter &&
 *      <LoginFooter />}</PublicLayout>)
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
    headExtra: string = feedDiscoveryTags(nav.hasNews),
  ) =>
  (body: Child): string =>
    String(
      <PublicLayout
        beforeContent={
          <>
            {websiteTitle && <h1>{websiteTitle}</h1>}
            <PublicNav {...nav} />
          </>
        }
        headExtra={headExtra}
        title={title}
      >
        {body}
        {showLoginFooter && <LoginFooter />}
      </PublicLayout>,
    );

/** Render listing image HTML if an image is set.
 *
 * In `thumb` contexts (list rows, gallery cards) the linked thumbnail is used
 * when one is stored, falling back to the full image for records without a
 * thumbnail filename. */
export const renderListingImage = (
  listing: Pick<ItemImageColumns, "imageUrl" | "imageThumbUrl"> & {
    imageAltText?: string | undefined;
  },
  className = "listing-image",
  options: { thumb?: boolean } = {},
): string => {
  const src =
    options.thumb && listing.imageThumbUrl
      ? listing.imageThumbUrl
      : listing.imageUrl;
  return src
    ? `<img src="${escapeHtml(getImageProxyUrl(src))}" alt="${escapeHtml(
        listing.imageAltText ?? "",
      )}" class="${className}" />`
    : "";
};
