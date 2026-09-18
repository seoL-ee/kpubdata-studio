/**
 * Studio가 Builder 백엔드와 통신할 때 사용할 기본 API 엔드포인트를 정의한다.
 *
 * 환경 변수가 있으면 배포 환경 값을 우선 사용하고, 없으면 로컬 개발 기본값으로 폴백한다.
 */
import { i18n } from "@/shared/i18n";

export const API_BASE =
  import.meta.env.VITE_BUILDER_API_URL ?? "http://localhost:8000";

/** Development-only real-Builder authentication bypass policy. */
export function resolveDevAuthBypass({ dev, bypass }: { dev: boolean; bypass?: string }): boolean {
  return dev && bypass === "true";
}

/** Returns whether the local development authentication bypass is enabled. */
export function isDevAuthBypassEnabled(): boolean {
  return resolveDevAuthBypass({
    dev: import.meta.env.DEV,
    bypass: import.meta.env.VITE_DEV_BYPASS_AUTH,
  });
}

/**
 * OIDC(Keycloak) 연동 설정 (ADR 0015).
 *
 * Studio는 public SPA다 — frontend에는 client secret을 두지 않는다. issuer/clientId만
 * 공개 값으로 번들에 포함한다.
 */
export interface OidcConfig {
  /** 전체 issuer URL (예: http://localhost:8080/realms/kpubdata). */
  issuer: string;
  /** keycloak-js `url` 옵션이 요구하는 Keycloak base URL (예: http://localhost:8080). */
  authServerUrl: string;
  /** realm 이름 (예: kpubdata). */
  realm: string;
  /** public SPA client id. */
  clientId: string;
}

export type OidcConfigResult =
  | { status: "disabled" }
  | { status: "ok"; config: OidcConfig }
  | { status: "error"; reason: string };

/**
 * issuer URL을 keycloak-js가 요구하는 base URL + realm으로 분해한다.
 *
 * `http(s)://<host>[/prefix]/realms/<realm>` 형태만 허용한다. 형태가 어긋나면
 * `null`을 반환해 호출부가 fail-closed 처리하도록 한다.
 */
export function parseOidcIssuer(
  issuer: string,
): { authServerUrl: string; realm: string } | null {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.search || url.hash) return null;

  const match = url.pathname.match(/^(.*)\/realms\/([^/]+)\/?$/);
  if (!match) return null;
  // 잘못 인코딩된 realm(예: "%E0%A4%A")은 decodeURIComponent가 예외를 던지므로,
  // throw 대신 null을 반환해 호출부가 fail-closed 처리하게 한다.
  let realm: string;
  try {
    realm = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!realm) return null;

  // match[1]은 realms 앞의 경로 프리픽스("" | "/auth" 등). 표준 배포는 프리픽스가 없다.
  return { authServerUrl: `${url.origin}${match[1]}`, realm };
}

/**
 * 현재 모드에 맞춰 OIDC 설정을 해석한다.
 *
 * - mock/데모(`realBuilder=false`)나 명시적 dev bypass에서는 OIDC를 요구하지 않는다("disabled").
 * - 실연동인데 issuer/clientId가 없거나 issuer 형식이 잘못되면 fail-closed("error").
 */
export function resolveOidcConfig(input: {
  realBuilder: boolean;
  devBypass: boolean;
  issuer?: string;
  clientId?: string;
}): OidcConfigResult {
  if (!input.realBuilder || input.devBypass) return { status: "disabled" };

  const issuer = input.issuer?.trim();
  const clientId = input.clientId?.trim();
  if (!issuer) return { status: "error", reason: i18n.t("config.oidc.issuerMissing") };
  if (!clientId) {
    return { status: "error", reason: i18n.t("config.oidc.clientIdMissing") };
  }

  const parsed = parseOidcIssuer(issuer);
  if (!parsed) {
    return { status: "error", reason: i18n.t("config.oidc.issuerInvalid", { issuer }) };
  }

  return {
    status: "ok",
    config: {
      issuer,
      authServerUrl: parsed.authServerUrl,
      realm: parsed.realm,
      clientId,
    },
  };
}

/** 현재 런타임 환경 변수에서 OIDC 설정을 해석한다. */
export function getOidcConfig(): OidcConfigResult {
  return resolveOidcConfig({
    // builderApi.isRealBuilderEnabled()와 같은 판정이지만, 순환 import를 피하려고 여기서 직접 읽는다.
    realBuilder: import.meta.env.VITE_USE_REAL_BUILDER === "true",
    devBypass: isDevAuthBypassEnabled(),
    issuer: import.meta.env.VITE_OIDC_ISSUER,
    clientId: import.meta.env.VITE_OIDC_CLIENT_ID,
  });
}

/** OIDC 로그인 흐름을 실제로 활성화해야 하는 환경인지 여부. */
export function isOidcEnabled(): boolean {
  return getOidcConfig().status === "ok";
}
