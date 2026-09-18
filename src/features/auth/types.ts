/**
 * Generic 인증 계약 (#263).
 *
 * provider를 갈아끼울 수 있게 만든 provider-agnostic 타입이다. 실연동 인증은 ADR 0015
 * (Keycloak, Authorization Code + PKCE)가 담당하고 — 그 경로는 `keycloak.ts`가 직접
 * 처리하므로 이 계약을 구현하지 않는다 — 이 계약은 mock/demo provider가 쓴다.
 */

/** 어떤 provider가 이 세션을 만들었는지 표시하는 태그. */
export type AuthProviderId = "mock" | "keycloak";

/**
 * 로그인 성공 후 Studio가 들고 있는 세션 정보.
 *
 * password는 절대 이 shape에 포함하지 않는다 — 어떤 provider도 세션에 원문 비밀번호를
 * 담아서는 안 된다(#263 보안 요구사항: password를 store/localStorage/sessionStorage/
 * 로그 어디에도 남기지 않음).
 */
export interface AuthSession {
  /** Builder 호출용 Bearer 토큰(또는 mock 모드에서는 그 자리를 채우는 mock 토큰). */
  token: string;
  email: string;
  /** 표시용 이름. provider가 이름을 주지 않으면 null(#191 topbar avatar와 호환). */
  name: string | null;
  provider: AuthProviderId;
}

export interface SignInInput {
  email: string;
  password: string;
}

export type AccountType = "individual" | "organization";

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
  accountType: AccountType;
  /** 팀·기관(accountType === "organization") 선택 시에만 의미 있는 optional 값. */
  organizationName?: string;
}

/** 로그인/가입 실패를 다른 예외(네트워크 오류 등)와 구분하기 위한 전용 에러 타입. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * email/password 인증을 수행하는 provider의 generic 계약.
 *
 * 실연동 Keycloak은 이 인터페이스를 구현하지 않는다 — hosted login 페이지로 리다이렉트하는
 * 방식이라 `signIn(email, password)` 같은 직접 호출 형태와 맞지 않는다(`keycloak.ts` 참고).
 * 두 경로는 세션 모델 층에서 하나로 합쳐진다 — topbar avatar/Settings/LoginGate는 어느
 * provider로 로그인했는지 신경 쓰지 않는다.
 */
export interface AuthProvider {
  readonly id: AuthProviderId;
  signIn(input: SignInInput): Promise<AuthSession>;
  signUp(input: SignUpInput): Promise<AuthSession>;
  signOut(): Promise<void>;
}
