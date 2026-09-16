/**
 * 인증 초기화 — auth store를 apiFetch의 토큰 provider에 연결하고(S1↔S3), OIDC(Keycloak)
 * 세션 부트스트랩을 시작한다. 앱 진입점(main.tsx)에서 한 번 호출한다.
 */
import { getOidcConfig, isOidcEnabled } from "@/shared/config/env";
import { setAuthErrorCallback, setAuthTokenProvider } from "@/shared/lib/builderApi";
import { getFreshToken, getKeycloak, initKeycloak } from "./keycloak";
import { useAuthStore } from "./store";

export function initAuth(): void {
  // Builder 공통 request boundary가 쓸 Bearer 토큰 provider (요청마다 호출됨).
  // - OIDC 활성: keycloak 메모리 세션에서 (만료 임박 시 refresh 후) 최신 access token.
  // - 그 외(mock/데모): 기존 메모리 store 토큰. mock 모드에서는 null → 무인증 요청.
  setAuthTokenProvider(() =>
    isOidcEnabled() ? getFreshToken() : useAuthStore.getState().token,
  );

  setAuthErrorCallback(() => {
    if (isOidcEnabled()) {
      // 401을 성공으로 간주하지 않는다. 강제 refresh를 한 번만 시도하고, 실패하면
      // unauthenticated로 표시해 LoginGate가 재로그인을 유도한다(무한 retry 없음).
      void getFreshToken({ force: true }).then((token) => {
        if (!token) {
          const store = useAuthStore.getState();
          store.clear();
          store.setOidcStatus("unauthenticated");
        }
      });
      return;
    }
    useAuthStore.getState().clear();
  });

  bootstrapOidc();
}

/** OIDC 설정을 해석하고, 활성 상태면 check-sso로 세션을 확인한다. */
function bootstrapOidc(): void {
  const config = getOidcConfig();
  const store = useAuthStore.getState();

  if (config.status === "disabled") {
    store.setOidcStatus("disabled");
    return;
  }

  if (config.status === "error") {
    // fail-closed: 사용자를 authenticated로 추측하지 않는다. issuer/clientId만 로깅(secret 아님).
    console.error(`[auth] OIDC 설정 오류: ${config.reason}`);
    store.setOidcStatus("error");
    return;
  }

  store.setOidcStatus("initializing");
  initKeycloak()
    .then((authenticated) => {
      const keycloak = getKeycloak();
      syncIdentity(authenticated);

      keycloak.onAuthSuccess = () => syncIdentity(true);
      keycloak.onAuthRefreshSuccess = () => syncIdentity(true);
      keycloak.onAuthLogout = () => {
        const current = useAuthStore.getState();
        current.clear();
        current.setOidcStatus("unauthenticated");
      };
      keycloak.onTokenExpired = () => {
        void getFreshToken();
      };
    })
    .catch(() => {
      // init 실패는 재시도하지 않는다(무한 루프 방지). 사용자는 error 상태로 남는다.
      useAuthStore.getState().setOidcStatus("error");
    });
}

/** keycloak 세션 상태를 store의 표시용 신원/상태로 반영한다. */
function syncIdentity(authenticated: boolean): void {
  const store = useAuthStore.getState();
  if (!authenticated) {
    store.setOidcStatus("unauthenticated");
    return;
  }

  const claims = getKeycloak().tokenParsed as
    | { sub?: string; email?: string; name?: string; preferred_username?: string }
    | undefined;
  store.setOidcIdentity({
    email: claims?.email ?? null,
    name: claims?.name ?? claims?.preferred_username ?? null,
    userId: claims?.sub ?? null,
  });
  store.setOidcStatus("authenticated");
}
