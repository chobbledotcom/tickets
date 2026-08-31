import {
  type FindingIdentity,
  identitiesAt,
} from "#scripts/unread-fields/identity.ts";

export const UI_BASELINE: readonly FindingIdentity[] = [
  ...identitiesAt("src/ui/client/admin/markdown-editor.ts", [
    { name: "MarkdownEditorHandle" },
  ])(["setMode", "view"]),
  ...identitiesAt("src/ui/templates/admin/backup.tsx", [
    { name: "BackupPageState" },
    { name: "createBlocked" },
  ])(["available", "needed"]),
  ...identitiesAt("src/ui/templates/admin/bulk-email.tsx", [
    { name: "BulkEmailPreviewState" },
  ])(["recipientCount"]),
  ...identitiesAt("src/ui/templates/admin/calendar.tsx", [
    { name: "CalendarAttendeeRow" },
  ])(["listingDate", "listingLocation"]),
  ...identitiesAt("src/ui/templates/admin/debug.tsx", [
    { name: "DebugPageState" },
    { name: "appleWallet" },
  ])(["dbConfigured", "envConfigured", "source"]),
  ...identitiesAt("src/ui/templates/admin/debug.tsx", [
    { name: "DebugPageState" },
    { name: "googleWallet" },
  ])(["dbConfigured", "envConfigured", "source"]),
  ...identitiesAt("src/ui/templates/admin/entity-pages.tsx", [
    { name: "ResolvedAction" },
  ])(["danger"]),
  ...identitiesAt("src/ui/templates/admin/listings/types.ts", [
    { name: "ListingPanelOptions" },
  ])(["hasEmailableAttendees"]),
  ...identitiesAt("src/ui/templates/admin/modifiers/links.tsx", [
    { name: "AnswerLinks" },
    { name: "options" },
    { way: "[]" },
  ])(["id", "name"]),
  ...identitiesAt("src/ui/templates/admin/modifiers/links.tsx", [
    { name: "ScopeLinks" },
    { name: "options" },
    { way: "[]" },
  ])(["active", "id", "name"]),
  ...identitiesAt("src/ui/templates/admin/settings-advanced.tsx", [
    { name: "AdvancedSettingsPageState" },
  ])([
    "addressLookupApiKeyConfigured",
    "addressLookupProvider",
    "attendeeColumnOrder",
    "customCss",
    "existingPaymentProvider",
    "externalOrderEnabled",
    "listingColumnOrder",
    "showPublicApi",
  ]),
  ...identitiesAt("src/ui/templates/admin/users.tsx", [
    { name: "UsersPageOpts" },
  ])(["currentUserId", "error", "success"]),
];
