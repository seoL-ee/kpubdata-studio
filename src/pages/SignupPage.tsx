/** 공개 회원가입은 Studio가 아닌 Keycloak hosted UI에서 처리한다. */
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { keycloakLogin } from "@/features/auth/keycloak";
import { getSafeReturnTo } from "@/features/auth/returnTo";
import { getOidcConfig } from "@/shared/config/env";
import { Button, Card } from "@/shared/ui";

const lightLogoUrl = new URL("../../assets/logo/kpubdata-brand-assets/svg/horizontal_light.svg", import.meta.url).href;

export function SignupPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const oidc = getOidcConfig();
  const returnTo = getSafeReturnTo(new URLSearchParams(location.search).get("returnTo"));

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-md text-center">
        <img alt="KPubData Studio" className="mx-auto mb-7 h-8 w-auto" src={lightLogoUrl} />
        <Card>
        <h1 className="text-2xl font-semibold tracking-tight">{t("auth.signup.title")}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {t("auth.signup.desc")}
        </p>
        {oidc.status === "ok" ? (
          <Button className="mt-6" onClick={() => void keycloakLogin(returnTo)}>
            {t("auth.signup.cta")}
          </Button>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">{t("auth.signup.notReady")}</p>
        )}
        <Link to="/login" className="mt-6 inline-block font-medium text-accent-subtle-foreground underline">
          {t("auth.signup.backToLogin")}
        </Link>
        </Card>
      </div>
    </main>
  );
}
