import { cachedAdminPage } from "#test-utils/assertions.ts";
import { withEnv } from "#test-utils/env.ts";

/**
 * The guide page as the owner sees it by default.
 *
 * The guide's default rendering is identical in every test (static help
 * content from the standard fixture), so it is rendered once and shared by
 * every test file that imports this module. Only tests that alter host config,
 * settings, or env fetch their own copy (e.g. via `assertAdminHtml`) so they
 * never read the stale snapshot.
 *
 * The cached render is pinned to CAN_BUILD_SITES unset, so the snapshot never
 * depends on whatever the ambient overlay happens to carry when it is first
 * fetched. The env pin must cover the whole first render, so the cached page
 * is awaited before the `using` scope disposes.
 */
const cachedGuide = cachedAdminPage("/admin/guide");

export const guide = async (
  ...expected: Parameters<typeof cachedGuide>
): Promise<string> => {
  using _env = withEnv({ CAN_BUILD_SITES: undefined });
  return await cachedGuide(...expected);
};
