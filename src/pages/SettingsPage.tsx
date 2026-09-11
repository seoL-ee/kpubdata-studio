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
            필요한 Builder API 최소 버전 {MIN_BUILDER_API_VERSION}
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
              mock 모드입니다. 실제 Builder에 연결하려면{" "}
              <code className="text-accent-subtle-foreground">VITE_USE_REAL_BUILDER=true</code>
              로 설정하세요.
            </p>
          ) : connection.status === "checking" ? (
            <p className="text-muted-foreground">{t("settings.conn.checking")}</p>
          ) : connection.status === "ok" ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status="succeeded" />
                <span className="text-foreground">
                  Builder API 버전 {connection.apiVersion}
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
          <p>
            어시스턴트 기능을 사용하면 대화 내용이 사용자가 설정한 외부 LLM 제공자(OpenAI 등)로
            전송됩니다. API 키와 비용은 사용자 부담입니다.
          </p>
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
              로그아웃
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
              로그인
            </Link>
          </div>
        ) : (
          <p className="text-muted-foreground">
            mock 모드에서는 로그인 상태가 UI 시연용으로만 동작합니다. 계정/권한 백엔드는
            실연동과 함께 연동됩니다.
          </p>
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
  // 요약은 서버가 계산한 configured 부울만 다룬다 — 원문 키 조회 자체를 하지 않는다.
  const requiringCredential =
    state.status === "ok" ? state.providers.filter((p) => p.requires_credential) : [];
  const configuredCount = requiringCredential.filter((p) => p.configured).length;

  return (
    <Card data-testid="settings-provider-credentials">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          데이터 Provider 자격 증명
        </p>
        <Link
          to="/provider"
          className="shrink-0 rounded-lg border border-border px-3 py-1 text-xs font-medium text-accent-subtle-foreground hover:bg-muted"
        >
          Provider 설정에서 관리
        </Link>
      </div>
      <div className="mt-4 text-sm">
        {!realEnabled ? (
          <p className="text-muted-foreground">
            mock 모드에서는 Provider 페이지에서 동작을 시연할 수 있습니다. 실제 자격 증명은
            실연동 모드에서 Builder가 서버에 안전하게 보관합니다.
          </p>
        ) : state.status === "loading" ? (
          <p className="text-muted-foreground">Provider 구성 상태를 조회하는 중입니다…</p>
        ) : state.status === "error" ? (
          <p className="text-red-700 dark:text-red-300">{state.message}</p>
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground">
              자격 증명이 필요한 Provider {requiringCredential.length}개 중 {configuredCount}개가
              구성되었습니다.
            </p>
            <ul className="flex flex-wrap gap-2" aria-label="provider 구성 상태">
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
      {configured ? "구성됨" : "미구성"}
    </span>
  );
}

function KubiByokSection() {
  // Kubi LLM 키는 Provider credential과 다른 BYOK 정책을 따른다(#256/#301 분리):
  // 기본 메모리 전용, 브라우저 저장은 명시적 opt-in + 경고.
  const { isConfigured, model, persistToStorage, resolvedBaseUrl, isDefaultBaseUrl } =
    useAssistConfig();

  return (
    <Card data-testid="settings-kubi-byok">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Kubi · BYOK LLM 키
        </p>
        <Link
          to="/kubi"
          className="shrink-0 rounded-lg border border-border px-3 py-1 text-xs font-medium text-accent-subtle-foreground hover:bg-muted"
        >
          Kubi에서 설정
        </Link>
      </div>
      <div className="mt-4 space-y-2 text-sm">
        <p className="text-muted-foreground">
          Kubi 어시스턴트의 LLM 키는 데이터 Provider 자격 증명과 별도로 사용자가 직접
          관리합니다(Bring Your Own Key). 키는 기본적으로 메모리에만 보관되며 새로고침 시
          사라집니다.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              isConfigured
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                : "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
            }`}
          >
            {isConfigured ? "키 설정됨" : "키 미설정"}
          </span>
          {isConfigured && model ? <span className="text-muted-foreground">{model}</span> : null}
          {isConfigured && !isDefaultBaseUrl ? (
            <span className="text-amber-700 dark:text-amber-400" title={resolvedBaseUrl}>
              사용자 지정 Base URL
            </span>
          ) : null}
        </div>
        {persistToStorage ? (
          <p className="text-amber-700 dark:text-amber-400">
            브라우저 저장이 켜져 있습니다 — LLM API 키가 이 브라우저에 평문으로 저장됩니다.
            XSS 공격 시 탈취될 수 있으니 신뢰하지 않는 환경에서는 끄세요.
          </p>
        ) : (
          <p className="text-muted-foreground">
            브라우저 저장: 꺼짐(메모리 전용). Kubi 화면에서 명시적으로 켤 수 있습니다.
          </p>
        )}
      </div>
    </Card>
  );
}
