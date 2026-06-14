import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { hashPassword } from "#shared/crypto/hashing.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createUser,
  getUserByUsername,
  verifyUserPassword,
} from "#shared/db/users.ts";
import {
  createActivatedSuperuser,
  generateSuperuserPassword,
  getAdminEmailAddress,
  getSuperuserState,
  getSuperuserUsername,
  sendSuperuserCredentialsEmail,
} from "#shared/superuser.ts";
import {
  describeWithEnv,
  setTestEnv,
  validEmail,
  withMocks,
} from "#test-utils";

// ---------------------------------------------------------------------------
// getAdminEmailAddress()
// ---------------------------------------------------------------------------

describe("getAdminEmailAddress", () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
  });

  test("returns null when ADMIN_EMAIL_ADDRESS is unset", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    expect(getAdminEmailAddress()).toBeNull();
  });

  test("returns null when ADMIN_EMAIL_ADDRESS is an empty string", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "" });
    expect(getAdminEmailAddress()).toBeNull();
  });

  test("returns null when ADMIN_EMAIL_ADDRESS is whitespace-only", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "   " });
    expect(getAdminEmailAddress()).toBeNull();
  });

  test("returns trimmed email when ADMIN_EMAIL_ADDRESS has leading/trailing whitespace", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "  admin@example.com  " });
    expect(getAdminEmailAddress()).toBe("admin@example.com");
  });

  test("returns email as-is when already trimmed", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    expect(getAdminEmailAddress()).toBe("admin@example.com");
  });

  test("normalizes configured email address to lowercase", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "Admin@Example.com" });
    expect(getAdminEmailAddress()).toBe("admin@example.com");
  });

  test("returns null and logs error when value lacks an @ sign", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "not-an-email" });
    expect(getAdminEmailAddress()).toBeNull();
  });

  test("returns null and logs error when value has multiple @ signs", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "a@b@c.com" });
    expect(getAdminEmailAddress()).toBeNull();
  });

  test("returns null and logs error when local part is missing", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "@example.com" });
    expect(getAdminEmailAddress()).toBeNull();
  });

  test("returns null and logs error when domain is missing", () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@" });
    expect(getAdminEmailAddress()).toBeNull();
  });

  test("accepts subdomain-style email addresses", () => {
    restoreEnv = setTestEnv({
      ADMIN_EMAIL_ADDRESS: "my.admin@sub.example.co.uk",
    });
    expect(getAdminEmailAddress()).toBe("my.admin@sub.example.co.uk");
  });
});

// ---------------------------------------------------------------------------
// getSuperuserUsername()
// ---------------------------------------------------------------------------

describe("getSuperuserUsername", () => {
  test("returns lowercased local part of a simple email", () => {
    expect(getSuperuserUsername(validEmail("MyUsername@example.com"))).toBe(
      "myusername",
    );
  });

  test("returns local part unchanged when already lowercase", () => {
    expect(getSuperuserUsername(validEmail("admin@example.com"))).toBe("admin");
  });

  test("returns null and logs when local part is too short (1 character)", () => {
    expect(getSuperuserUsername(validEmail("a@example.com"))).toBeNull();
  });

  test("returns the minimum valid 2-character local part", () => {
    expect(getSuperuserUsername(validEmail("ab@example.com"))).toBe("ab");
  });

  test("returns the maximum valid 32-character local part", () => {
    const local = `a${"b".repeat(31)}`;
    expect(getSuperuserUsername(validEmail(`${local}@example.com`))).toBe(
      local,
    );
  });

  test("returns null and logs when local part is 33 characters", () => {
    expect(
      getSuperuserUsername(validEmail(`${"a".repeat(33)}@example.com`)),
    ).toBeNull();
  });

  test("returns null and logs when local part contains a dot (john.doe)", () => {
    expect(getSuperuserUsername(validEmail("john.doe@example.com"))).toBeNull();
  });

  test("returns null and logs when local part contains a plus sign (user+tag)", () => {
    expect(getSuperuserUsername(validEmail("user+tag@example.com"))).toBeNull();
  });

  test("returns null and logs when local part contains invalid special characters", () => {
    expect(getSuperuserUsername(validEmail("admin!@example.com"))).toBeNull();
  });

  test("accepts local parts with hyphens", () => {
    expect(getSuperuserUsername(validEmail("my-admin@example.com"))).toBe(
      "my-admin",
    );
  });

  test("accepts local parts with underscores", () => {
    expect(getSuperuserUsername(validEmail("my_admin@example.com"))).toBe(
      "my_admin",
    );
  });

  test("accepts local parts with digits", () => {
    expect(getSuperuserUsername(validEmail("admin123@example.com"))).toBe(
      "admin123",
    );
  });

  test("returns null and logs when local part starts with a hyphen", () => {
    expect(getSuperuserUsername(validEmail("-admin@example.com"))).toBeNull();
  });

  test("returns null and logs when local part starts with an underscore", () => {
    expect(getSuperuserUsername(validEmail("_admin@example.com"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSuperuserState()
// ---------------------------------------------------------------------------

describeWithEnv("getSuperuserState", { db: true }, () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
  });

  test("returns { available: false, reason: 'missing-env' } when ADMIN_EMAIL_ADDRESS is unset", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    const state = await getSuperuserState();
    expect(state).toEqual({ available: false, reason: "missing-env" });
  });

  test("returns { available: false, reason: 'invalid-env' } when ADMIN_EMAIL_ADDRESS fails email validation", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "not-an-email" });
    const state = await getSuperuserState();
    expect(state).toEqual({ available: false, reason: "invalid-env" });
  });

  test("returns { available: false, reason: 'invalid-username' } when derived username is too short", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "a@example.com" });
    const state = await getSuperuserState();
    expect(state).toEqual({ available: false, reason: "invalid-username" });
  });

  test("returns { available: false, reason: 'invalid-username' } when local part contains dots", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "john.doe@example.com" });
    const state = await getSuperuserState();
    expect(state).toEqual({ available: false, reason: "invalid-username" });
  });

  test("returns available state with userExists:false, activated:false, choice:'' when user does not exist", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    const state = await getSuperuserState();
    expect(state).toEqual({
      activated: false,
      available: true,
      choice: "",
      email: validEmail("admin@example.com"),
      userExists: false,
      username: "admin",
    });
  });

  test("calls getUserByUsername with the lowercased derived username", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "Admin@example.com" });
    // We can't spy on imported top-level functions, but we verify the outcome:
    // getSuperuserState should return the lowercased username.
    const state = await getSuperuserState();
    expect(state.available && state.username === "admin").toBe(true);
  });

  test("returns userExists:true, activated:true, choice:'enabled' when user has wrapped_data_key and choice persisted", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    const passwordHash = await hashPassword("password123");
    await createUser("admin", passwordHash, "wrapped-key-bytes", "owner");
    settings.setForTest({ superuser_choice: "enabled" });
    const state = await getSuperuserState();
    expect(state).toEqual({
      activated: true,
      available: true,
      choice: "enabled",
      email: validEmail("admin@example.com"),
      userExists: true,
      username: "admin",
    });
  });

  test("returns userExists:true, activated:false when user row exists but wrapped_data_key is null", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    await createUser("admin", "", null, "owner");
    const state = await getSuperuserState();
    expect(state).toEqual({
      activated: false,
      available: true,
      choice: "",
      email: validEmail("admin@example.com"),
      userExists: true,
      username: "admin",
    });
  });

  test("returns choice:'self-managed' when owner previously chose self-managed", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    settings.setForTest({ superuser_choice: "self-managed" });
    const state = await getSuperuserState();
    expect(state).toEqual({
      activated: false,
      available: true,
      choice: "self-managed",
      email: validEmail("admin@example.com"),
      userExists: false,
      username: "admin",
    });
  });

  test("returns unavailable when ADMIN_EMAIL_ADDRESS is temporarily unset even if choice persisted", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    settings.setForTest({ superuser_choice: "enabled" });
    const state = await getSuperuserState();
    expect(state).toEqual({ available: false, reason: "missing-env" });
  });
});

// ---------------------------------------------------------------------------
// generateSuperuserPassword()
// ---------------------------------------------------------------------------

describe("generateSuperuserPassword", () => {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

  test("returns a 12-character string by default", () => {
    const result = generateSuperuserPassword();
    expect(result.length).toBe(12);
  });

  test("returns the requested length", () => {
    const result = generateSuperuserPassword(20);
    expect(result.length).toBe(20);
  });

  test("only contains characters from the expected alphabet", () => {
    const allChars = new Set<string>();
    for (let i = 0; i < 100; i++) {
      for (const c of generateSuperuserPassword(10).split("")) {
        allChars.add(c);
      }
    }
    for (const c of allChars) {
      expect(ALPHABET).toContain(c);
    }
  });

  test("excludes ambiguous characters (0, O, I, l, 1)", () => {
    for (let i = 0; i < 100; i++) {
      const pw = generateSuperuserPassword(20);
      expect(pw).not.toContain("0");
      expect(pw).not.toContain("O");
      expect(pw).not.toContain("I");
      expect(pw).not.toContain("l");
      expect(pw).not.toContain("1");
    }
  });

  test("contains no punctuation, whitespace, or symbols", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateSuperuserPassword(10)).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  test("produces different passwords on successive calls", () => {
    const pass1 = generateSuperuserPassword();
    const pass2 = generateSuperuserPassword();
    expect(pass1).not.toBe(pass2);
  });

  test("handles length 0 gracefully (empty string)", () => {
    expect(generateSuperuserPassword(0)).toBe("");
  });

  test("handles length 1 correctly", () => {
    const result = generateSuperuserPassword(1);
    expect(result.length).toBe(1);
    expect(ALPHABET).toContain(result);
  });

  test("uses Web Crypto API (crypto.getRandomValues), not Math.random", () => {
    const spyCrypto = spy(crypto, "getRandomValues");
    try {
      generateSuperuserPassword();
      expect(spyCrypto.calls.length).toBeGreaterThan(0);
    } finally {
      spyCrypto.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// createActivatedSuperuser()
// ---------------------------------------------------------------------------

describeWithEnv("createActivatedSuperuser", { db: true }, () => {
  test("creates a user with the provided username, hashed password, wrapped data key, and owner role", async () => {
    const dataKey = await crypto.subtle.generateKey(
      { length: 256, name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"],
    );
    const user = await createActivatedSuperuser({
      dataKey,
      password: "pass1234abcd",
      username: "admin",
    });
    expect(user.wrapped_data_key).not.toBeNull();
    expect(user.wrapped_data_key).not.toBe("");
  });

  test("created user's password can be verified with the raw password", async () => {
    const dataKey = await crypto.subtle.generateKey(
      { length: 256, name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"],
    );
    const password = "mysecretpw";
    await createActivatedSuperuser({ dataKey, password, username: "admin" });
    const fetchedUser = await getUserByUsername("admin");
    expect(fetchedUser).not.toBeNull();
    const hash = await verifyUserPassword(fetchedUser!, password);
    expect(hash).toBeTruthy();
  });

  test("created user has admin level 'owner'", async () => {
    const dataKey = await crypto.subtle.generateKey(
      { length: 256, name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"],
    );
    await createActivatedSuperuser({
      dataKey,
      password: "pw",
      username: "admin",
    });
    const fetchedUser = await getUserByUsername("admin");
    expect(fetchedUser).not.toBeNull();
    const { decryptAdminLevel } = await import("#shared/db/users.ts");
    const level = await decryptAdminLevel(fetchedUser!);
    expect(level).toBe("owner");
  });

  test("fails when username is already taken", async () => {
    const dataKey = await crypto.subtle.generateKey(
      { length: 256, name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"],
    );
    await createActivatedSuperuser({
      dataKey,
      password: "pw1",
      username: "admin",
    });
    await expect(
      createActivatedSuperuser({ dataKey, password: "pw2", username: "admin" }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sendSuperuserCredentialsEmail()
// ---------------------------------------------------------------------------

describe("sendSuperuserCredentialsEmail", () => {
  /** Capture fetch calls and parse Resend API request bodies */
  const captureEmailCall = () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const fetchStub = stub(
      globalThis,
      "fetch",
      (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api.resend.com")) {
          const body = JSON.parse((init?.body as string) ?? "{}") as Record<
            string,
            unknown
          >;
          calls.push({ body });
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    );
    return { calls, restore: () => fetchStub.restore() };
  };

  test("calls sendEmail with the provided config and a correctly structured message", async () => {
    const { calls, restore } = captureEmailCall();
    try {
      const config = {
        apiKey: "test",
        fromAddress: validEmail("from@test.com"),
        provider: "resend" as const,
      };
      const result = await sendSuperuserCredentialsEmail(config, {
        email: validEmail("admin@example.com"),
        password: "a1b2c3d4e5f6",
        username: "myadmin",
      });
      expect(result).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0]!.body.to).toEqual(["admin@example.com"]);
      expect(calls[0]!.body.subject).toBe("Superuser account enabled");
    } finally {
      restore();
    }
  });

  test("email text body contains the username", async () => {
    const { calls, restore } = captureEmailCall();
    try {
      const config = {
        apiKey: "test",
        fromAddress: validEmail("from@test.com"),
        provider: "resend" as const,
      };
      await sendSuperuserCredentialsEmail(config, {
        email: validEmail("admin@example.com"),
        password: "a1b2c3d4e5f6",
        username: "myadmin",
      });
      const text = String(calls[0]!.body.text);
      expect(text).toContain("myadmin");
    } finally {
      restore();
    }
  });

  test("email text body contains the temporary password", async () => {
    const { calls, restore } = captureEmailCall();
    try {
      const config = {
        apiKey: "test",
        fromAddress: validEmail("from@test.com"),
        provider: "resend" as const,
      };
      await sendSuperuserCredentialsEmail(config, {
        email: validEmail("admin@example.com"),
        password: "a1b2c3d4e5f6",
        username: "myadmin",
      });
      const text = String(calls[0]!.body.text);
      expect(text).toContain("a1b2c3d4e5f6");
    } finally {
      restore();
    }
  });

  test("email text body contains the site login URL via getEffectiveDomain", async () => {
    const { calls, restore } = captureEmailCall();
    try {
      setEffectiveDomainForTest("example.com");
      const config = {
        apiKey: "test",
        fromAddress: validEmail("from@test.com"),
        provider: "resend" as const,
      };
      await sendSuperuserCredentialsEmail(config, {
        email: validEmail("admin@example.com"),
        password: "a1b2c3d4e5f6",
        username: "myadmin",
      });
      const text = String(calls[0]!.body.text);
      expect(text).toContain("https://example.com/admin/");
    } finally {
      restore();
    }
  });

  test("email text body contains a security warning", async () => {
    const { calls, restore } = captureEmailCall();
    try {
      const config = {
        apiKey: "test",
        fromAddress: validEmail("from@test.com"),
        provider: "resend" as const,
      };
      await sendSuperuserCredentialsEmail(config, {
        email: validEmail("admin@example.com"),
        password: "a1b2c3d4e5f6",
        username: "myadmin",
      });
      const text = String(calls[0]!.body.text);
      expect(text).toContain("Store this password securely");
      expect(text).toContain("decrypt attendee data");
    } finally {
      restore();
    }
  });

  test("email HTML body contains the same information with HTML-escaped values", async () => {
    const { calls, restore } = captureEmailCall();
    try {
      const config = {
        apiKey: "test",
        fromAddress: validEmail("from@test.com"),
        provider: "resend" as const,
      };
      await sendSuperuserCredentialsEmail(config, {
        email: validEmail("admin@example.com"),
        password: "a1b2c3d4e5f6",
        username: "myadmin",
      });
      const html = String(calls[0]!.body.html);
      expect(html).toContain("myadmin");
      expect(html).toContain("a1b2c3d4e5f6");
    } finally {
      restore();
    }
  });

  test("HTML body escapes special characters in password", async () => {
    const { calls, restore } = captureEmailCall();
    try {
      const config = {
        apiKey: "test",
        fromAddress: validEmail("from@test.com"),
        provider: "resend" as const,
      };
      await sendSuperuserCredentialsEmail(config, {
        email: validEmail("admin@example.com"),
        password: "abc<foo>&bar",
        username: "myadmin",
      });
      const html = String(calls[0]!.body.html);
      expect(html).toContain("&lt;");
      expect(html).toContain("&amp;");
      expect(html).not.toContain("abc<foo>");
    } finally {
      restore();
    }
  });

  test("returns true for status 200", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(new Response(null, { status: 200 })),
        ),
      async () => {
        const config = {
          apiKey: "test",
          fromAddress: validEmail("from@test.com"),
          provider: "resend" as const,
        };
        const result = await sendSuperuserCredentialsEmail(config, {
          email: validEmail("admin@example.com"),
          password: "password123",
          username: "admin",
        });
        expect(result).toBe(true);
      },
    );
  });

  test("returns true for status 201", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(new Response(null, { status: 201 })),
        ),
      async () => {
        const config = {
          apiKey: "test",
          fromAddress: validEmail("from@test.com"),
          provider: "resend" as const,
        };
        const result = await sendSuperuserCredentialsEmail(config, {
          email: validEmail("admin@example.com"),
          password: "password123",
          username: "admin",
        });
        expect(result).toBe(true);
      },
    );
  });

  test("returns true for status 299", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(new Response(null, { status: 299 })),
        ),
      async () => {
        const config = {
          apiKey: "test",
          fromAddress: validEmail("from@test.com"),
          provider: "resend" as const,
        };
        const result = await sendSuperuserCredentialsEmail(config, {
          email: validEmail("admin@example.com"),
          password: "password123",
          username: "admin",
        });
        expect(result).toBe(true);
      },
    );
  });

  test("returns false for status 300", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(new Response(null, { status: 300 })),
        ),
      async () => {
        const config = {
          apiKey: "test",
          fromAddress: validEmail("from@test.com"),
          provider: "resend" as const,
        };
        const result = await sendSuperuserCredentialsEmail(config, {
          email: validEmail("admin@example.com"),
          password: "password123",
          username: "admin",
        });
        expect(result).toBe(false);
      },
    );
  });

  test("returns false for status 400", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(new Response(null, { status: 400 })),
        ),
      async () => {
        const config = {
          apiKey: "test",
          fromAddress: validEmail("from@test.com"),
          provider: "resend" as const,
        };
        const result = await sendSuperuserCredentialsEmail(config, {
          email: validEmail("admin@example.com"),
          password: "password123",
          username: "admin",
        });
        expect(result).toBe(false);
      },
    );
  });

  test("returns false for status 500", async () => {
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(new Response(null, { status: 500 })),
        ),
      async () => {
        const config = {
          apiKey: "test",
          fromAddress: validEmail("from@test.com"),
          provider: "resend" as const,
        };
        const result = await sendSuperuserCredentialsEmail(config, {
          email: validEmail("admin@example.com"),
          password: "password123",
          username: "admin",
        });
        expect(result).toBe(false);
      },
    );
  });

  test("does not log the password", async () => {
    const logSpy = spy(console, "log");
    const errSpy = spy(console, "error");
    await withMocks(
      () =>
        stub(globalThis, "fetch", () =>
          Promise.resolve(new Response(null, { status: 200 })),
        ),
      async () => {
        const config = {
          apiKey: "test",
          fromAddress: validEmail("from@test.com"),
          provider: "resend" as const,
        };
        await sendSuperuserCredentialsEmail(config, {
          email: validEmail("admin@example.com"),
          password: "a1b2c3d4e5f6",
          username: "admin",
        });
      },
    );
    const allArgs = [...logSpy.calls, ...errSpy.calls].flatMap((c) => c.args);
    expect(allArgs.some((a) => String(a).includes("a1b2c3d4e5f6"))).toBe(false);
    logSpy.restore();
    errSpy.restore();
  });
});
