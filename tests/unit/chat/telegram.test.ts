import { describe, expect, test } from "bun:test";
import { TelegramPlatform } from "../../../src/chat/platforms/telegram";

// Test the authorization logic by accessing the private method via bracket notation.
// This is a pragmatic approach for testing internal authorization logic.

function createPlatform(allowedUsers?: Record<string, string[]>): TelegramPlatform {
  return new TelegramPlatform({
    home: "/tmp/test",
    token: "test-token",
    allowedUsers,
  });
}

function mockCtx(opts: { userId?: string; chatId?: string; chatType?: string }): unknown {
  return {
    from: opts.userId ? { id: Number(opts.userId) } : undefined,
    chat: opts.chatId ? { id: Number(opts.chatId), type: opts.chatType ?? "private" } : undefined,
  };
}

describe("isUserAllowedForChat", () => {
  test("returns false when no allowed users configured", () => {
    const platform = createPlatform(undefined);
    const allowed = (platform as any).isUserAllowedForChat(
      mockCtx({ userId: "123", chatId: "123", chatType: "private" }),
    );
    expect(allowed).toBe(false);
  });

  test("wildcard user allowed in private chat", () => {
    const platform = createPlatform({ "123": ["*"] });
    const allowed = (platform as any).isUserAllowedForChat(
      mockCtx({ userId: "123", chatId: "123", chatType: "private" }),
    );
    expect(allowed).toBe(true);
  });

  test("wildcard user allowed in any group chat", () => {
    const platform = createPlatform({ "123": ["*"] });
    const allowed = (platform as any).isUserAllowedForChat(
      mockCtx({ userId: "123", chatId: "-1001234567890", chatType: "supergroup" }),
    );
    expect(allowed).toBe(true);
  });

  test("topic-only user rejected in private chat", () => {
    const platform = createPlatform({ "456": ["-1001234567890"] });
    const allowed = (platform as any).isUserAllowedForChat(
      mockCtx({ userId: "456", chatId: "456", chatType: "private" }),
    );
    expect(allowed).toBe(false);
  });

  test("topic-only user allowed in their assigned group", () => {
    const platform = createPlatform({ "456": ["-1001234567890"] });
    const allowed = (platform as any).isUserAllowedForChat(
      mockCtx({ userId: "456", chatId: "-1001234567890", chatType: "supergroup" }),
    );
    expect(allowed).toBe(true);
  });

  test("topic-only user rejected in a different group", () => {
    const platform = createPlatform({ "456": ["-1001234567890"] });
    const allowed = (platform as any).isUserAllowedForChat(
      mockCtx({ userId: "456", chatId: "-1009999999999", chatType: "supergroup" }),
    );
    expect(allowed).toBe(false);
  });

  test("unknown user rejected everywhere", () => {
    const platform = createPlatform({ "123": ["*"] });
    const allowed = (platform as any).isUserAllowedForChat(
      mockCtx({ userId: "999", chatId: "999", chatType: "private" }),
    );
    expect(allowed).toBe(false);
  });

  test("user with multiple channels allowed in any of them", () => {
    const platform = createPlatform({ "456": ["-100111", "-100222"] });

    expect(
      (platform as any).isUserAllowedForChat(
        mockCtx({ userId: "456", chatId: "-100111", chatType: "supergroup" }),
      ),
    ).toBe(true);

    expect(
      (platform as any).isUserAllowedForChat(
        mockCtx({ userId: "456", chatId: "-100222", chatType: "supergroup" }),
      ),
    ).toBe(true);

    expect(
      (platform as any).isUserAllowedForChat(
        mockCtx({ userId: "456", chatId: "-100333", chatType: "supergroup" }),
      ),
    ).toBe(false);
  });

  test("returns false when no userId in context", () => {
    const platform = createPlatform({ "123": ["*"] });
    const allowed = (platform as any).isUserAllowedForChat(
      mockCtx({ chatId: "123", chatType: "private" }),
    );
    expect(allowed).toBe(false);
  });

  test("group chat type allows channel-specific access", () => {
    const platform = createPlatform({ "456": ["-100111"] });
    // "group" type (not just supergroup)
    const allowed = (platform as any).isUserAllowedForChat(
      mockCtx({ userId: "456", chatId: "-100111", chatType: "group" }),
    );
    expect(allowed).toBe(true);
  });
});
