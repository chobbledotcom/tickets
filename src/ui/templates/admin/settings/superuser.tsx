import { CsrfForm } from "#shared/forms.tsx";
import type { SuperuserState } from "#shared/superuser.ts";

export const SuperuserForm = (s: {
  superuser: SuperuserState;
}): JSX.Element | null => {
  const { superuser } = s;
  if (!superuser.available) {
    return null;
  }

  const disabled = superuser.activated;

  return (
    <CsrfForm action="/admin/settings/superuser" id="settings-superuser">
      <h2>Superuser Recovery</h2>

      {disabled ? (
        <p>
          Superuser {superuser.username} is already activated. You can delete
          them from your <a href="/admin/users">users page</a>.
        </p>
      ) : (
        <>
          <p>
            Your attendee data is encrypted with your password, and admins
            cannot view your password. With that in mind, please select:
          </p>
          <label class="radio-label">
            <input
              checked={superuser.choice === "self-managed"}
              disabled={disabled}
              name="superuser_choice"
              required
              type="radio"
              value="self-managed"
            />
            <span>
              I understand that my attendee information cannot be decrypted
              without my password, and that I am responsible for storing my
              password securely. If I forget it, I will be locked out of my
              attendee records.
            </span>
          </label>

          <label class="radio-label">
            <input
              checked={superuser.choice === "enabled"}
              disabled={disabled}
              name="superuser_choice"
              required
              type="radio"
              value="enable-superuser"
            />
            <span>
              I wish to enable a "super user" account on this platform for my
              admin, {superuser.email}. This user will be able to log in,
              decrypt attendee data, and invite a replacement owner account if I
              lose access.
            </span>
          </label>

          <button type="submit">Save</button>
        </>
      )}
    </CsrfForm>
  );
};
