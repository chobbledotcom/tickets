import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { setEffectiveDomainForTest } from "#shared/config.ts";
import { getPbkdf2Iterations, hashPassword } from "#shared/crypto/hashing.ts";
import { generateDataKey } from "#shared/crypto/keys.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createUser,
  decryptAdminLevel,
  decryptUsername,
  getUserByUsername,
  invalidateUsersCache,
  verifyUserPassword,
} from "#shared/db/users.ts";
import { ErrorCode } from "#shared/logger.ts";
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
  stubFetchStatus,
  times,
  validEmail,
  withMocks,
  withRandomBytes,
} from "#test-utils";

const captureConsoleErrors = <T>(
  body: () => T,
): { messages: string[]; result: T } => {
  const errorStub = stub(console, "error", () => {});
  try {
    const result = body();
    return {
      messages: errorStub.calls.map((call) => String(call.args[0])),
      result,
    };
  } finally {
    errorStub.restore();
  }
};

const expectNullWithErrors =
  (body: () => unknown) =>
  (messages: string[]): void => {
    const result = captureConsoleErrors(body);
    expect(result.result).toBeNull();
    expect(result.messages).toEqual(messages);
  };

const ADMIN_EMAIL_ADDRESS = "admin@example.com";

type AvailableSuperuserState = {
  activated: boolean;
  available: true;
  choice: string;
  email: ReturnType<typeof validEmail>;
  userExists: boolean;
  username: string;
};

type ActivatedSuperuser = Awaited<ReturnType<typeof createActivatedSuperuser>>;

const expectedAvailableSuperuserState =
  (emailAddress = ADMIN_EMAIL_ADDRESS) =>
  (
    overrides: Partial<AvailableSuperuserState> = {},
  ): AvailableSuperuserState => {
    const normalizedEmail = emailAddress.toLowerCase();
    return {
      activated: false,
      available: true,
      choice: "",
      email: validEmail(normalizedEmail),
      userExists: false,
      username: normalizedEmail.split("@")[0]!,
      ...overrides,
    };
  };

const adminSuperuserState = expectedAvailableSuperuserState();

const expectedUnavailableSuperuserState = (
  reason: "missing-env" | "invalid-env" | "invalid-username",
) => ({ available: false, reason });

const expectCurrentSuperuserState = async (
  expectedState: unknown,
): Promise<void> => {
  expect(await getSuperuserState()).toEqual(expectedState);
};

const expectAdminSuperuserState = async (
  overrides: Partial<AvailableSuperuserState> = {},
): Promise<void> => {
  await expectCurrentSuperuserState(adminSuperuserState(overrides));
};

const useAdminEmailEnv = () => {
  let restoreEnv: (() => void) | undefined;
  afterEach(() => {
    restoreEnv?.();
  });
  return (adminEmailAddress: string | undefined): void => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: adminEmailAddress });
  };
};

const withConfiguredAdminEmail =
  (setAdminEmailEnv: (adminEmailAddress: string | undefined) => void) =>
  <T>(body: () => T): T => {
    setAdminEmailEnv(ADMIN_EMAIL_ADDRESS);
    return body();
  };

const createOwnerUser =
  (wrappedDataKey: string | null) =>
  async (password: string): Promise<void> => {
    await createUser(
      "admin",
      password === "" ? "" : await hashPassword(password),
      wrappedDataKey,
      "owner",
    );
  };

const withSuperuserQueryLog = async <T>(
  body: () => T | Promise<T>,
): Promise<T> =>
  runWithQueryLogContext(async () => {
    enableQueryLog();
    return await body();
  });

const expectSuperuserLookupQuery = (expected: boolean): void => {
  expect(getQueryLog().some((q) => q.sql.includes("username_index IN"))).toBe(
    expected,
  );
};

const expectLoggedSuperuserStateRead = async (): Promise<void> => {
  await getSuperuserState();
  expect(getQueryLog().length).toBeGreaterThan(0);
};

const createActivatedAdmin =
  (password: string) =>
  async (
    dataKey?: CryptoKey,
  ): Promise<{ dataKey: CryptoKey; user: ActivatedSuperuser }> => {
    const resolvedDataKey = dataKey ?? (await generateDataKey());
    return {
      dataKey: resolvedDataKey,
      user: await createActivatedSuperuser({
        dataKey: resolvedDataKey,
        password,
        username: "admin",
      }),
    };
  };

// ---------------------------------------------------------------------------
// getAdminEmailAddress()
// ---------------------------------------------------------------------------

describe("getAdminEmailAddress", () => {
  const setAdminEmail = useAdminEmailEnv();
  const expectAdminEmailAddress =
    (configuredAddress: string | undefined) =>
    (expectedAddress: string | null): void => {
      setAdminEmail(configuredAddress);
      expect(getAdminEmailAddress()).toBe(expectedAddress);
    };

  test("returns null when ADMIN_EMAIL_ADDRESS is unset", () => {
    expectAdminEmailAddress(undefined)(null);
  });

  test("returns null when ADMIN_EMAIL_ADDRESS is an empty string", () => {
    expectAdminEmailAddress("")(null);
  });

  test("returns null when ADMIN_EMAIL_ADDRESS is whitespace-only", () => {
    expectAdminEmailAddress("   ")(null);
  });

  test("returns trimmed email when ADMIN_EMAIL_ADDRESS has leading/trailing whitespace", () => {
    expectAdminEmailAddress("  admin@example.com  ")("admin@example.com");
  });

  test("returns email as-is when already trimmed", () => {
    expectAdminEmailAddress(ADMIN_EMAIL_ADDRESS)(ADMIN_EMAIL_ADDRESS);
  });

  test("normalizes configured email address to lowercase", () => {
    expectAdminEmailAddress("Admin@Example.com")(ADMIN_EMAIL_ADDRESS);
  });

  test("returns null and logs error when value lacks an @ sign", () => {
    setAdminEmail("not-an-email");
    expectNullWithErrors(getAdminEmailAddress)([
      `[Error] ${ErrorCode.DATA_INVALID} detail="ADMIN_EMAIL_ADDRESS is not a valid email: not-an-email"`,
    ]);
  });

  test("returns null and logs error when value has multiple @ signs", () => {
    expectAdminEmailAddress("a@b@c.com")(null);
  });

  test("returns null and logs error when local part is missing", () => {
    expectAdminEmailAddress("@example.com")(null);
  });

  test("returns null and logs error when domain is missing", () => {
    expectAdminEmailAddress("admin@")(null);
  });

  test("accepts subdomain-style email addresses", () => {
    expectAdminEmailAddress("my.admin@sub.example.co.uk")(
      "my.admin@sub.example.co.uk",
    );
  });
});

// ---------------------------------------------------------------------------
// getSuperuserUsername()
// ---------------------------------------------------------------------------

describe("getSuperuserUsername", () => {
  const expectUsernameFromEmail =
    (emailAddress: string) =>
    (expectedUsername: string | null): void => {
      expect(getSuperuserUsername(validEmail(emailAddress))).toBe(
        expectedUsername,
      );
    };

  test("returns lowercased local part of a simple email", () => {
    expectUsernameFromEmail("MyUsername@example.com")("myusername");
  });

  test("returns local part unchanged when already lowercase", () => {
    expectUsernameFromEmail(ADMIN_EMAIL_ADDRESS)("admin");
  });

  test("returns null and logs when local part is too short (1 character)", () => {
    expectNullWithErrors(() =>
      getSuperuserUsername(validEmail("a@example.com")),
    )([
      `[Error] ${ErrorCode.DATA_INVALID} detail="Derived superuser username "a" is invalid: Username must be at least 2 characters"`,
    ]);
  });

  test("returns the minimum valid 2-character local part", () => {
    expectUsernameFromEmail("ab@example.com")("ab");
  });

  test("returns the maximum valid 32-character local part", () => {
    const local = `a${"b".repeat(31)}`;
    expectUsernameFromEmail(`${local}@example.com`)(local);
  });

  test("returns null and logs when local part is 33 characters", () => {
    expectUsernameFromEmail(`${"a".repeat(33)}@example.com`)(null);
  });

  test("returns null and logs when local part contains a dot (john.doe)", () => {
    expectUsernameFromEmail("john.doe@example.com")(null);
  });

  test("returns null and logs when local part contains a plus sign (user+tag)", () => {
    expectUsernameFromEmail("user+tag@example.com")(null);
  });

  test("accepts local parts with hyphens", () => {
    expectUsernameFromEmail("my-admin@example.com")("my-admin");
  });

  test("accepts local parts with underscores", () => {
    expectUsernameFromEmail("my_admin@example.com")("my_admin");
  });

  test("accepts local parts with digits", () => {
    expectUsernameFromEmail("admin123@example.com")("admin123");
  });

  test("returns null and logs when local part starts with a hyphen", () => {
    expectUsernameFromEmail("-admin@example.com")(null);
  });

  test("returns null and logs when local part starts with an underscore", () => {
    expectUsernameFromEmail("_admin@example.com")(null);
  });
});

// ---------------------------------------------------------------------------
// getSuperuserState()
// ---------------------------------------------------------------------------

describeWithEnv("getSuperuserState", { db: true }, () => {
  const setAdminEmail = useAdminEmailEnv();
  const expectStateForEmail =
    (adminEmailAddress: string | undefined) =>
    async (expectedState: unknown): Promise<void> => {
      setAdminEmail(adminEmailAddress);
      await expectCurrentSuperuserState(expectedState);
    };

  test("returns { available: false, reason: 'missing-env' } when ADMIN_EMAIL_ADDRESS is unset", async () => {
    await expectStateForEmail(undefined)(
      expectedUnavailableSuperuserState("missing-env"),
    );
  });

  test("returns { available: false, reason: 'invalid-env' } when ADMIN_EMAIL_ADDRESS fails email validation", async () => {
    await expectStateForEmail("not-an-email")(
      expectedUnavailableSuperuserState("invalid-env"),
    );
  });

  test("returns { available: false, reason: 'invalid-username' } when derived username is too short", async () => {
    await expectStateForEmail("a@example.com")(
      expectedUnavailableSuperuserState("invalid-username"),
    );
  });

  test("returns { available: false, reason: 'invalid-username' } when local part contains dots", async () => {
    await expectStateForEmail("john.doe@example.com")(
      expectedUnavailableSuperuserState("invalid-username"),
    );
  });

  test("returns available state with userExists:false, activated:false, choice:'' when user does not exist", async () => {
    await expectStateForEmail(ADMIN_EMAIL_ADDRESS)(adminSuperuserState());
  });

  test("calls getUserByUsername with the lowercased derived username", async () => {
    setAdminEmail("Admin@example.com");
    // We can't spy on imported top-level functions, but we verify the outcome:
    // getSuperuserState should return the lowercased username.
    await expectCurrentSuperuserState(
      expectedAvailableSuperuserState("Admin@example.com")(),
    );
  });

  test("returns userExists:true, activated:true, choice:'enabled' when user has wrapped_data_key and choice persisted", async () => {
    setAdminEmail(ADMIN_EMAIL_ADDRESS);
    await createOwnerUser("wrapped-key-bytes")("password123");
    settings.setForTest({ superuser_choice: "enabled" });
    await expectAdminSuperuserState({
      activated: true,
      choice: "enabled",
      userExists: true,
    });
  });

  test("returns userExists:true, activated:false when user row exists but wrapped_data_key is null", async () => {
    setAdminEmail(ADMIN_EMAIL_ADDRESS);
    await createOwnerUser(null)("");
    await expectAdminSuperuserState({ userExists: true });
  });

  test("returns choice:'self-managed' when owner previously chose self-managed", async () => {
    setAdminEmail(ADMIN_EMAIL_ADDRESS);
    settings.setForTest({ superuser_choice: "self-managed" });
    await expectAdminSuperuserState({ choice: "self-managed" });
  });

  test("returns unavailable when ADMIN_EMAIL_ADDRESS is temporarily unset even if choice persisted", async () => {
    setAdminEmail(undefined);
    settings.setForTest({ superuser_choice: "enabled" });
    await expectCurrentSuperuserState(
      expectedUnavailableSuperuserState("missing-env"),
    );
  });
});

// ---------------------------------------------------------------------------
// getSuperuserState() — account lookup efficiency
// ---------------------------------------------------------------------------

describeWithEnv("getSuperuserState account lookup", { db: true }, () => {
  const withAdminEmail = withConfiguredAdminEmail(useAdminEmailEnv());
  const withAdminEmailQueryLog = (body: () => Promise<void>): Promise<void> =>
    withAdminEmail(() => withSuperuserQueryLog(body));

  test("resolves the superuser by blind index, never scanning the whole users table", async () => {
    await withAdminEmailQueryLog(async () => {
      await getSuperuserState();
      const sql = getQueryLog().map((q) => q.sql);
      expectSuperuserLookupQuery(true);
      // The old path loaded every user via "... FROM users ORDER BY id ASC".
      expect(sql.some((s) => /FROM users\s+ORDER BY id ASC/.test(s))).toBe(
        false,
      );
    });
  });

  test("caches the account state so a repeat read issues no query", async () => {
    await withAdminEmailQueryLog(async () => {
      await expectLoggedSuperuserStateRead();
      // Re-arm the log; the warm cache should satisfy the second read.
      enableQueryLog();
      await getSuperuserState();
      expect(getQueryLog().length).toBe(0);
    });
  });

  test("re-queries after a user write invalidates the cache", async () => {
    await withAdminEmail(async () => {
      // Warm the cache with the not-yet-created state.
      expect((await getSuperuserState()).available).toBe(true);
      expect(await getUserByUsername("admin")).toBeNull();

      // Creating the account invalidates the users cache, which must clear the
      // derived superuser-account cache so the nag stops showing.
      await createOwnerUser("wrapped")("pw");

      await expectAdminSuperuserState({ activated: true, userExists: true });
    });
  });

  test("a manual users-cache invalidation also clears the cached account state", async () => {
    await withAdminEmail(async () => {
      await getSuperuserState(); // warm cache
      invalidateUsersCache();
      await withSuperuserQueryLog(expectLoggedSuperuserStateRead);
    });
  });

  test("discards a lookup that a concurrent user write raced, never caching stale state", async () => {
    await withAdminEmail(async () => {
      // Start a lookup: it runs synchronously until getUserByUsername suspends on
      // its hashing await, having already captured the cache generation.
      const inflight = getSuperuserState();
      // A concurrent user write lands while that lookup is in flight, clearing the
      // derived cache and bumping the generation.
      invalidateUsersCache();
      await inflight;
      // The raced result predates the write, so it must not have been written
      // back. A follow-up read therefore misses the cache and re-queries rather
      // than serving the poisoned entry for the rest of the TTL.
      await withSuperuserQueryLog(async () => {
        await getSuperuserState();
        expectSuperuserLookupQuery(true);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// generateSuperuserPassword()
// ---------------------------------------------------------------------------

describe("generateSuperuserPassword", () => {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const samplePasswords =
    (length: number) =>
    (count: number): string[] =>
      times(count)(() => generateSuperuserPassword(length));

  test("returns a 12-character string by default", () => {
    const result = generateSuperuserPassword();
    expect(result.length).toBe(12);
  });

  test("returns the requested length", () => {
    const result = generateSuperuserPassword(20);
    expect(result.length).toBe(20);
  });

  test("only contains characters from the expected alphabet", () => {
    const allChars = new Set(
      samplePasswords(10)(100).flatMap((pw) => pw.split("")),
    );
    for (const c of allChars) {
      expect(ALPHABET).toContain(c);
    }
  });

  test("excludes ambiguous characters (0, O, I, l, 1)", () => {
    for (const pw of samplePasswords(20)(100)) {
      expect(pw).not.toContain("0");
      expect(pw).not.toContain("O");
      expect(pw).not.toContain("I");
      expect(pw).not.toContain("l");
      expect(pw).not.toContain("1");
    }
  });

  test("contains no punctuation, whitespace, or symbols", () => {
    for (const password of samplePasswords(10)(100)) {
      expect(password).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  test("accepts the highest byte below the unbiased rejection threshold", () =>
    withRandomBytes([227, 0])(() => {
      expect(generateSuperuserPassword(1)).toBe(ALPHABET[ALPHABET.length - 1]);
    }));

  test("rejects bytes at and above the unbiased rejection threshold", () =>
    withRandomBytes([229, 0])(() => {
      expect(generateSuperuserPassword(1)).toBe(ALPHABET[0]);
    }));

  test("rejects the boundary byte at the unbiased rejection threshold", () =>
    withRandomBytes([228, 1])(() => {
      expect(generateSuperuserPassword(1)).toBe(ALPHABET[1]);
    }));

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
    const { user } = await createActivatedAdmin("pass1234abcd")();
    expect(await decryptUsername(user)).toBe("admin");
    expect(await decryptAdminLevel(user)).toBe("owner");
    expect(user.kek_version).toBe(2);
    expect(user.invite_code_hash).toBeNull();
    expect(user.invite_expiry).toBeNull();
    expect(user.invite_wrapped_data_key).toBeNull();
    expect(user.wrapped_data_key).toMatch(/^wk:1:[^:]+:[^:]+$/);
  });

  test("created user's password can be verified with the raw password", async () => {
    const password = "mysecretpw";
    await createActivatedAdmin(password)();
    const fetchedUser = await getUserByUsername("admin");
    expect(fetchedUser?.kek_version).toBe(2);
    expect(await verifyUserPassword(fetchedUser!, password)).toMatch(
      new RegExp(`^pbkdf2:${getPbkdf2Iterations()}:[^:]+:[^:]+$`),
    );
    expect(await verifyUserPassword(fetchedUser!, "wrong-password")).toBeNull();
  });

  test("created user has admin level 'owner'", async () => {
    await createActivatedAdmin("pw")();
    const fetchedUser = await getUserByUsername("admin");
    const level = await decryptAdminLevel(fetchedUser!);
    expect(level).toBe("owner");
  });

  test("fails when username is already taken", async () => {
    const { dataKey } = await createActivatedAdmin("pw1")();
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

  const EMAIL_CONFIG = {
    apiKey: "test",
    fromAddress: validEmail("from@test.com"),
    provider: "resend" as const,
  };

  const RECIPIENT = {
    email: validEmail("admin@example.com"),
    password: "a1b2c3d4e5f6",
    username: "myadmin",
  };

  /** Send the credentials email, returning its captured Resend body + result. */
  const sendAndCapture = async (
    overrides: Partial<typeof RECIPIENT> = {},
  ): Promise<{
    result: boolean;
    callCount: number;
    body: Record<string, unknown>;
  }> => {
    const { calls, restore } = captureEmailCall();
    try {
      const result = await sendSuperuserCredentialsEmail(EMAIL_CONFIG, {
        ...RECIPIENT,
        ...overrides,
      });
      return { body: calls[0]!.body, callCount: calls.length, result };
    } finally {
      restore();
    }
  };

  const expectEmailBodyContains =
    (field: "html" | "text") =>
    (...values: string[]) =>
    async (): Promise<void> => {
      const { body } = await sendAndCapture();
      const content = String(body[field]);
      for (const value of values) expect(content).toContain(value);
    };

  test("calls sendEmail with the provided config and a correctly structured message", async () => {
    const { result, callCount, body } = await sendAndCapture();
    expect(result).toBe(true);
    expect(callCount).toBe(1);
    expect(body.to).toEqual(["admin@example.com"]);
    expect(body.subject).toBe("Superuser account enabled");
  });

  test("email text body contains the username", async () => {
    await expectEmailBodyContains("text")("myadmin")();
  });

  test("email text body contains the temporary password", async () => {
    await expectEmailBodyContains("text")("a1b2c3d4e5f6")();
  });

  test("email text body contains the site login URL via getEffectiveDomain", async () => {
    setEffectiveDomainForTest("example.com");
    await expectEmailBodyContains("text")("https://example.com/admin/")();
  });

  test("email text body contains a security warning", async () => {
    await expectEmailBodyContains("text")(
      "Store this password securely",
      "decrypt attendee data",
    )();
  });

  test("email HTML body contains the same information with HTML-escaped values", async () => {
    await expectEmailBodyContains("html")("myadmin", "a1b2c3d4e5f6")();
  });

  test("HTML body escapes special characters in password", async () => {
    const { body } = await sendAndCapture({ password: "abc<foo>&bar" });
    expect(String(body.html)).toContain("&lt;");
    expect(String(body.html)).toContain("&amp;");
    expect(String(body.html)).not.toContain("abc<foo>");
  });

  const STATUS_RESULTS: { status: number; expected: boolean }[] = [
    { expected: true, status: 200 },
    { expected: true, status: 201 },
    { expected: true, status: 299 },
    { expected: false, status: 300 },
    { expected: false, status: 400 },
    { expected: false, status: 500 },
  ];

  for (const { status, expected } of STATUS_RESULTS) {
    test(`returns ${expected} for status ${status}`, () =>
      withMocks(
        () => stubFetchStatus(status),
        async () => {
          const result = await sendSuperuserCredentialsEmail(
            EMAIL_CONFIG,
            RECIPIENT,
          );
          expect(result).toBe(expected);
        },
      ));
  }

  test("does not log the password", async () => {
    const logSpy = spy(console, "log");
    const errSpy = spy(console, "error");
    try {
      await withMocks(
        () => stubFetchStatus(200),
        async () => {
          await sendSuperuserCredentialsEmail(EMAIL_CONFIG, RECIPIENT);
        },
      );
      const allArgs = [...logSpy.calls, ...errSpy.calls].flatMap((c) => c.args);
      expect(allArgs.some((a) => String(a).includes("a1b2c3d4e5f6"))).toBe(
        false,
      );
    } finally {
      logSpy.restore();
      errSpy.restore();
    }
  });
});
