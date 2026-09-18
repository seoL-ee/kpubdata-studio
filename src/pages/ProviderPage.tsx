/**
 * Provider 화면 (`/provider`) — Provider Connection·Credential + Settings 통합 (#259).
 *
 * Issue #259: Provider credential/connection 관리와 Settings를 통합한다.
 *
 * 진실성 원칙 (F01, builder ADR 0012):
 * - GET /providers 요약의 `configured`는 **effective provider configuration**
 *   (user credential > server default > 없음)이다. "이 사용자가 credential을 저장했다"가
 *   아니다.
 * - "이 사용자가 저장한 credential"의 유무/마스킹 값은 GET /providers/{provider}/credential
 *   메타데이터(`{ configured, masked, updated_at }`, raw secret 없음)로만 판정한다.
 * - requires_credential=false여도 요약 configured=true일 수 있다(무인증 provider).
 * - 두 축을 화면에서 분리한다: (1) effective credential readiness(요약 configured),
 *   (2) 사용자 저장 credential 존재 여부(마스킹 값·삭제의 근거).
 * - generic Provider probe(`POST /providers/{provider}/test` · `GET .../status`)는
 *   임의의 첫 Dataset을 필수 파라미터 없이 호출하므로 신뢰할 수 없다. 이 화면은
 *   probe 결과를 "연결 성공 여부"로 노출하지 않는다 — 실제 사용 가능 여부는 선택한
 *   Dataset의 Preview가 확인한다(#S-provider-probe).
 */
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ApiError,
  builderApi,
  isRealBuilderEnabled,
  type ProviderSummary,
} from "@/shared/lib/builderApi";
import {
  Card,
  Button,
  LinkButton,
  PageHeader,
  EmptyState,
  Skeleton,
} from "@/shared/ui";
import { describeCredentialReadiness } from "@/shared/lib/providerStatus";

/**
 * `returnTo` query param을 안전한 내부 경로일 때만 신뢰한다(#S-add-data, §4).
 * 절대 URL/프로토콜-상대(`//evil.com`) 경로로의 open redirect를 막는다 — 이 값은
 * Add Data 같은 내부 화면이 이어서 편집을 재개할 안전한 복귀 지점으로만 쓴다.
 */
export function isSafeReturnTo(value: string | null): value is string {
  if (!value) return false;
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.startsWith("/\\")) return false;
  return true;
}

interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  /** 이 provider가 사용자 credential을 필요로 하는지(GET /providers). */
  requiresCredential: boolean;
  /**
   * GET /providers 요약의 `configured` — effective provider configuration
   * (user credential > server default > 없음). 사용자 저장 credential 유무가 아니다.
   */
  summaryConfigured: boolean;
}

interface CredentialForm {
  credential: string;
}

/**
 * 선택된 provider에 대한 "사용자 저장 credential" 메타데이터 상태.
 * `configured`는 GET /providers/{provider}/credential 응답 기준(사용자 본인 저장 여부).
 */
type CredentialMetaState =
  | { status: "idle" | "loading" }
  | { status: "not_applicable" }
  /**
   * 운영자가 encrypted credential store(master key)를 구성하지 않았다 —
   * Builder가 `GET /providers/{provider}/credential`에 503
   * `credential store is not configured`로 답한 경우. "사용자가 아직 credential을
   * 등록하지 않음"(200 `configured:false`)이나 일반 조회 실패와 구분한다.
   */
  | { status: "store_unavailable" }
  | { status: "error"; message: string }
  | {
      status: "loaded";
      configured: boolean;
      masked: string | null;
      updatedAt: string | null;
    };

/** Builder가 명시한 credential store 미구성 응답만 operator remediation으로 분류한다. */
export function isCredentialStoreUnavailable(cause: unknown): boolean {
  if (!(cause instanceof ApiError) || cause.status !== 503) return false;
  if (!cause.details || typeof cause.details !== "object" || Array.isArray(cause.details)) return false;
  return (cause.details as { error?: unknown }).error === "credential store is not configured";
}

/** Builder GET /providers 요약을 화면 모델로 변환한다(연결 상태는 별도 status 점검으로 채운다). */
function mapProviderSummary(summary: ProviderSummary): ProviderConfig {
  return {
    id: summary.provider,
    name: summary.provider,
    requiresCredential: summary.requires_credential,
    summaryConfigured: summary.configured,
    description: summary.requires_credential
      ? i18n.t("provider.status.needsCred")
      : i18n.t("provider.status.noCred"),
  };
}

export function ProviderPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  // Add Data 등에서 `?provider=datago&returnTo=/add`로 넘어온 경우(#S-add-data, §4).
  // URL에는 provider id와 safe return destination만 싣는다 — credential/BuildSpec은
  // 절대 담지 않는다. providerParam은 목록이 로딩된 뒤 딱 한 번만 자동 선택에 쓴다.
  const providerParam = searchParams.get("provider");
  const returnToParam = searchParams.get("returnTo");
  const safeReturnTo = isSafeReturnTo(returnToParam) ? returnToParam : null;
  const providerParamAppliedRef = useRef(false);

  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderConfig | null>(null);
  const [showCredentialForm, setShowCredentialForm] = useState(false);
  const [credentialForm, setCredentialForm] = useState<CredentialForm>({ credential: "" });
  const [credentialMeta, setCredentialMeta] = useState<CredentialMetaState>({ status: "idle" });
  // credential을 이번 화면 방문에서 방금 저장했는지 — returnTo CTA는 저장 성공
  // 이후에만 보여준다(§4). provider 전환 시 reset한다.
  const [justSavedCredential, setJustSavedCredential] = useState(false);
  // credential 메타 조회/갱신 race guard는 두 축을 함께 본다:
  // (1) request-generation — 더 나중에 시작한 조회가 항상 이긴다.
  // (2) selectedProviderIdRef — 그 조회의 대상 provider가 "지금 화면에 선택된"
  //     provider와 같아야 한다. mutation(save/delete) 완료 후의 늦은
  //     loadCredentialMeta(A)가 generation을 최신으로 올려도, 그 사이 사용자가
  //     B로 옮겼다면 A의 결과/loading/error가 B 패널을 절대 덮지 못한다(#324, #322).
  const credentialRequestGeneration = useRef(0);
  const selectedProviderIdRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isRealBuilderEnabled()) {
        // real mode: GET /providers가 canonical source다. 실패를 mock 성공으로
        // 위장하지 않는다 — catch에서 명시적 error/빈 목록으로 떨어진다(#S01).
        const response = await builderApi.listProviders();
        const mapped = response.providers.map(mapProviderSummary);
        setProviders(mapped);
        // ref는 사용자 선택의 동기적 source of truth다. state updater/effect가 늦게
        // 실행되며 이미 B로 바뀐 ref를 A로 되돌리면 stale mutation refresh가 시작될 수
        // 있으므로, 목록 응답으로 선택을 재결정하지 않는다. 실제 목록에서 사라진 경우만
        // 명시적으로 선택을 해제한다.
        const selectedId = selectedProviderIdRef.current;
        const next = selectedId ? mapped.find((provider) => provider.id === selectedId) : undefined;
        if (!next) {
          if (selectedId) selectedProviderIdRef.current = null;
          setSelectedProvider(null);
        } else {
          setSelectedProvider(next);
        }
      } else {
        // 명시적 mock/demo mode에서만 mock 목록을 쓴다.
        setProviders(getMockProviders());
      }
    } catch {
      setError(i18n.t("provider.errors.loadProvider"));
      setProviders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  /**
   * 선택된 provider의 "사용자 저장 credential" 메타데이터를 authoritative하게 다시 읽는다.
   * requires_credential=false면 조회 자체를 하지 않는다(등록/삭제할 credential이 없음).
   */
  const loadCredentialMeta = useCallback(
    async (provider: ProviderConfig) => {
      const generation = ++credentialRequestGeneration.current;
      // 이 조회 결과를 화면에 반영해도 되는지: 가장 최신 조회이면서, 그 대상이
      // 여전히 선택된 provider일 때만. loading/error/loaded 커밋 전에 항상 확인한다.
      const stillCurrent = () =>
        generation === credentialRequestGeneration.current &&
        provider.id === selectedProviderIdRef.current;
      if (!provider.requiresCredential) {
        if (stillCurrent()) setCredentialMeta({ status: "not_applicable" });
        return;
      }
      if (stillCurrent()) setCredentialMeta({ status: "loading" });
      try {
        if (isRealBuilderEnabled()) {
          const meta = await builderApi.getProviderCredential(provider.id);
          if (!stillCurrent()) return;
          setCredentialMeta({
            status: "loaded",
            configured: meta.configured,
            masked: meta.masked,
            updatedAt: meta.updated_at,
          });
        } else {
          if (!stillCurrent()) return;
          setCredentialMeta(mockCredentialMeta(provider));
        }
      } catch (cause) {
        if (!stillCurrent()) return;
        if (isCredentialStoreUnavailable(cause)) {
          setCredentialMeta({ status: "store_unavailable" });
          return;
        }
        setCredentialMeta({ status: "error", message: i18n.t("provider.errors.credStatus") });
      }
    },
    [],
  );

  const handleProviderSelect = (provider: ProviderConfig) => {
    // 선택 전환은 동기적으로 ref에 반영한다 — 직후의 loadCredentialMeta가
    // 즉시 이 값을 기준으로 삼아야 하고, 진행 중이던 다른 provider의 조회는
    // 여기서부터 stale로 판정된다.
    selectedProviderIdRef.current = provider.id;
    ++credentialRequestGeneration.current;
    setSelectedProvider(provider);
    setShowCredentialForm(false);
    setCredentialForm({ credential: "" });
    setJustSavedCredential(false);
    void loadCredentialMeta(provider);
  };

  // `?provider=`로 넘어온 경우 목록이 로딩된 뒤 해당 provider를 한 번만 자동
  // 선택한다(#S-add-data, §4) — Discover의 catalog preselection과 같은 패턴
  // (한 번만 적용, 목록에 없으면 조용히 넘어간다).
  useEffect(() => {
    if (providerParamAppliedRef.current || loading || !providerParam) return;
    providerParamAppliedRef.current = true;
    const match = providers.find((p) => p.id === providerParam);
    if (match) handleProviderSelect(match);
  }, [providers, loading, providerParam]);

  const handleCredentialSubmit = async () => {
    if (!selectedProvider || !credentialForm.credential) return;
    if (!selectedProvider.requiresCredential) return;
    const provider = selectedProvider;
    setError(null);
    try {
      if (isRealBuilderEnabled()) {
        // PUT /providers/{provider}/credential, body는 { credential } 하나뿐. 원문은
        // response로 기대하지 않고, 선택된 provider의 canonical id를 URL에 쓴다(#S02).
        await builderApi.putProviderCredential(provider.id, credentialForm.credential);
      }
      // 저장이 진행되는 동안 사용자가 다른 provider로 옮겼다면, 이 mutation의 후속
      // form 리셋/에러가 현재 화면(B)을 오염시키면 안 된다(#322/#324와 같은 축).
      if (selectedProviderIdRef.current === provider.id) {
        setCredentialForm({ credential: "" });
        setShowCredentialForm(false);
        setJustSavedCredential(true);
      }
      // 목록은 authoritative하게 갱신하되, 다른 provider를 보고 있으면 A의
      // provider-specific refresh를 시작하지 않는다. 시작 자체가 global generation을
      // 올려 B의 pending GET을 stale로 만들 수 있기 때문이다.
      await loadProviders();
      if (selectedProviderIdRef.current === provider.id) {
        await loadCredentialMeta(provider);
      }
    } catch (cause) {
      if (selectedProviderIdRef.current !== provider.id) return;
      setError(
        isCredentialStoreUnavailable(cause)
          ? i18n.t("provider.errors.saveNoStore")
          : i18n.t("provider.errors.saveFail"),
      );
    }
  };

  const handleCredentialDelete = async () => {
    if (!selectedProvider) return;
    const provider = selectedProvider;
    setError(null);
    try {
      if (isRealBuilderEnabled()) {
        await builderApi.deleteProviderCredential(provider.id);
      }
      // 저장과 동일하게, 선택을 떠난 provider의 metadata refresh는 시작하지 않는다.
      await loadProviders();
      if (selectedProviderIdRef.current === provider.id) {
        await loadCredentialMeta(provider);
      }
    } catch (cause) {
      // 삭제 도중 다른 provider로 옮겼다면 이 실패를 현재 화면 에러로 노출하지 않는다.
      if (selectedProviderIdRef.current !== provider.id) return;
      setError(
        isCredentialStoreUnavailable(cause)
          ? i18n.t("provider.errors.deleteNoStore")
          : i18n.t("provider.errors.deleteFail"),
      );
    }
  };

  // 사용자 본인이 저장한 credential이 있는지(삭제 버튼/마스킹 값 표시의 유일한 근거).
  const userCredentialConfigured =
    credentialMeta.status === "loaded" && credentialMeta.configured;

  // Provider 상태 배지는 generic live probe가 아니라 credential readiness로 표현한다
  // (#S-provider-probe). 실제 Dataset API 사용 가능 여부는 Preview가 확인한다.
  // `userCredentialConfigured`는 지금 선택된 provider에서만 알 수 있으므로 목록
  // 배지에는 전달하지 않는다(요약 `configured`만 사용).
  const readinessToneClass: Record<"success" | "warning" | "neutral", string> = {
    success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
    warning: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
    neutral: "bg-muted text-muted-foreground",
  };
  const getReadinessPresentation = (
    provider: ProviderConfig,
    userConfigured?: boolean,
  ) => {
    const readiness = describeCredentialReadiness({
      requiresCredential: provider.requiresCredential,
      summaryConfigured: provider.summaryConfigured,
      userCredentialConfigured: userConfigured,
    });
    return { className: readinessToneClass[readiness.tone], label: readiness.label, detail: readiness.detail };
  };
  const canRegisterCredential =
    !!selectedProvider &&
    selectedProvider.requiresCredential &&
    credentialMeta.status === "loaded";

  return (
    <main className="flex flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow="Provider"
        title={t("provider.page.title")}
        description={t("provider.page.desc")}
        actions={<LinkButton to="/settings">{t("provider.page.settings")}</LinkButton>}
      />
      <p className="-mt-6 text-xs text-muted-foreground">
        {t("provider.page.note")}
      </p>

      {safeReturnTo ? (
        <Card variant="dashed" className="text-sm">
          {t("provider.page.cta")}
        </Card>
      ) : null}

      {error && (
        <Card variant="error">
          <p className="font-semibold">{error}</p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-1">
          <PageHeader eyebrow="Providers" title={t("provider.page.headerTitle")} className="mb-4" />
          <Card className="p-0">
            {loading ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="flex-1">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="mt-1 h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : providers.length === 0 ? (
              <EmptyState
                title={t("provider.page.emptyTitle")}
                description={t("provider.page.emptyDesc")}
              />
            ) : (
              <ul>
                {providers.map((provider) => (
                  <li
                    key={provider.id}
                    className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition hover:bg-muted/50 ${
                      selectedProvider?.id === provider.id ? "bg-muted/50" : ""
                    }`}
                    onClick={() => handleProviderSelect(provider)}
                  >
                    <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-lg font-semibold">
                      {provider.name.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{provider.name}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            getReadinessPresentation(provider).className
                          }`}
                        >
                          {getReadinessPresentation(provider).label}
                        </span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section className="lg:col-span-2">
          {!selectedProvider ? (
            <Card>
              <EmptyState
                title={t("provider.page.selectTitle")}
                description={t("provider.page.selectDesc")}
              />
            </Card>
          ) : (
            <div className="space-y-6">
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">{t("provider.detail.connStatus")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {getReadinessPresentation(selectedProvider, userCredentialConfigured).detail}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      getReadinessPresentation(selectedProvider, userCredentialConfigured).className
                    }`}
                  >
                    {getReadinessPresentation(selectedProvider, userCredentialConfigured).label}
                  </span>
                </div>
                <p className="mt-4 text-xs text-muted-foreground">
                  {t("provider.detail.scopeNote")}
                </p>
              </Card>

              <Card>
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold">{t("provider.detail.credTitle")}</h4>
                  {userCredentialConfigured ? (
                    <Button size="sm" variant="danger" onClick={handleCredentialDelete}>
                      {t("provider.detail.delete")}
                    </Button>
                  ) : canRegisterCredential && !showCredentialForm ? (
                    <Button size="sm" onClick={() => setShowCredentialForm(true)}>
                      {selectedProvider.summaryConfigured ? t("provider.detail.registered") : t("provider.detail.register")}
                    </Button>
                  ) : null}
                </div>

                {!selectedProvider.requiresCredential ? (
                  <p className="mt-4 text-sm text-muted-foreground">
                    {t("provider.detail.noCredNote")}
                  </p>
                ) : credentialMeta.status === "loading" || credentialMeta.status === "idle" ? (
                  <p className="mt-4 text-sm text-muted-foreground">
                    {t("provider.detail.loading")}
                  </p>
                ) : credentialMeta.status === "store_unavailable" ? (
                  <div className="mt-4 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">
                      {t("provider.detail.noStoreTitle")}
                    </p>
                    <p className="mt-2">
                      {t("provider.detail.noStoreBody")}
                    </p>
                  </div>
                ) : credentialMeta.status === "error" ? (
                  <p className="mt-4 text-sm text-red-600 dark:text-red-400">
                    {credentialMeta.message}
                  </p>
                ) : showCredentialForm ? (
                  <div className="mt-4 space-y-4">
                    <div>
                      <label className="block text-sm font-medium mb-2">API Key</label>
                      <input
                        type="password"
                        className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
                        placeholder={t("provider.detail.keyPlaceholder")}
                        value={credentialForm.credential}
                        onChange={(e) =>
                          setCredentialForm({ ...credentialForm, credential: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={handleCredentialSubmit}
                        disabled={!credentialForm.credential}
                      >
                        {t("provider.detail.save")}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setShowCredentialForm(false);
                          setCredentialForm({ credential: "" });
                        }}
                      >
                        {t("provider.detail.cancel")}
                      </Button>
                    </div>
                  </div>
                ) : credentialMeta.status === "loaded" && credentialMeta.configured ? (
                  <div className="mt-4">
                    <div className="text-sm text-muted-foreground">
                      <span className="font-medium">{t("provider.detail.savedKey")}</span>{" "}
                      {credentialMeta.masked ?? t("provider.detail.configured")}
                    </div>
                    {credentialMeta.updatedAt ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("provider.detail.lastUpdated")}{" "}
                        {new Date(credentialMeta.updatedAt).toLocaleString("ko-KR")}
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("provider.detail.maskingNote")}
                    </p>
                    {justSavedCredential && safeReturnTo ? (
                      <div className="mt-4">
                        <LinkButton to={safeReturnTo}>{t("provider.detail.backToData")}</LinkButton>
                      </div>
                    ) : null}
                  </div>
                ) : selectedProvider.summaryConfigured ? (
                  <p className="mt-4 text-sm text-muted-foreground">
                    {t("provider.detail.defaultCredNote")}
                  </p>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    {t("provider.detail.needsCredNote")}
                  </p>
                )}
              </Card>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

/** mock/demo 모드에서 선택된 provider의 사용자 credential 상태를 시뮬레이션한다. */
function mockCredentialMeta(provider: ProviderConfig): CredentialMetaState {
  if (!provider.requiresCredential) return { status: "not_applicable" };
  const configured = provider.summaryConfigured;
  return {
    status: "loaded",
    configured,
    masked: configured ? "ab••••yz" : null,
    updatedAt: configured ? new Date(Date.now() - 3600000).toISOString() : null,
  };
}

function getMockProviders(): ProviderConfig[] {
  return [
    {
      id: "datago",
      name: "데이터고",
      description: "대한민국 대표 공공데이터 포털",
      requiresCredential: true,
      summaryConfigured: false,
    },
    {
      id: "kosis",
      name: "KOSIS",
      description: "한국 통계청 통계포털",
      requiresCredential: true,
      summaryConfigured: true,
    },
    {
      id: "g2b",
      name: "G2B",
      description: "국가과학기술정보원",
      requiresCredential: true,
      summaryConfigured: false,
    },
  ];
}
