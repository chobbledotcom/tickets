/**
 * The env var pointing at the run-wide prebuilt test state directory (see
 * test-state.ts). In its own tiny module so harness and mutation scripts can
 * import the name without loading the app module graph test-state.ts pulls in.
 */
export const TEST_STATE_DIR_ENV = "TICKETS_TEST_STATE_DIR";
