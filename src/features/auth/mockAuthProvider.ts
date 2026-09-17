/**
 * Mock/demo {@link AuthProvider} 구현체 (#263).
 *
 * 실제 IdP 연결은 Builder #515 결정 이후로 미룬다 — 이 provider는 Login/Signup UI와
 * generic AuthProvider 경계를 시연하기 위한 결정적 mock일 뿐, 실제 자격 증명을 검증하지
 * 않는다. Builder에는 어떤 요청도 보내지 않고(password 원문 전송 금지, #263), 이 provider가
 * 만든 mock 토큰은 `apiFetch` 인증 헤더 provider에도 연결되지 않는다 — 실제 Builder 호출에
 * 이 토큰이 실리는 일은 없다(Builder bearer 토큰 연결은 #515 이후 real provider의 몫).
 *
 * password는 함수 인자로만 잠깐 존재했다가 버려진다 — store/localStorage/sessionStorage/
 * 로그 어디에도 저장하지 않는다.
 */
import { i18n } from "@/shared/i18n";
import { AuthError, type AuthProvider, type AuthSession, type SignInInput, type SignUpInput } from "./types";

function fabricateMockToken(): string {
  return `mock-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * mock 모드에서 "실패 메시지" UI 경로를 시연하기 위한 결정적 규칙일 뿐이다 — 실제
 * 자격 증명 검증이 아니며, 이 provider는 password를 어디에도 저장하거나 대조하지 않는다.
 * (짧은 비밀번호로 로그인을 시도하면 실패 상태를 확인할 수 있다.)
 */
function looksLikeDemoValidPassword(password: string): boolean {
  return password.length >= 4;
}

export const mockAuthProvider: AuthProvider = {
  id: "mock",

  async signIn({ email, password }: SignInInput): Promise<AuthSession> {
    if (!looksLikeDemoValidPassword(password)) {
      throw new AuthError(i18n.t("auth.mock.badCredentials"));
    }
    return {
      token: fabricateMockToken(),
      email,
      name: null,
      provider: "mock",
    };
  },

  async signUp(input: SignUpInput): Promise<AuthSession> {
    return {
      token: fabricateMockToken(),
      email: input.email,
      name: input.name,
      provider: "mock",
    };
  },

  async signOut(): Promise<void> {
    // mock 모드에는 폐기할 서버 세션이 없다 — 호출부(useAuthStore.clear())가 메모리 상태를 지운다.
  },
};
