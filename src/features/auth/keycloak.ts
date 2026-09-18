/**
 * Keycloak OIDC client 싱글턴 (ADR 0015).
 *
 * public SPA + Authorization Code Flow + PKCE(S256), client secret 없음.
 * access/refresh token은 keycloak-js 메모리 세션에만 존재한다 — Studio는
 * localStorage/sessionStorage/DOM/로그 어디에도 raw token을 저장하지 않는다.
 *
 * OAuth 프로토콜을 직접 재구현하지 않는다. redirect/callback/PKCE/refresh는 모두
 * keycloak-js가 담당하고, 이 모듈은 앱 전역에서 단 하나의 인스턴스만 쓰도록 감싼다.
 */
import { i18n } from "@/shared/i18n";
import Keycloak, { type KeycloakInitOptions } from "keycloak-js";
import { getOidcConfig } from "@/shared/config/env";
import { getStudioUrl } from "./returnTo";

/** Builder 요청 직전, 남은 유효시간이 이보다 짧으면 access token을 refresh한다(초). */
const TOKEN_MIN_VALIDITY_SECONDS = 30;

let instance: Keycloak | null = null;
let initPromise: Promise<boolean> | null = null;
let refreshPromise: Promise<string | null> | null = null;

/**
 * 설정이 유효할 때만 싱글턴 Keycloak 인스턴스를 만든다.
 * OIDC가 비활성/오류 상태이면 예외를 던진다(호출부가 fail-closed 처리).
 */
export function getKeycloak(): Keycloak {
  if (instance) return instance;

  const result = getOidcConfig();
  if (result.status !== "ok") {
    throw new Error(
      result.status === "error" ? result.reason : i18n.t("auth.oidc.disabled"),
    );
  }

  instance = new Keycloak({
    url: result.config.authServerUrl,
    realm: result.config.realm,
    clientId: result.config.clientId,
  });
  return instance;
}

/**
 * check-sso로 기존 세션만 확인한다(로그인 강제 없음 — LoginGate가 상태를 제어).
 * 최초 1회만 실행되도록 memoize하며, 실패해도 재초기화 루프를 만들지 않는다.
 */
export function initKeycloak(): Promise<boolean> {
  if (initPromise) return initPromise;

  const keycloak = getKeycloak();
  // GitHub Pages 하위 경로(BASE_URL) 배포에서도 정적 파일을 찾을 수 있게 base를 붙인다.
  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
  const options: KeycloakInitOptions = {
    onLoad: "check-sso",
    pkceMethod: "S256",
    // 숨은 iframe으로 조용히 세션을 확인한다. 실패 시 전체 리다이렉트로 폴백하지 않는다.
    silentCheckSsoRedirectUri: `${window.location.origin}${base}silent-check-sso.html`,
    // 로그인 상태 iframe polling은 서드파티 쿠키 차단 환경에서 무한 재확인을 유발할 수 있어 끈다.
    checkLoginIframe: false,
  };

  initPromise = keycloak.init(options);
  return initPromise;
}

/**
 * 만료 임박 access token을 갱신하고 최신 값을 반환한다.
 *
 * 동시에 여러 Builder 요청이 refresh를 트리거해도 실제 `updateToken` 호출은 한 번만
 * 나가도록 진행 중인 promise를 공유(coalesce)한다. refresh가 실패하면 stale token으로
 * 계속 요청하지 않도록 `null`을 반환한다.
 */
export async function getFreshToken(opts?: { force?: boolean }): Promise<string | null> {
  const keycloak = instance;
  if (!keycloak?.authenticated) return null;

  if (!refreshPromise) {
    const minValidity = opts?.force ? -1 : TOKEN_MIN_VALIDITY_SECONDS;
    refreshPromise = keycloak
      .updateToken(minValidity)
      .then(() => keycloak.token ?? null)
      .catch(() => null)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

/** 현재 origin으로 돌아오는 Keycloak 로그인 리다이렉트를 시작한다. */
export function keycloakLogin(returnTo = "/", idpHint?: string): Promise<void> {
  const callback = `/login?${new URLSearchParams({ returnTo }).toString()}`;
  const options = { redirectUri: getStudioUrl(callback) };
  return getKeycloak().login(idpHint ? { ...options, idpHint } : options);
}

/** Keycloak 세션을 종료하고 현재 origin으로 돌아온다. */
export function keycloakLogout(): Promise<void> {
  // 로그인 리다이렉트와 동일하게 앱 base 경로를 보존한다(서브패스 배포 대응).
  return getKeycloak().logout({ redirectUri: getStudioUrl("/") });
}

/** 테스트 전용: 모듈 싱글턴 상태를 초기화한다. */
export function __resetKeycloakForTests(): void {
  instance = null;
  initPromise = null;
  refreshPromise = null;
}
