import type { AdminFeatureKey } from "#shared/admin-features.ts";
import { settings } from "#shared/db/settings.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { featureSetting } from "#test-utils/settings.ts";

export const setupFeaturePageTest =
  (feature: AdminFeatureKey): (() => Promise<void>) =>
  async (): Promise<void> => {
    await setupAdminPageTest();
    settings.setForTest(featureSetting(feature));
  };

export const resetFeaturePageTest = (): void =>
  settings.clearTestOverride("enabled_features");
