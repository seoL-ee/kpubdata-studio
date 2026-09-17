/**
 * Studio 환경 설정 페이지 (/settings).
 *
 * 네 개의 분리된 영역으로 구성한다(#301):
 * 1. 계정 — 로그인 상태/로그아웃(실연동) 또는 mock 안내
 * 2. 연결 — Builder API 엔드포인트와 계약 버전 호환성 점검(#29)
 * 3. 데이터 Provider 자격 증명 — GET /providers 요약(부울만, 원문 없음) + /provider CTA
 * 4. Kubi BYOK — LLM 키는 Provider credential과 완전히 분리된 정책/영역(#256)
 *
 * 구현되지 않은 team/project backend를 있는 것처럼 표시하지 않는다(#292 회귀 금지).
 */
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE } from "@/shared/config/env";
import {
  ApiError,
  builderApi,
  isBuilderApiCompatible,
  isRealBuilderEnabled,
  MIN_BUILDER_API_VERSION,
} from "@/shared/lib/builderApi";
import type { ProviderSummary } from "@/shared/lib/builderApi.schema";
import { keycloakLogout } from "@/features/auth/keycloak";
import { useAuthStore } from "@/features/auth/store";
import { useAssistConfig } from "@/features/assistant/config";
import { Card, PageHeader, StatusBadge, Button } from "@/shared/ui";

interface ConnectionState {
  status: "idle" | "checking" | "ok" | "error";
  apiVersion?: string;
  error?: string;
}

type ProvidersState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; providers: ProviderSummary[] };

export function SettingsPage() {
  const { t } = useTranslation();
  const realEnabled = isRealBuilderEnabled();
  const { email, clear } = useAuthStore();
  const oidcStatus = useAuthStore((state) => state.oidcStatus);

  // OIDC 세션은 Keycloak에서 로그아웃해야 IdP 세션까지 종료된다. 그 외에는 메모리 세션만 폐기.
  const handleLogout = () => {
    if (oidcStatus === "authenticated") {
      void keycloakLogout();
      return;
    }
    clear();
  };
  const [connection, setConnection] = useState<ConnectionState>({ status: "idle" });
  const [providers, setProviders] = useState<ProvidersState>({ status: "idle" });

  useEffect(() => {
    if (!realEnabled) return;
    const controller = new AbortController();
    setConnection({ status: "checking" });
    builderApi
      .version(controller.signal)
      .then((info) => setConnection({ status: "ok", apiVersion: info.api_version }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setConnection({
          status: "error",
          error: cause instanceof ApiError ? cause.message : i18n.t("settings.conn.connFail"),
        });
      });
    return () => controller.abort();
  }, [realEnabled]);

  useEffect(() => {
    if (!realEnabled) return;
    const controller = new AbortController();
    setProviders({ status: "loading" });
    builderApi
      .listProviders(controller.signal)
      .then((response) => setProviders({ status: "ok", providers: response.providers }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setProviders({
          status: "error",
          message: cause instanceof ApiError ? cause.message : i18n.t("settings.conn.fetchFail"),
        });
      });
    return () => controller.abort();
  }, [realEnabled]);

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow={t("settings.page.eyebrow")}
        title={t("settings.page.title")}
        description={t("settings.page.desc")}
      />

      <AccountSection realEnabled={realEnabled} email={email} onLogout={handleLogout} />

      <Card>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("settings.conn.title")}
          </p>
          <span className="text-xs text-muted-foreground">
            {t("settings.conn.minVersion", { version: MIN_BUILDER_API_VERSION })}
          </span>
        </div>
        <div className="mt-4 rounded-xl border border-dashed border-border bg-muted p-4">
          <p className="text-sm font-medium">Builder API base URL</p>
          <code className="mt-3 block break-all text-sm text-accent-subtle-foreground">
            {API_BASE}
          </code>
        </div>
        <div className="mt-4 text-sm">
          {!realEnabled ? (
            <p className="text-muted-foreground">
              {t("settings.conn.mockNote")}{" "}
              <code className="text-accent-subtle-foreground">VITE_USE_REAL_BUILDER=true</code>
              {t("settings.conn.mockEnv")}
            </p>
          ) : connection.status === "checking" ? (
            <p className="text-muted-foreground">{t("settings.conn.checking")}</p>
          ) : connection.status === "ok" ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status="succeeded" />
                <span className="text-foreground">
                  {t("settings.conn.version", { version: connection.apiVersion })}
                </span>
              </div>
              {!isBuilderApiCompatible(connection.apiVersion) ? (
                <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
                  {t("settings.conn.mismatch", { api: connection.apiVersion, min: MIN_BUILDER_API_VERSION })}
                </p>
              ) : null}
            </div>
          ) : connection.status === "error" ? (
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status="failed" />
              <span className="text-red-700 dark:text-red-300">{connection.error}</span>
            </div>
          ) : null}
        </div>
      </Card>

      <ProviderCredentialSection realEnabled={realEnabled} state={providers} />

      <KubiByokSection />

      <Card variant="dashed">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("settings.privacy.title")}
        </p>
        <div className="mt-3 space-y-2 text-sm text-muted-foreground">
          <p>{t("settings.privacy.llm")}</p>
          <p className="text-amber-700 dark:text-amber-400">
            {t("settings.privacy.noPublic")}
          </p>
          <p>
            {t("settings.privacy.scrub")}
          </p>
        </div>
      </Card>
    </main>
  );
}

function AccountSection({
  realEnabled,
  email,
  onLogout,
}: {
  realEnabled: boolean;
  email: string | null;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card data-testid="settings-account">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t("settings.account.title")}
      </p>
      <div className="mt-4 text-sm">
        {email ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-foreground">{email}</span>
            <Button variant="secondary" size="sm" onClick={() => onLogout()}>
              {t("settings.account.logout")}
            </Button>
          </div>
        ) : realEnabled ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground">
              {t("settings.account.notLoggedIn")}
            </p>
            <Link
              to="/login"
              className="shrink-0 rounded-lg border border-border px-3 py-1 text-xs font-medium text-accent-subtle-foreground hover:bg-muted"
            >
              {t("settings.account.login")}
            </Link>
          </div>
        ) : (
          <p className="text-muted-foreground">{t("settings.account.mockNote")}</p>
        )}
      </div>
    </Card>
  );
}

function ProviderCredentialSection({
  realEnabled,
  state,
}: {
  realEnabled: boolean;
  state: ProvidersState;
}) {
  const { t } = useTranslation();
  // 요약은 서버가 계산한 configured 부울만 다룬다 — 원문 키 조회 자체를 하지 않는다.
  const requiringCredential =
    state.status === "ok" ? state.providers.filter((p) => p.requires_credential) : [];
  const configuredCount = requiringCredential.filter((p) => p.configured).length;

  return (
    <Card data-testid="settings-provider-credentials">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("settings.providers.title")}
        </p>
        <Link
          to="/provider"
          className="shrink-0 rounded-lg border border-border px-3 py-1 text-xs font-medium text-accent-subtle-foreground hover:bg-muted"
        >
          {t("settings.providers.manage")}
        </Link>
      </div>
      <div className="mt-4 text-sm">
        {!realEnabled ? (
          <p className="text-muted-foreground">{t("settings.providers.mockNote")}</p>
        ) : state.status === "loading" ? (
          <p className="text-muted-foreground">{t("settings.providers.loading")}</p>
        ) : state.status === "error" ? (
          <p className="text-red-700 dark:text-red-300">{state.message}</p>
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground">
              {t("settings.providers.summary", {
                total: requiringCredential.length,
                configured: configuredCount,
              })}
            </p>
            <ul className="flex flex-wrap gap-2" aria-label={t("settings.providers.listLabel")}>
              {requiringCredential.map((provider) => (
                <li key={provider.provider}>
                  <ProviderConfiguredBadge
                    provider={provider.provider}
                    configured={provider.configured}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function ProviderConfiguredBadge({ provider, configured }: { provider: string; configured: boolean }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        configured
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {provider}
      <span aria-hidden="true">·</span>
      {configured ? t("settings.providers.configured") : t("settings.providers.notConfigured")}
    </span>
  );
}

function KubiByokSection() {
  // Kubi LLM 키는 Provider credential과 다른 BYOK 정책을 따른다(#256/#301 분리):
  // 기본 메모리 전용, 브라우저 저장은 명시적 opt-in + 경고.
  const { t } = useTranslation();
  const { isConfigured, model, persistToStorage, resolvedBaseUrl, isDefaultBaseUrl } =
    useAssistConfig();

  return (
    <Card data-testid="settings-kubi-byok">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("settings.byok.title")}
        </p>
        <Link
          to="/kubi"
          className="shrink-0 rounded-lg border border-border px-3 py-1 text-xs font-medium text-accent-subtle-foreground hover:bg-muted"
        >
          {t("settings.byok.configure")}
        </Link>
      </div>
      <div className="mt-4 space-y-2 text-sm">
        <p className="text-muted-foreground">{t("settings.byok.desc")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isConfigured
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
            }`}
          >
            {isConfigured ? t("settings.byok.keySet") : t("settings.byok.keyUnset")}
          </span>
          {isConfigured && model ? <span className="text-muted-foreground">{model}</span> : null}
          {isConfigured && !isDefaultBaseUrl ? (
            <span className="text-amber-700 dark:text-amber-400" title={resolvedBaseUrl}>
              {t("settings.byok.customBaseUrl")}
            </span>
          ) : null}
        </div>
        {persistToStorage ? (
          <p className="text-amber-700 dark:text-amber-400">{t("settings.byok.persistOn")}</p>
        ) : (
          <p className="text-muted-foreground">{t("settings.byok.persistOff")}</p>
        )}
      </div>
    </Card>
  );
}
