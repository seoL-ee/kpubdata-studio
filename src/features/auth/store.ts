/**
 * 인증 상태 관리 (S3/#188, #263에서 generic 세션으로 확장).
 *
 * 토큰은 메모리(zustand store)에만 보관한다 — persist 미들웨어 사용 금지.
 * localStorage/sessionStorage에 토큰을 쓰면 XSS 한 번으로 탈취된다.
 * 새로고침 시 세션 복원은 Keycloak silent SSO(`initKeycloak`)가 담당한다.
 *
 * mock/email 로그인(setSession)과 OIDC 세션(setOidcIdentity)이 이 store 하나를 공유해
 * topbar avatar(#191)/Settings/LoginGate(#190)가 어느 provider로 로그인했는지 신경 쓰지
 * 않고 동일하게 동작한다.
 */
import { create } from "zustand";
import type { AuthProviderId, AuthSession } from "./types";

/**
 * OIDC(Keycloak) 부트스트랩 상태.
 *
 * mock/데모나 dev bypass 환경에서는 "disabled"로 남는다 — 이 경우 LoginGate는 기존
 * 정책(mock 토큰 유무)을 그대로 따른다.
 */
export type OidcStatus =
  | "disabled"
  | "initializing"
  | "authenticated"
  | "unauthenticated"
  | "error";

interface AuthState {
  /**
   * Builder로 보낼 Bearer 토큰 (mock 세션 토큰). null이면 미로그인.
   *
   * OIDC(Keycloak) 세션의 access token은 여기 저장하지 않는다 — keycloak-js 메모리
   * 세션이 authoritative source이고, store 사본은 refresh 후 stale이 되기 때문이다.
   * Builder 요청은 `keycloak.ts`의 `getFreshToken()`을 통해 최신 토큰을 받는다.
   */
  token: string | null;
  /** 로그인된 사용자 이메일 (UI 표시용, S6/#191). */
  email: string | null;
  /** 표시용 이름. provider가 이름을 주지 않으면 null(#263). */
  name: string | null;
  userId: string | null;
  /** 이 세션을 만든 provider. 미로그인이면 null(#263). */
  providerId: AuthProviderId | null;
  /** OIDC 부트스트랩 상태. mock/데모에서는 "disabled". */
  oidcStatus: OidcStatus;
  /** generic {@link AuthProvider}(mock/#263)가 반환한 세션을 그대로 저장한다. */
  setSession: (session: AuthSession) => void;
  /**
   * Keycloak 세션에서 확인한 사용자 신원(표시용)만 저장한다. raw access token은
   * store에 넣지 않는다(위 `token` 주석 참고).
   */
  setOidcIdentity: (identity: { email: string | null; name: string | null; userId: string | null }) => void;
  /** OIDC 부트스트랩 상태 전이. */
  setOidcStatus: (status: OidcStatus) => void;
  /** 로그아웃 — 세션 전체를 폐기(OIDC 부트스트랩 상태는 호출부가 별도로 관리). */
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  email: null,
  name: null,
  userId: null,
  providerId: null,
  oidcStatus: "disabled",
  setSession: (session) =>
    set({
      token: session.token,
      email: session.email,
      name: session.name,
      userId: null,
      providerId: session.provider,
    }),
  setOidcIdentity: ({ email, name, userId }) =>
    set({ token: null, email, name, userId, providerId: "keycloak" }),
  setOidcStatus: (oidcStatus) => set({ oidcStatus }),
  clear: () => set({ token: null, email: null, name: null, userId: null, providerId: null }),
}));
