/**
 * The head markers a built site's pages carry for the deploy waits. The
 * read-only page says whether its build understands update mode, which build
 * serves, and whether the site is activated. The waits parse these strings,
 * so both sides of the contract share one definition here.
 */

export type UpdatePageState = "unsupported" | "supported" | "active";

const MARKER_NAME = 'name="update-in-progress"';

/** The head marker the read-only page carries. "supported" says this build
 * understands UPDATE_IN_PROGRESS. "active" says the update page shows right
 * now. The deploy helpers match these values, so both sides of the wait
 * share one definition here. */
export const updatePageMeta = (state: "supported" | "active"): string =>
  `<meta ${MARKER_NAME} content="${state}" />`;

/** Read the update-mode state off a /read-only page body. */
export const updatePageState = (html: string): UpdatePageState => {
  if (html.includes(updatePageMeta("active"))) return "active";
  return html.includes(MARKER_NAME) ? "supported" : "unsupported";
};

const BUILD_TAG_MARKER_NAME = 'name="update-build-tag"';

const BUILD_TAG_PATTERN = new RegExp(
  `<meta ${BUILD_TAG_MARKER_NAME} content="([^"]+)"`,
);

/** The head marker that names the running build by its release tag. The
 * page renders it from the build timestamp the bundle bakes in. The
 * post-deploy wait matches it against the build the deploy just published,
 * so an active page from the old build cannot pass the wait. */
export const updateBuildTagMeta = (buildTag: string): string =>
  `<meta ${BUILD_TAG_MARKER_NAME} content="${buildTag}" />`;

/** Read the running build's release tag off a /read-only page body. Return
 * null when the page carries no tag: a build from before this marker
 * existed. */
export const updatePageBuildTag = (html: string): string | null =>
  BUILD_TAG_PATTERN.exec(html)?.[1] ?? null;

const NOT_ACTIVATED_MARKER_NAME = 'name="site-not-activated"';

/** The head marker the not-activated page carries. The deploy waits read it
 * to know the site has no live data, so they skip the update wait. */
export const notActivatedPageMeta = (): string =>
  `<meta ${NOT_ACTIVATED_MARKER_NAME} content="1" />`;

/** The message an older build shows on its not-activated page. That build
 * has no marker, so the wait reads the copy. */
const NOT_ACTIVATED_LEGACY_TEXT = "This site has not been activated yet.";

/** Whether a page body is the not-activated page. */
export const isNotActivatedPage = (html: string): boolean =>
  html.includes(NOT_ACTIVATED_MARKER_NAME) ||
  html.includes(NOT_ACTIVATED_LEGACY_TEXT);

/** The error a page check raises for a site that is not activated. The site
 * has no live page and accepts no writes, so the update wait skips it. */
export class SiteNotActivatedError extends Error {
  override readonly name = "SiteNotActivatedError";

  constructor() {
    super("The site is not activated.");
  }
}

/** The log line a wait writes when it skips a not-activated site. */
export const NOT_ACTIVATED_SKIP_MESSAGE =
  "The site is not activated, so it has no live page and accepts no writes. " +
  "The deploy skips the update wait.";
