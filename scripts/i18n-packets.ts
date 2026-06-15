/**
 * i18n-packets — generate per-file work packets for the re-wiring fleet.
 *
 * For each file the old i18n branch wired, emit .i18n-work/<slug>.md containing:
 *   - the NEW path on current main (where the agent edits),
 *   - the expected key list (for verify-i18n --expect),
 *   - the "near-enough guide": the old branch's before/after diff, which shows
 *     exactly which literal became which t("key").
 *
 * Usage: deno run -A scripts/i18n-packets.ts [oldPath ...]   (default: all)
 */

const OLD_BRANCH = "f11b274"; // old i18n work (== origin/claude/add-i18n-typescript-Tm9gs)

/**
 * old path (branch) -> new path (current main). Derived from basename matching
 * plus the lib->shared / routes->features / templates->ui restructure.
 * Files renamed by the events->listings refactor, and routes/index.ts (whose
 * only change — the locale hook — is already applied), are intentionally absent
 * and handled manually.
 */
const MAP: Record<string, string> = {
  "src/lib/apple-wallet.ts": "src/shared/apple-wallet.ts",
  "src/lib/demo.ts": "src/shared/demo.ts",
  "src/lib/email.ts": "src/shared/email.ts",
  "src/lib/google-wallet.ts": "src/shared/google-wallet.ts",
  "src/routes/admin/attendees.ts": "src/features/admin/attendees.ts",
  "src/routes/admin/auth.ts": "src/features/admin/auth.ts",
  "src/routes/admin/groups.ts": "src/features/admin/groups.ts",
  "src/routes/admin/holidays.ts": "src/features/admin/holidays.ts",
  "src/routes/admin/settings.ts": "src/features/admin/settings.ts",
  "src/routes/admin/users.ts": "src/features/admin/users.ts",
  "src/routes/join.ts": "src/features/join.ts",
  "src/routes/setup.ts": "src/features/setup.ts",
  "src/templates/admin/activityLog.tsx":
    "src/ui/templates/admin/activityLog.tsx",
  "src/templates/admin/api-keys.tsx": "src/ui/templates/admin/api-keys.tsx",
  "src/templates/admin/attendees.tsx": "src/ui/templates/admin/attendees.tsx",
  "src/templates/admin/calendar.tsx": "src/ui/templates/admin/calendar.tsx",
  "src/templates/admin/dashboard.tsx": "src/ui/templates/admin/dashboard.tsx",
  "src/templates/admin/database-reset.tsx":
    "src/ui/templates/admin/database-reset.tsx",
  "src/templates/admin/debug.tsx": "src/ui/templates/admin/debug.tsx",
  "src/templates/admin/footer.tsx": "src/ui/templates/admin/footer.tsx",
  "src/templates/admin/groups.tsx": "src/ui/templates/admin/groups.tsx",
  "src/templates/admin/guide.tsx": "src/ui/templates/admin/guide.tsx",
  "src/templates/admin/holidays.tsx": "src/ui/templates/admin/holidays.tsx",
  "src/templates/admin/login.tsx": "src/ui/templates/admin/login.tsx",
  "src/templates/admin/nav.tsx": "src/ui/templates/admin/nav.tsx",
  "src/templates/admin/questions.tsx": "src/ui/templates/admin/questions.tsx",
  "src/templates/admin/scanner.tsx": "src/ui/templates/admin/scanner.tsx",
  "src/templates/admin/sessions.tsx": "src/ui/templates/admin/sessions.tsx",
  "src/templates/admin/settings-advanced.tsx":
    "src/ui/templates/admin/settings-advanced.tsx",
  "src/templates/admin/settings.tsx": "src/ui/templates/admin/settings.tsx",
  "src/templates/admin/site.tsx": "src/ui/templates/admin/site.tsx",
  "src/templates/admin/users.tsx": "src/ui/templates/admin/users.tsx",
  "src/templates/attendee-table.tsx": "src/ui/templates/attendee-table.tsx",
  "src/templates/checkin.tsx": "src/ui/templates/checkin.tsx",
  "src/templates/fields.ts": "src/ui/templates/fields.ts",
  "src/templates/join.tsx": "src/ui/templates/join.tsx",
  "src/templates/payment.tsx": "src/ui/templates/payment.tsx",
  "src/templates/public.tsx": "src/ui/templates/public.tsx",
  "src/templates/setup.tsx": "src/ui/templates/setup.tsx",
  "src/templates/tickets.tsx": "src/ui/templates/tickets.tsx",
};

const sh = (cmd: string, args: string[]): string =>
  new TextDecoder().decode(
    new Deno.Command(cmd, {
      args,
      stderr: "null",
      stdout: "piped",
    }).outputSync().stdout,
  );

const T_CALL = /(?<![A-Za-z0-9_$])t\(\s*(["'`])([^"'`]+)\1/g;
const mb = sh("git", ["merge-base", "origin/main", OLD_BRANCH]).trim();
const slug = (p: string) => p.replace(/[/.]/g, "__");

const requested = Deno.args.length ? Deno.args : Object.keys(MAP);
Deno.mkdirSync(".i18n-work", { recursive: true });

for (const oldPath of requested) {
  const newPath = MAP[oldPath];
  if (!newPath) {
    console.error(`! no mapping for ${oldPath} (manual)`);
    continue;
  }
  const guide = sh("git", ["diff", mb, OLD_BRANCH, "--", oldPath]);
  const keys = [...new Set([...guide.matchAll(T_CALL)].map((m) => m[2]))];
  const verify = `deno run --allow-read --allow-run scripts/verify-i18n.ts --expect=${keys.join(",")} ${newPath}`;

  const packet = `# i18n packet: ${newPath}

EDIT THIS FILE: ${newPath}

Add \`import { t } from "#i18n";\` and replace hard-coded user-facing English
strings with the matching \`t("key")\` calls. Change nothing else.

## Expected keys (${keys.length})
${keys.map((k) => `- ${k}`).join("\n")}

## Verify (must exit 0, no FAIL lines)
${verify}

## Near-enough guide — how this page was internationalised on the old branch
(left/− = literal before, right/+ = t() call after; the surrounding code has
since moved/changed, so apply the same literal→key intent to the CURRENT file)

\`\`\`diff
${guide.trimEnd()}
\`\`\`
`;
  Deno.writeTextFileSync(`.i18n-work/${slug(newPath)}.md`, packet);
  console.log(
    `${newPath}\t${keys.length} keys\t.i18n-work/${slug(newPath)}.md`,
  );
}
