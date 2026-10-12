/**
 * The contract that the app and the deploy helper share: the marker on the
 * read-only page. While UPDATE_IN_PROGRESS is set, the app refuses every
 * write, and the page shows the update message with this marker in its head.
 */

const MARKER_NAME = 'name="update-in-progress"';

/** The head marker the read-only page carries. "supported" says this build
 * understands UPDATE_IN_PROGRESS. "active" says the update page shows right
 * now. The deploy helpers match these values, so both sides of the wait
 * share one definition here. */
export const updatePageMeta = (state: "supported" | "active"): string =>
  `<meta ${MARKER_NAME} content="${state}" />`;
