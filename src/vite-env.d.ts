/**
 * Vite가 주입하는 전역 타입 선언을 TypeScript에 알려주는 보조 선언 파일.
 *
 * `import.meta.env` 같은 Vite 전용 API를 안전하게 사용할 수 있도록 기본 타입을 포함한다.
 */
/// <reference types="vite/client" />

/** Studio가 사용하는 커스텀 `VITE_*` 환경 변수 타입(#74). */
interface ImportMetaEnv {
  /** Builder API 베이스 URL. 미설정 시 로컬 기본값으로 폴백한다. */
  readonly VITE_BUILDER_API_URL?: string;
  /** "true"이면 mock 대신 실제 Builder API를 호출한다. */
  readonly VITE_USE_REAL_BUILDER?: string;
  /** Development-server-only real Builder login-gate bypass. */
  readonly VITE_DEV_BYPASS_AUTH?: string;
  /** OIDC issuer URL (예: http://localhost:8080/realms/kpubdata). public 값. */
  readonly VITE_OIDC_ISSUER?: string;
  /** OIDC public SPA client id (예: kpubdata-studio). public 값 — client secret 아님. */
  readonly VITE_OIDC_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
