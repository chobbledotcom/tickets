import type { SafeHtml } from "#jsx/jsx-runtime.ts";
import { guideFooterFor } from "#templates/components/actions.tsx";

/** The shared "Settings guide" footer. The main and advanced settings pages and
 * the debug page all map to the guide's `#settings` (Settings overview) section,
 * so they render this one footer rather than repeating the anchor + label. */
export const SettingsGuideFooter = (): SafeHtml =>
  guideFooterFor("/admin/guide#settings", "settings.guide_link");
