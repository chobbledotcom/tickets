# Plan: Simplify Form + CSRF Rendering

## Problem

Every form in the codebase repeats the same two-line pattern:
```tsx
<form method="POST" action={actionUrl}>
  <input type="hidden" name="csrf_token" value={csrfToken} />
```

There are ~40 forms across 13 template files, all with this boilerplate. The CSRF input is never optional — every POST form must have one.

## Solution

Create a `CsrfForm` JSX component in `src/lib/forms.tsx` that renders the `<form>` opening tag with the hidden CSRF input automatically:

```tsx
export const CsrfForm = ({ action, csrfToken, ...rest }: CsrfFormProps, children: Child): JSX.Element => (
  <form method="POST" action={action} {...rest}>
    <input type="hidden" name="csrf_token" value={csrfToken} />
    {children}
  </form>
);
```

This component:
- Always renders `method="POST"` (every form in the codebase is POST)
- Always includes the hidden `csrf_token` input
- Passes through other attributes like `class`, `enctype`, etc.
- The `csrfToken` prop is always required (no more conditional `{csrfToken && ...}`)

### Props interface

```tsx
interface CsrfFormProps {
  action: string;
  csrfToken: string;
  class?: string;
  enctype?: string;
  children?: Child;
}
```

## Changes Required

### 1. Add `CsrfForm` component to `src/lib/forms.tsx`

Add the component and export it.

### 2. Update all 13 template files

Replace every instance of:
```tsx
<form method="POST" action={url}>
  <input type="hidden" name="csrf_token" value={token} />
```

With:
```tsx
<CsrfForm action={url} csrfToken={token}>
```

And replace closing `</form>` with `</CsrfForm>`.

Files to update:
- `src/templates/setup.tsx` (1 form)
- `src/templates/join.tsx` (1 form)
- `src/templates/checkin.tsx` (1 form)
- `src/templates/public.tsx` (2 forms)
- `src/templates/admin/login.tsx` (1 form)
- `src/templates/admin/nav.tsx` (1 form)
- `src/templates/admin/settings.tsx` (10 forms)
- `src/templates/admin/events.tsx` (~9 forms)
- `src/templates/admin/users.tsx` (3 forms)
- `src/templates/admin/groups.tsx` (4 forms)
- `src/templates/admin/holidays.tsx` (3 forms)
- `src/templates/admin/sessions.tsx` (1 form)
- `src/templates/admin/attendees.tsx` (5 forms)

### 3. Add tests for `CsrfForm`

Add tests in `test/lib/forms.test.ts` verifying:
- Renders form with POST method and action
- Includes hidden csrf_token input
- Passes through extra attributes (class, enctype)
- Renders children

### 4. Run precommit checks

Ensure typecheck, lint, tests, and coverage all pass.
