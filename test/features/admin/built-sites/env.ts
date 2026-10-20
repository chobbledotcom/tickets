/** Shared test environment for admin built-sites tests. */
export const builtSitesTestEnv = {
  db: true,
  env: { CAN_BUILD_SITES: "true" },
  triggers: true,
};
