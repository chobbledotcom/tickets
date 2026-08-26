/**
 * Inviting a user, and the link the owner is handed afterwards.
 *
 * Every role but the editor gets the shared data key wrapped under their
 * single-use invite code, so they can read attendee details once they set a
 * password. An editor's invite carries no key, which is how they stay unable
 * to read that data at all.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import { getUserByUsername } from "#db/users.ts";
import { t } from "#i18n";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  parseFlashCookie,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { TEST_ADMIN_USERNAME } from "#test-utils/internal.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  getTestSession,
} from "#test-utils/session.ts";

const NEW_PATH = "/admin/user/new";
const LIST_PATH = "/admin/users";

const invite = (username: string, adminLevel = "manager") =>
  adminFormPost(LIST_PATH, { admin_level: adminLevel, username });

/** The invite's stored wrapped key, or null when it carries none. */
const wrappedKeyOf = async (username: string): Promise<string | null> => {
  const user = await getUserByUsername(username);
  const row = await queryOne<{ invite_wrapped_data_key: string | null }>(
    "SELECT invite_wrapped_data_key FROM users WHERE id = ?",
    [user!.id],
  );
  return row!.invite_wrapped_data_key;
};

describeWithEnv("inviting a user", { db: true }, () => {
  test("hands the owner a join link on the users page", async () => {
    const { response } = await invite("newmanager");

    const location = response.headers.get("location")!;
    expect(location.split("?")[0]).toBe(LIST_PATH);
    expect(decodeURIComponent(location)).toContain("/join/");
    expect(parseFlashCookie(response).success).toBe(t("success.user_invited"));
  });

  test("says the invite went and writes it to the log", async () => {
    const { response } = await invite("loggedinvite", "manager");

    expect(response.status).toBe(302);
    expect(await activityMessages()).toContain(
      "User 'loggedinvite' invited as manager",
    );
  });

  test("shows the link on the page the owner lands on", async () => {
    const { response } = await invite("linkedinvite");
    const location = response.headers.get("location")!;

    const html = await (await adminGet(location)).text();

    expect(html).toContain("/join/");
  });

  test("shows no link when the owner opens the list on its own", async () => {
    await invite("noticedinvite");

    const html = await (await adminGet(LIST_PATH)).text();

    expect(html).not.toContain("/join/");
  });
});

describeWithEnv("which invites carry the data key", { db: true }, () => {
  test("a manager's does, so they can read attendee details later", async () => {
    await invite("keyedmanager", "manager");

    expect(await wrappedKeyOf("keyedmanager")).not.toBe(null);
  });

  test("an editor's does not, which is how they never gain it", async () => {
    await invite("keylesseditor", "editor");

    expect(await wrappedKeyOf("keylesseditor")).toBe(null);
  });
});

describeWithEnv("an invite that cannot be made", { db: true }, () => {
  test("refuses a username somebody already has", async () => {
    await invite("taken");

    const { response } = await invite("taken");

    await expectFlashRedirect(
      NEW_PATH,
      t("error.username_taken"),
      false,
    )(response);
  });

  test("refuses one the form itself will not accept", async () => {
    const { response } = await invite("", "manager");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(NEW_PATH);
  });
});

describeWithEnv("removing a user", { db: true }, () => {
  const idOf = async (username: string): Promise<number> =>
    (await getUserByUsername(username))!.id;

  test("asks the owner to type the username", async () => {
    await invite("typeme");
    const id = await idOf("typeme");

    const html = await (await adminGet(`${LIST_PATH}/${id}/delete`)).text();

    expect(html).toContain("Username");
    expect(html).toContain("typeme");
  });

  test("removes one whose username was typed exactly", async () => {
    await invite("goner");
    const id = await idOf("goner");

    const { response } = await adminFormPost(`${LIST_PATH}/${id}/delete`, {
      confirm_identifier: "goner",
    });

    await expectFlashRedirect(LIST_PATH, t("success.user_deleted"))(response);
    expect(await getUserByUsername("goner")).toBe(null);
  });

  test("refuses a username that does not match", async () => {
    await invite("exactly");
    const id = await idOf("exactly");

    const { response } = await adminFormPost(`${LIST_PATH}/${id}/delete`, {
      confirm_identifier: "not exactly",
    });

    await expectFlashRedirect(
      `${LIST_PATH}/${id}/delete`,
      "Username does not match. Please type the exact username to confirm deletion.",
      false,
    )(response);
    expect(await getUserByUsername("exactly")).not.toBe(null);
  });

  test("refuses the owner their own account", async () => {
    const owner = (await getUserByUsername(TEST_ADMIN_USERNAME))!;

    const { response } = await adminFormPost(
      `${LIST_PATH}/${owner.id}/delete`,
      { confirm_identifier: TEST_ADMIN_USERNAME },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(t("error.cannot_delete_self"));
  });

  test("answers 404 for a user that is not there", async () => {
    const { response } = await adminFormPost(`${LIST_PATH}/99999/delete`, {
      confirm_identifier: "ghost",
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toContain(t("error.user_not_found"));
  });
});

describeWithEnv(
  "an invite the session cannot carry a key for",
  { db: true },
  () => {
    test("is refused back to the form, saying to log in again", async () => {
      // The owner's session normally holds the wrapped key. A session that lost
      // it cannot wrap the invite's copy, so the invite is refused rather than
      // creating a user who could never read attendee details.
      const { cookie, csrfToken } = await getTestSession();
      await execute("UPDATE sessions SET wrapped_data_key = NULL");
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(
        mockFormRequest(
          LIST_PATH,
          {
            admin_level: "manager",
            csrf_token: csrfToken,
            username: "keyless",
          },
          cookie,
        ),
      );

      await expectFlashRedirect(
        NEW_PATH,
        t("error.session_lacks_key"),
        false,
      )(response);
      expect(await getUserByUsername("keyless")).toBe(null);
    });
  },
);

describeWithEnv(
  "what the users page shows about an invite",
  { db: true },
  () => {
    test("marks an outstanding invite as invited, not expired", async () => {
      await invite("stillopen");

      const html = await (await adminGet(LIST_PATH)).text();

      expect(html).toContain(t("users.status.invited"));
      expect(html).not.toContain(t("users.status.expired"));
    });

    test("marks the owner, who has joined, as active", async () => {
      const html = await (await adminGet(LIST_PATH)).text();

      expect(html).toContain(t("users.status.active"));
      expect(html).not.toContain(t("users.status.expired"));
    });

    test("marks an invite whose week ran out as expired", async () => {
      await invite("ranout");
      const user = (await getUserByUsername("ranout"))!;
      // The stored expiry is encrypted per row, so it is written back the same
      // way the invite wrote it.
      const { encrypt } = await import("#crypto/encryption.ts");
      const { invalidateUsersCache } = await import("#db/users.ts");
      await execute("UPDATE users SET invite_expiry = ? WHERE id = ?", [
        await encrypt(new Date(Date.now() - 1000).toISOString()),
        user.id,
      ]);
      invalidateUsersCache();

      const html = await (await adminGet(LIST_PATH)).text();

      expect(html).toContain(t("users.status.expired"));
    });
  },
);

describeWithEnv("choosing which vans an agent drives", { db: true }, () => {
  const agentUserWithVan = async (username: string) => {
    const { enableFeature } = await import("#test-utils/settings.ts");
    const { logisticsAgents } = await import("#db/logistics-agents.ts");
    await enableFeature("logistics");
    const van = await logisticsAgents.table.insert({ name: "Van 1" });
    await adminFormPost(LIST_PATH, {
      admin_level: "agent",
      username,
    });
    return { userId: (await getUserByUsername(username))!.id, van };
  };

  test("posts the choice back to the agent user's own tab", async () => {
    const { userId } = await agentUserWithVan("vandriver");

    const html = await (await adminGet(`${LIST_PATH}/${userId}/agents`)).text();

    expect(html).toContain(`action="${LIST_PATH}/${userId}/agents"`);
  });

  test("says the choice was saved and writes it to the log", async () => {
    const { userId, van } = await agentUserWithVan("loggeddriver");

    const { response } = await adminFormPost(`${LIST_PATH}/${userId}/agents`, {
      agent_ids: String(van.id),
    });

    await expectFlashRedirect(LIST_PATH, t("success.agents_updated"))(response);
    expect(await activityMessages()).toContain(
      "Agents updated for user 'loggeddriver'",
    );
  });
});

describeWithEnv("a users page shown with an error", { db: true }, () => {
  test("carries no join link, because no invite was made", async () => {
    // The error page renders the same users screen, so it must not show the
    // invite box a successful invite fills in.
    const { enableFeature } = await import("#test-utils/settings.ts");
    await enableFeature("logistics");
    await invite("notanagent", "manager");
    const id = (await getUserByUsername("notanagent"))!.id;

    const { response } = await adminFormPost(`${LIST_PATH}/${id}/agents`, {});

    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(t("error.not_agent_user"));
    expect(html).not.toContain("/join/");
    expect(html).not.toContain("<code>");
  });
});

describeWithEnv("the page for inviting somebody", { db: true }, () => {
  test("is served at its own path", async () => {
    const response = await adminGet(NEW_PATH);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="username"');
  });
});
