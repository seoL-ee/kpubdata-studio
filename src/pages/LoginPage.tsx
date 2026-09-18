/**
 * 로그인 화면 (/login, #263; OIDC 연동에서 실제 Keycloak 로그인 진입점 추가).
 *
 * 실제 IdP는 kpubdata-builder ADR 0015가 self-hosted Keycloak + Authorization Code +
 * PKCE(S256)로 확정했다. 이 화면은 환경에 따라 분기한다:
 * - mock/demo 환경(`!isRealBuilderEnabled()`): 기존 mockAuthProvider 이메일/비밀번호
 *   폼을 그대로 유지한다(dev/demo 전용).
 * - 실연동 + OIDC 활성: Keycloak 로그인 리다이렉트 버튼만 제공한다. 이메일/비밀번호,
 *   비밀번호 재설정, 이메일 인증은 모두 Keycloak 책임이므로 Studio는 입력 폼을 두지 않는다.
 * - 실연동 + OIDC 미구성/오류: 안내만 보여준다 — 가짜 redirect/token flow를 만들지 않는다.
 *
 * Google 로그인은 Keycloak identity broker로 위임한다(`keycloakLogin(returnTo, "google")`) —
 * Studio가 Google SDK를 직접 로드하거나 Google 토큰을 Builder에 보내지 않는다.
 */
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { keycloakLogin } from "@/features/auth/keycloak";
import { getSafeReturnTo } from "@/features/auth/returnTo";
import { mockAuthProvider } from "@/features/auth/mockAuthProvider";
import { useAuthStore } from "@/features/auth/store";
import { AuthError } from "@/features/auth/types";
import { getOidcConfig } from "@/shared/config/env";
import { isRealBuilderEnabled } from "@/shared/lib/builderApi";
import { Button, Card, DemoBadge, ErrorMessage, FormField, TextInput } from "@/shared/ui";

const darkLogoUrl = new URL("../../assets/logo/kpubdata-brand-assets/svg/horizontal_dark.svg", import.meta.url).href;
const lightLogoUrl = new URL("../../assets/logo/kpubdata-brand-assets/svg/horizontal_light.svg", import.meta.url).href;

/** Auth 화면에 표시하는 짧은 제품 소개. */
function BrandPanel() {
  const { t } = useTranslation();
  return (
    <section className="hidden min-h-screen flex-col bg-sidebar px-8 py-10 text-sidebar-foreground lg:flex lg:w-[48%] lg:px-12 xl:px-16" aria-label={t("auth.page.introLabel")}>
      <img alt="KPubData Studio" className="w-[160px] self-start xl:w-[192px]" src={darkLogoUrl} />
      <div className="my-auto max-w-xl">
        <p className="text-xs font-semibold tracking-[0.16em] text-sidebar-muted">PUBLIC DATA → AI-READY DATASET</p>
        <h1 className="mt-5 max-w-xl break-keep text-balance text-4xl font-semibold leading-tight tracking-tight text-sidebar-active-foreground xl:text-5xl">
          {t("auth.page.introTitle")}
        </h1>
        <p className="mt-6 max-w-lg text-base leading-7 text-sidebar-foreground">
          {t("auth.page.introDesc")}
        </p>
        <div aria-hidden="true" className="mt-8 flex flex-wrap gap-2">
          {["Source", "BuildSpec", "Preview", "Validate", "Build", "Quality", "AI"].map((item) => (
            <span className="rounded-full border border-sidebar-border bg-sidebar-hover px-3 py-1.5 text-xs font-medium text-sidebar-foreground" key={item}>{item}</span>
          ))}
        </div>
      </div>
      <p className="text-xs text-sidebar-muted">© 2026 KPubData Studio</p>
    </section>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useAuthStore((state) => state.setSession);
  const oidcStatus = useAuthStore((state) => state.oidcStatus);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const session = await mockAuthProvider.signIn({ email, password });
      setSession(session);
      navigate(returnTo, { replace: true });
    } catch (cause) {
      setError(
        cause instanceof AuthError ? cause.message : i18n.t("auth.page.loginFail"),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const demoMode = !isRealBuilderEnabled();
  const oidc = getOidcConfig();
  const returnTo = getSafeReturnTo(new URLSearchParams(location.search).get("returnTo"));

  // 이미 Keycloak 세션이 확인되면 앱으로 돌려보낸다(로그인 화면에 머물지 않게).
  useEffect(() => {
    if (!demoMode && oidcStatus === "authenticated") {
      navigate(returnTo, { replace: true });
    }
  }, [demoMode, oidcStatus, navigate, returnTo]);

  return (
    <main className="min-h-screen bg-background lg:flex">
      <BrandPanel />
      <section className="flex min-h-screen flex-1 items-center justify-center px-5 py-12 sm:px-8 lg:px-12" aria-label={t("auth.page.loginLabel")}>
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <img alt="KPubData Studio" className="w-[160px] max-w-full" src={lightLogoUrl} />
          </div>
          <div className="mb-7">
            <p className="text-xs font-semibold tracking-[0.16em] text-accent-subtle-foreground">WELCOME</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">{t("auth.page.welcome")}</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("auth.page.welcomeDesc")}</p>
          </div>
          <Card>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-semibold tracking-tight">{t("auth.page.loginTitle")}</h2>
            {demoMode ? <DemoBadge /> : null}
          </div>

          {demoMode ? (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                {t("auth.page.mockNote")}
              </p>

              <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit}>
                <FormField id="login-email" label={t("auth.page.email")} required>
                  {(field) => (
                    <TextInput
                      {...field}
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  )}
                </FormField>

                <FormField id="login-password" label={t("auth.page.password")} required>
                  {(field) => (
                    <TextInput
                      {...field}
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  )}
                </FormField>

                <ErrorMessage>{error}</ErrorMessage>

                <Button type="submit" loading={isSubmitting} className="mt-2">
                  {t("auth.page.submit")}
                </Button>
              </form>

              <p className="mt-6 text-center text-sm text-muted-foreground">
                {t("auth.page.noAccount")}{" "}
                <Link to="/signup" className="font-medium text-accent-subtle-foreground underline">
                  {t("auth.page.getAccount")}
                </Link>
              </p>
            </>
          ) : oidcStatus === "initializing" ? (
            <p className="mt-4 text-sm text-muted-foreground">{t("auth.page.checking")}</p>
          ) : oidcStatus === "error" ? (
            <ErrorMessage>{t("auth.page.initFail")}</ErrorMessage>
          ) : oidc.status === "ok" ? (
            <div className="mt-4 flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                {t("auth.page.keycloak")}
              </p>
              <Button
                type="button"
                leadingIcon={<span aria-hidden="true" className="font-semibold">G</span>}
                onClick={() => void keycloakLogin(returnTo, "google")}
              >
                {t("auth.page.google")}
              </Button>
              <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
                <span className="h-px flex-1 bg-border" />
                {t("auth.page.or")}
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button type="button" variant="secondary" onClick={() => void keycloakLogin(returnTo)}>
                {t("auth.page.emailLogin")}
              </Button>
            </div>
          ) : oidc.status === "error" ? (
            <div className="mt-4 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">OIDC 인증 설정에 문제가 있습니다.</p>
              <p className="mt-2">
                이 환경은 실제 Builder에 연결되어 있지만 OIDC 설정(<code>VITE_OIDC_ISSUER</code> /{" "}
                <code>VITE_OIDC_CLIENT_ID</code>)이 올바르지 않습니다. 관리자에게 문의하세요.
              </p>
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">OIDC 인증이 아직 구성되지 않았습니다.</p>
              <p className="mt-2">
                이 환경은 실제 Builder에 연결되어 있지만, 사람 사용자 로그인을 위한 OIDC IdP(Keycloak)
                연동이 아직 준비되지 않았습니다. 관리자에게 문의하거나 연동이 완료된 이후 다시
                시도해주세요.
              </p>
            </div>
          )}
          </Card>
        </div>
      </section>
    </main>
  );
}
