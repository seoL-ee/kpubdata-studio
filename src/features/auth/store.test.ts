/**
 * useAuthStore (#188, #263 generic 세션 확장) 테스트.
 *
 * setSession(mock/generic AuthProvider)과 setOidcIdentity(Keycloak)가 같은 store를
 * 공유하면서 서로의 필드를 오염시키지 않는지, 그리고 password가 store 어디에도 남지
 * 않는지 확인한다.
 */
import { afterEach, describe, expect, it } from "vitest";
import { useAuthStore } from "./store";
import type { AuthSession } from "./types";

afterEach(() => {
  useAuthStore.getState().clear();
});

describe("useAuthStore", () => {
  it("starts logged out", () => {
    const state = useAuthStore.getState();
    expect(state).toMatchObject({ token: null, email: null, name: null, providerId: null });
  });

  it("setOidcIdentity records the identity without ever holding a raw token", () => {
    useAuthStore.getState().setOidcIdentity({
      email: "user@example.com",
      name: "테스터",
      userId: "sub-1",
    });
    expect(useAuthStore.getState()).toMatchObject({
      token: null,
      email: "user@example.com",
      name: "테스터",
      userId: "sub-1",
      providerId: "keycloak",
    });
  });

  it("setSession stores a full generic AuthSession (mock/#263)", () => {
    const session: AuthSession = {
      token: "mock-session-abc",
      email: "person@example.com",
      name: "홍길동",
      provider: "mock",
    };
    useAuthStore.getState().setSession(session);
    expect(useAuthStore.getState()).toMatchObject({
      token: "mock-session-abc",
      email: "person@example.com",
      name: "홍길동",
      providerId: "mock",
    });
  });

  it("clear resets every field regardless of which provider logged in", () => {
    useAuthStore.getState().setSession({
      token: "mock-session-abc",
      email: "person@example.com",
      name: "홍길동",
      provider: "mock",
    });
    useAuthStore.getState().clear();
    expect(useAuthStore.getState()).toMatchObject({
      token: null,
      email: null,
      name: null,
      providerId: null,
    });
  });

  it("never stores a password field — the state shape only has session data", () => {
    useAuthStore.getState().setSession({
      token: "mock-session-abc",
      email: "person@example.com",
      name: "홍길동",
      provider: "mock",
    });
    const state = useAuthStore.getState();
    expect(Object.keys(state)).not.toContain("password");
    expect(JSON.stringify(state)).not.toMatch(/password/i);
  });
});
