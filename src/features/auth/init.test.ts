/**
 * initAuth (auth ↔ builderApi 배선 + OIDC 부트스트랩) 테스트.
 *
 * keycloak-js SDK 경계는 mock한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockKeycloak, KeycloakCtor } = vi.hoisted(() => {
  const mk = {
    authenticated: false as boolean,
    token: undefined as string | undefined,
    tokenParsed: undefined as unknown,
    init: vi.fn(),
    updateToken: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    onAuthSuccess: undefined as undefined | (() => void),
    onAuthRefreshSuccess: undefined as undefined | (() => void),
    onAuthLogout: undefined as undefined | (() => void),
    onTokenExpired: undefined as undefined | (() => void),
  };
  return { mockKeycloak: mk, KeycloakCtor: vi.fn(function () { return mk; }) };
});

vi.mock("keycloak-js", () => ({ default: KeycloakCtor }));

// initAuth가 builderApi에 등록하는 콜백을 가로채, 401 복구 계약을 직접 호출해 검증한다.
const wiring = vi.hoisted(() => ({
  authError: undefined as undefined | (() => void | boolean | Promise<void | boolean>),
  tokenProvider: undefined as undefined | (() => string | null | Promise<string | null>),
}));

vi.mock("@/shared/lib/builderApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/builderApi")>();
  return {
    ...actual,
    setAuthErrorCallback: (cb: typeof wiring.authError) => {
      wiring.authError = cb;
    },
    setAuthTokenProvider: (provider: typeof wiring.tokenProvider) => {
      wiring.tokenProvider = provider;
    },
  };
});

import { __resetKeycloakForTests } from "./keycloak";
import { initAuth } from "./init";
import { useAuthStore } from "./store";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.stubEnv("VITE_USE_REAL_BUILDER", "true");
  vi.stubEnv("VITE_OIDC_ISSUER", "http://localhost:8080/realms/kpubdata");
  vi.stubEnv("VITE_OIDC_CLIENT_ID", "kpubdata-studio");
  vi.stubEnv("VITE_DEV_BYPASS_AUTH", "false");

  KeycloakCtor.mockClear();
  mockKeycloak.authenticated = false;
  mockKeycloak.token = undefined;
  mockKeycloak.tokenParsed = undefined;
  mockKeycloak.init.mockReset().mockResolvedValue(false);
  mockKeycloak.updateToken.mockReset().mockResolvedValue(true);
  mockKeycloak.onAuthLogout = undefined;
  __resetKeycloakForTests();
  wiring.authError = undefined;
  wiring.tokenProvider = undefined;
  useAuthStore.getState().clear();
  useAuthStore.setState({ oidcStatus: "disabled" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetKeycloakForTests();
});

describe("initAuth — OIDC disabled (mock mode regression)", () => {
  it("leaves oidcStatus 'disabled' and never constructs Keycloak", async () => {
    vi.stubEnv("VITE_USE_REAL_BUILDER", "false");
    initAuth();
    await flush();
    expect(useAuthStore.getState().oidcStatus).toBe("disabled");
    expect(KeycloakCtor).not.toHaveBeenCalled();
  });
});

describe("initAuth — OIDC misconfigured (fail closed)", () => {
  it("sets oidcStatus 'error' without assuming the user is authenticated", async () => {
    vi.stubEnv("VITE_OIDC_ISSUER", "");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    initAuth();
    await flush();

    expect(useAuthStore.getState().oidcStatus).toBe("error");
    expect(useAuthStore.getState().email).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("initAuth — OIDC enabled", () => {
  it("goes initializing → authenticated and records the identity from token claims", async () => {
    mockKeycloak.init.mockResolvedValue(true);
    mockKeycloak.authenticated = true;
    mockKeycloak.tokenParsed = { email: "tester@example.com", name: "테스터" };

    initAuth();
    // 동기 지점에서는 이미 initializing.
    expect(useAuthStore.getState().oidcStatus).toBe("initializing");

    await flush();

    expect(useAuthStore.getState().oidcStatus).toBe("authenticated");
    expect(useAuthStore.getState().email).toBe("tester@example.com");
    expect(useAuthStore.getState().name).toBe("테스터");
    // raw token은 store에 저장하지 않는다.
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("goes initializing → unauthenticated when no existing session is found", async () => {
    mockKeycloak.init.mockResolvedValue(false);
    initAuth();
    await flush();
    expect(useAuthStore.getState().oidcStatus).toBe("unauthenticated");
  });

  it("fails closed to 'error' when init rejects (no retry loop)", async () => {
    mockKeycloak.init.mockRejectedValue(new Error("kc down"));
    initAuth();
    await flush();
    expect(useAuthStore.getState().oidcStatus).toBe("error");
  });

  it("clears the session on a Keycloak logout event", async () => {
    mockKeycloak.init.mockResolvedValue(true);
    mockKeycloak.authenticated = true;
    mockKeycloak.tokenParsed = { email: "tester@example.com" };

    initAuth();
    await flush();
    expect(useAuthStore.getState().oidcStatus).toBe("authenticated");

    mockKeycloak.onAuthLogout?.();
    expect(useAuthStore.getState().oidcStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().email).toBeNull();
  });
});

describe("initAuth — 401 복구 계약 (#189)", () => {
  it("refresh에 성공하면 true를 반환해 요청 재시도를 허용한다", async () => {
    mockKeycloak.init.mockResolvedValue(true);
    mockKeycloak.authenticated = true;
    mockKeycloak.tokenParsed = { email: "tester@example.com" };
    mockKeycloak.token = "fresh-token";

    initAuth();
    await flush();

    await expect(wiring.authError?.()).resolves.toBe(true);
    // 세션은 유지된다 — 재로그인으로 내보내지 않는다.
    expect(useAuthStore.getState().oidcStatus).toBe("authenticated");
    // 갱신된 토큰은 token provider를 통해 노출된다(store에는 저장하지 않는다).
    await expect(wiring.tokenProvider?.()).resolves.toBe("fresh-token");
  });

  it("refresh에 실패하면 false를 반환하고 unauthenticated로 내린다", async () => {
    mockKeycloak.init.mockResolvedValue(true);
    mockKeycloak.authenticated = true;
    mockKeycloak.tokenParsed = { email: "tester@example.com" };
    mockKeycloak.updateToken.mockRejectedValue(new Error("refresh expired"));

    initAuth();
    await flush();

    await expect(wiring.authError?.()).resolves.toBe(false);
    expect(useAuthStore.getState().oidcStatus).toBe("unauthenticated");
    expect(useAuthStore.getState().email).toBeNull();
  });

  it("mock/데모 모드에서는 세션만 비우고 재시도를 허용하지 않는다", async () => {
    vi.stubEnv("VITE_USE_REAL_BUILDER", "false");
    initAuth();
    await flush();
    useAuthStore.getState().setSession({
      token: "mock-token",
      email: "demo@example.com",
      name: null,
      provider: "mock",
    });

    await expect(wiring.authError?.()).resolves.toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
  });
});
