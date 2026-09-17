/**
 * Add Data Workbench (`/add`, #250).
 *
 * Add Data → Source → Configure → Canonical BuildSpec → Preview & Validation → Review →
 * Build → Builds/Runs. Prototype(`kpubdata_ui_prototype_v1.html`)의 4단계 wizard
 * 구조(Source/Configure/Preview & Validate/Review & Build)를 그대로 따르되, 실제
 * 값/상태/limit/availability는 Builder 계약을 따른다.
 *
 * 재사용:
 *  - Builder API client/Zod 스키마 — `shared/lib/builderApi.ts`
 *  - BuildSpec 매핑/직렬화 — `features/build-spec/specMapping.ts`(제출과 Review 표시가
 *    같은 `toBuilderSpec` 호출 결과를 쓰도록 보장, #250 amendment 1)
 *  - 초안 저장 — `features/build-spec/draftStorage.ts`(다른 key로 재사용)
 *  - Preview/Validate/Build 실행 — `features/preview/api`, `features/validation/api`,
 *    `features/runs/useBuildJob`(mock/real 분기와 실제 run_id 보장을 그대로 물려받음)
 *  - Quality 표시 — `features/quality/model.ts`, `features/quality/QualityBadge`
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fetchCatalog, fetchProviderConfigured, uploadSourceFile } from "@/features/add-data/api";
import { CREDENTIAL_PREREQUISITE_MESSAGE, checkCredentialPrerequisite } from "@/features/add-data/credentialPrerequisite";
import { ConfigureStep, type CatalogState, type UploadState } from "@/features/add-data/components/ConfigureStep";
import { PreviewValidationStep, type PreviewState } from "@/features/add-data/components/PreviewValidationStep";
import { ReviewBuildStep } from "@/features/add-data/components/ReviewBuildStep";
import { SourceStep } from "@/features/add-data/components/SourceStep";
import { clearAddDataDraft, hasAddDataDraft, loadAddDataDraft, saveAddDataDraft } from "@/features/add-data/draftStorage";
import { checkRequiredParams } from "@/features/add-data/requiredParams";
import { findDataset, identityFromCatalog, identityFromFilename, identityFromUrl } from "@/features/add-data/identity";
import {
  INITIAL_DRAFT,
  applyBuildSpecToDraft,
  buildEditableSpecFromDraft,
  buildSpecFromDraft,
  draftSignature,
  type AddDataDraft,
  type PreviewColumnView,
  type PreviewLimit,
  type PreviewSampleMode,
} from "@/features/add-data/model";
import { BuildSpecShapeError, YamlSyntaxError, fromYamlText, toYamlText } from "@/features/build-spec/yamlText";
import type { SourceKind } from "@/shared/lib/types";
import { previewBuildDetailed } from "@/features/preview/api";
import { useBuildJob } from "@/features/runs/useBuildJob";
import { validateSpec } from "@/features/validation/api";
import { i18n } from "@/shared/i18n";
import { Button, Card, PageHeader, Stepper } from "@/shared/ui";

// 라벨은 화면 언어를 따라야 하므로 상수로 굳히지 않고 렌더 시점에 만든다.
const STEP_IDS = ["source", "configure", "preview", "review"] as const;


export function AddDataPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const job = useBuildJob();

  const [draft, setDraft] = useState<AddDataDraft>(INITIAL_DRAFT);
  const [step, setStep] = useState(0);
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading", providers: [] });
  // provider별 effective credential 구성 여부(GET /providers 요약). null = 아직
  // 로딩 중이거나 조회 실패 — credential prerequisite는 이때 아무것도 막지 않는다
  // (§3: Studio가 credential 존재 여부를 추측하지 않는다).
  const [providerConfigured, setProviderConfigured] = useState<Record<string, boolean> | null>(null);
  const [upload, setUpload] = useState<UploadState>({ status: "idle" });
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [previewView, setPreviewView] = useState<"sample" | "diff">("sample");
  const [validation, setValidation] = useState<{ status: "idle" | "validating" | "validated"; valid: boolean; errors: string[] }>(
    { status: "idle", valid: false, errors: [] },
  );
  const [yamlEditError, setYamlEditError] = useState<string>();
  const [draftAvailable, setDraftAvailable] = useState(() => hasAddDataDraft());
  const [draftSaved, setDraftSaved] = useState(false);
  const [lastPreviewSignature, setLastPreviewSignature] = useState<string | null>(null);

  const preselectApplied = useRef(false);
  // 직전에 identity를 자동 반영한 "source 자체"의 key(#250 최종 검증 §1).
  // provider+dataset/URL identity/파일 등 source identity가 바뀌면(같은 source의 세부
  // 설정 변경이 아니라 다른 source로의 교체) touched 플래그를 reset하고 새 identity를
  // 강제로 적용한다 — query params/output/preview 같은 세부 설정 변경과 구분하기 위함.
  const lastIdentitySourceRef = useRef<string | null>(null);
  const previewRequestIdRef = useRef(0);

  const updateDraft = useCallback((patch: Partial<AddDataDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  // Source/설정이 preview 이후 바뀌면 stale로 취급한다(#250 §2, §6).
  const currentSignature = draftSignature(draft);
  const isStale = lastPreviewSignature !== null && lastPreviewSignature !== currentSignature;

  useEffect(() => {
    const controller = new AbortController();
    fetchCatalog(controller.signal)
      .then((response) => setCatalog({ status: "loaded", providers: response.providers }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setCatalog({
          status: "error",
          providers: [],
          error: cause instanceof Error ? cause.message : i18n.t("addData.errors.catalog"),
        });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchProviderConfigured(controller.signal)
      .then((configured) => {
        if (!controller.signal.aborted) setProviderConfigured(configured);
      })
      .catch(() => {
        // 조회 실패는 "미설정"으로 단정하지 않는다 — null 그대로 두면 prerequisite가
        // 막지 않는다(위 상태 선언 주석 참고).
      });
    return () => controller.abort();
  }, []);

  // Discover preselection(#249 완료를 hard blocker로 두지 않는다 — 쿼리 파라미터만 읽는다).
  useEffect(() => {
    if (preselectApplied.current || catalog.status !== "loaded") return;
    const provider = searchParams.get("provider");
    const dataset = searchParams.get("dataset");
    if (!provider || !dataset) return;
    const found = catalog.providers.find((p) => p.name === provider)?.datasets.find((d) => d.name === dataset);
    preselectApplied.current = true;
    if (!found) return;
    setDraft((current) => ({
      ...current,
      sourceKind: "public_api",
      publicApi: { ...current.publicApi, provider, dataset },
    }));
    setStep(1);
  }, [catalog, searchParams]);

  // Public API: provider/dataset 선택이 바뀌면 catalog dataset 기준으로 dataset
  // identity(ID/제목/설명)를 자동 반영한다(#250 amendment 2). 사용자가 고급 설정에서
  // 이미 직접 고친 필드(*Touched)는 "같은 dataset"의 세부 설정(query params 등) 변경
  // 동안에는 유지한다 — 그러나 provider/dataset 자체가 바뀌면(다른 source로 교체)
  // touched를 reset하고 새 catalog dataset identity를 강제 적용한다(#250 최종 검증 §1).
  useEffect(() => {
    if (draft.sourceKind !== "public_api") return;
    const { provider, dataset } = draft.publicApi;
    if (!provider || !dataset) return;
    const catalogDataset = findDataset(catalog.providers, provider, dataset);
    if (!catalogDataset) return;
    const identity = identityFromCatalog(provider, catalogDataset);
    const sourceKey = `public_api:${provider}:${dataset}`;
    setDraft((current) => {
      if (current.sourceKind !== "public_api" || current.publicApi.provider !== provider || current.publicApi.dataset !== dataset) {
        return current;
      }
      const sourceChanged = lastIdentitySourceRef.current !== null && lastIdentitySourceRef.current !== sourceKey;
      lastIdentitySourceRef.current = sourceKey;
      if (sourceChanged) {
        // 이 effect는 자동 생성 identity(ID/제목/설명)와 touched 플래그만 담당한다.
        // 이전 Dataset 전용 요청 파라미터(sourceParams) 초기화는 Provider/Dataset
        // <select> onChange가 같은 updateDraft에서 atomic하게 처리한다 — 여기서
        // 하면 setDraft updater 안에서 ref를 mutate하는 특성상 StrictMode의 updater
        // 이중 호출에서 reset 결과가 버려질 수 있다(#S-stale-params).
        return {
          ...current,
          datasetId: identity.datasetId,
          title: identity.title,
          description: identity.description,
          datasetIdTouched: false,
          titleTouched: false,
          descriptionTouched: false,
        };
      }
      const patch: Partial<AddDataDraft> = {};
      if (!current.datasetIdTouched && current.datasetId !== identity.datasetId) patch.datasetId = identity.datasetId;
      if (!current.titleTouched && current.title !== identity.title) patch.title = identity.title;
      if (!current.descriptionTouched && current.description !== identity.description) patch.description = identity.description;
      return Object.keys(patch).length > 0 ? { ...current, ...patch } : current;
    });
  }, [draft.sourceKind, draft.publicApi.provider, draft.publicApi.dataset, catalog.providers]);

  // URL: endpoint에서 안전한 hostname/path만으로 dataset identity를 자동 반영한다
  // (query string/credential은 identityFromUrl이 애초에 포함하지 않는다). identity의
  // 기반인 hostname+path 자체가 바뀌면(다른 endpoint로 교체) touched를 reset하고 새
  // identity를 강제 적용한다 — query string만 바뀌는 경우(같은 endpoint identity)는
  // touched 상태를 그대로 유지해 사용자가 고친 metadata를 지키지 않는다(#250 최종 검증 §1).
  useEffect(() => {
    if (draft.sourceKind !== "url" || !draft.url.endpoint) return;
    const identity = identityFromUrl(draft.url.endpoint);
    if (!identity.datasetId) return;
    // identity.datasetId는 hostname+path에서만 결정되므로(쿼리스트링 제외), 이 값 자체가
    // "같은 endpoint identity인지"를 판정하는 key로 그대로 쓸 수 있다.
    const sourceKey = `url:${identity.datasetId}`;
    setDraft((current) => {
      if (current.sourceKind !== "url" || current.url.endpoint !== draft.url.endpoint) return current;
      const sourceChanged = lastIdentitySourceRef.current !== null && lastIdentitySourceRef.current !== sourceKey;
      lastIdentitySourceRef.current = sourceKey;
      if (sourceChanged) {
        return {
          ...current,
          datasetId: identity.datasetId,
          title: identity.title,
          description: identity.description,
          datasetIdTouched: false,
          titleTouched: false,
          descriptionTouched: false,
        };
      }
      const patch: Partial<AddDataDraft> = {};
      if (!current.datasetIdTouched && current.datasetId !== identity.datasetId) patch.datasetId = identity.datasetId;
      if (!current.titleTouched && current.title !== identity.title) patch.title = identity.title;
      if (!current.descriptionTouched && current.description !== identity.description) patch.description = identity.description;
      return Object.keys(patch).length > 0 ? { ...current, ...patch } : current;
    });
  }, [draft.sourceKind, draft.url.endpoint]);

  // source kind 자체를 바꾸는 것은 "다른 source로 교체"의 가장 큰 단위다 — touched
  // 플래그와 자동 생성 identity 기반 필드를 reset해 이전 source의 metadata가 잔존하지
  // 않게 한다(#250 최종 검증 §1).
  function selectSource(kind: AddDataDraft["sourceKind"]) {
    setDraft((current) => {
      if (current.sourceKind === kind) return current;
      lastIdentitySourceRef.current = null;
      return {
        ...current,
        sourceKind: kind,
        datasetId: "",
        title: "",
        description: "",
        datasetIdTouched: false,
        titleTouched: false,
        descriptionTouched: false,
      };
    });
  }

  function goNext() {
    if (step === 0 && !draft.sourceKind) return;
    if (step === 1 && buildSpecFromDraft(draft).error) return;
    setStep((s) => Math.min(s + 1, STEP_IDS.length - 1));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 0));
  }

  /**
   * "API 연결하기" CTA — 기존 draft persistence(`saveAddDataDraft`)를 그대로 재사용해
   * 초안을 저장한 뒤 Provider 화면으로 이동한다. URL에는 provider id와 safe return
   * destination만 싣는다 — credential/BuildSpec 전체는 절대 담지 않는다(§4).
   */
  function handleConnectProvider(provider: string) {
    saveAddDataDraft(draft);
    navigate(`/provider?provider=${encodeURIComponent(provider)}&returnTo=${encodeURIComponent("/add")}`);
  }

  async function handleUploadFile(file: File) {
    if (!draft.file.format) return;
    setUpload({ status: "uploading" });
    try {
      const meta = await uploadSourceFile(file, draft.file.format);
      const identity = identityFromFilename(meta.original_filename ?? file.name);
      // 업로드는 항상 "파일을 (새로) 선택"하는 행위다 — 기존 파일을 다른 파일로
      // 교체하는 경우를 포함해 매번 touched를 reset하고 새 filename identity를 적용한다
      // (#250 최종 검증 §1: "File을 다른 파일로 교체: touched reset 후 새 filename identity 적용").
      lastIdentitySourceRef.current = `file:${meta.original_filename ?? file.name}`;
      setDraft((current) => ({
        ...current,
        file: {
          uploadId: meta.upload_id,
          format: meta.format,
          encoding: meta.encoding,
          filename: meta.original_filename,
          sizeBytes: meta.size_bytes,
        },
        datasetId: identity.datasetId,
        title: identity.title,
        description: identity.description,
        datasetIdTouched: false,
        titleTouched: false,
        descriptionTouched: false,
      }));
      setUpload({ status: "done" });
    } catch (cause) {
      setUpload({
        status: "error",
        error: cause instanceof Error ? cause.message : i18n.t("addData.errors.upload"),
      });
    }
  }

  function handleApplyYaml(text: string) {
    try {
      const spec = fromYamlText(text);
      // YAML Apply는 explicit authoring(#250 amendment 2)이라 applyBuildSpecToDraft가
      // *Touched를 모두 true로 세팅한다 — 그런데 Public API/URL identity effect는
      // provider/dataset/endpoint 변경만 보고 "source가 바뀌었는지"를 판단하므로,
      // lastIdentitySourceRef를 YAML이 실어온 source 기준으로 먼저 동기화해두지 않으면
      // sourceChanged로 오판해 방금 세팅한 explicit metadata를 곧바로 덮어쓴다
      // (#283 후속 리뷰 §6). 최소 구조로 ref만 앞서 맞춰 이후 effect가 "같은 source의
      // 세부 설정" 경로(= touched 존중)를 타게 한다.
      const appliedSource = spec.sources[0];
      const appliedKind: SourceKind = appliedSource?.kind ?? "public_api";
      if (appliedKind === "public_api" && appliedSource?.provider && appliedSource.dataset) {
        lastIdentitySourceRef.current = `public_api:${appliedSource.provider}:${appliedSource.dataset}`;
      } else if (appliedKind === "url" && appliedSource?.endpoint) {
        const identity = identityFromUrl(appliedSource.endpoint);
        lastIdentitySourceRef.current = identity.datasetId ? `url:${identity.datasetId}` : lastIdentitySourceRef.current;
      }
      setDraft((current) => applyBuildSpecToDraft(current, spec));
      setYamlEditError(undefined);
    } catch (cause) {
      if (cause instanceof YamlSyntaxError) {
        setYamlEditError(i18n.t("addData.errors.yamlSyntax", { message: cause.message }));
      } else if (cause instanceof BuildSpecShapeError) {
        setYamlEditError(cause.message);
      } else {
        setYamlEditError(i18n.t("addData.errors.yamlApply"));
      }
    }
  }

  async function runPreviewAndValidate() {
    // invalid/local-failure 요청도 기존에 진행 중이던 network request를 논리적으로
    // stale 처리해야 하므로(#283 후속 리뷰 §4), specResult 계산·early return보다 먼저
    // requestId를 올린다. 그래야 늦게 도착하는 이전 요청의 응답이 이번 로컬 오류 상태를
    // 덮어쓰지 않는다.
    const requestId = ++previewRequestIdRef.current;
    const specResult = buildSpecFromDraft(draft);
    if (specResult.error || !specResult.spec) {
      setPreview({ status: "error", error: specResult.error ?? i18n.t("addData.errors.spec") });
      setValidation({
        status: "validated",
        valid: false,
        errors: [specResult.error ?? i18n.t("addData.errors.spec")],
      });
      return;
    }
    const spec = specResult.spec;

    // Preview 전 usability preflight — Dataset metadata로 필수 요청 파라미터를 아는
    // 경우에만 동작한다. 누락이면 Preview API를 호출하지 않고 사용자 문구로 안내한다
    // (Builder/Core validation을 대체하지 않는 사전 안내).
    if (draft.sourceKind === "public_api") {
      const selected = findDataset(catalog.providers, draft.publicApi.provider, draft.publicApi.dataset);

      // credential prerequisite — Preview까지 가서 뒤늦게 credential 오류로 실패하지
      // 않는다(§3). Configure 단계 배너와 같은 판정을 재사용한다.
      const prerequisite = checkCredentialPrerequisite(selected, providerConfigured, draft.publicApi.provider);
      if (prerequisite.blocked) {
        const message = `${CREDENTIAL_PREREQUISITE_MESSAGE.title} — ${CREDENTIAL_PREREQUISITE_MESSAGE.body.replace("\n", " ")}`;
        setPreview({ status: "error", error: message });
        setValidation({ status: "validated", valid: false, errors: [message] });
        return;
      }

      const requiredCheck = checkRequiredParams(draft.publicApi.sourceParams, selected?.request_parameters);
      if (requiredCheck.error) {
        setPreview({ status: "error", error: requiredCheck.error });
        setValidation({ status: "validated", valid: false, errors: [requiredCheck.error] });
        return;
      }
    }

    const signatureAtRequest = draftSignature(draft);
    setPreview({ status: "loading" });
    setValidation({ status: "validating", valid: false, errors: [] });

    const [previewOutcome, validateOutcome] = await Promise.allSettled([
      previewBuildDetailed(spec, { limit: draft.previewLimit, sample_mode: draft.previewSampleMode }),
      validateSpec(spec),
    ]);

    if (requestId !== previewRequestIdRef.current) return;
    if (previewOutcome.status === "fulfilled") {
      setPreview({ status: "loaded", response: previewOutcome.value });
      setLastPreviewSignature(signatureAtRequest);
    } else {
      setPreview({
        status: "error",
        error: previewOutcome.reason instanceof Error
            ? previewOutcome.reason.message
            : i18n.t("addData.errors.preview"),
      });
    }

    if (requestId !== previewRequestIdRef.current) return;
    if (validateOutcome.status === "fulfilled") {
      setValidation({ status: "validated", valid: validateOutcome.value.valid, errors: validateOutcome.value.errors });
    } else {
      setValidation({
        status: "validated",
        valid: false,
        errors: [
          validateOutcome.reason instanceof Error
            ? validateOutcome.reason.message
            : i18n.t("addData.errors.validate"),
        ],
      });
    }
  }

  function saveCurrentDraft() {
    saveAddDataDraft(draft);
    setDraftSaved(true);
  }

  function restoreDraft() {
    const saved = loadAddDataDraft();
    if (!saved) {
      clearAddDataDraft();
      setDraftAvailable(false);
      return;
    }
    setDraft(saved);
    setDraftAvailable(false);
  }

  function discardDraft() {
    clearAddDataDraft();
    setDraftAvailable(false);
  }

  const specResult = buildSpecFromDraft(draft);
  const editableSpec = buildEditableSpecFromDraft(draft);
  const previewSources = preview.status === "loaded" ? preview.response.previews : [];

  // Build 성공(실연동 모드는 항상 Builder가 반환한 실제 run_id, mock 모드는 기존 mock 경로
  // 그대로) 시 Builds/Runs로 이동한다. mock run id를 새로 만들지 않는다 — useBuildJob이
  // 이미 실제 run_id/mock-run 구분을 보장한다.
  useEffect(() => {
    if (job.status === "succeeded" && job.run) {
      clearAddDataDraft();
      navigate(`/builds/${encodeURIComponent(job.run.id)}`);
    }
  }, [job.status, job.run, navigate]);

  return (
    // sticky bottom actions(이전/초안 저장/다음, 아래)는 sm 미만에서만 sticky이고, sticky로
    // "고정"되는 동안에도 그 flow상 높이는 그대로 보존되어 뒤 이어지는 형제가 없어도 스크롤 중에는
    // 화면에 떠서 마지막 content를 가릴 수 있다(390px 폭, UI audit #6-B) — 문서 전체 높이가
    // 짧으면 마지막 필드/버튼이 그 sticky bar 뒤로 영영 가려질 수 있다. sm 미만에서만 sticky bar
    // 높이(약 63px)보다 넉넉한 하단 여백을 둬서 항상 완전히 스크롤해서 벗어날 수 있게 한다 —
    // sm 이상은 sticky가 static이 되므로(#6-B 대상 아님) 기존 desktop 여백을 그대로 유지한다.
    <main className="flex flex-1 flex-col gap-6 px-5 pt-8 pb-28 sm:px-8 sm:pb-8 lg:px-10 lg:pt-10 lg:pb-10">
      <PageHeader
        eyebrow="Add Data"
        title={t("addData.page.title")}
        description={t("addData.page.desc")}
      />

      {draftAvailable ? (
        <Card variant="dashed" className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-foreground">{t("addData.draft.prompt")}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={restoreDraft}>{t("addData.draft.restore")}</Button>
            <Button size="sm" variant="ghost" onClick={discardDraft}>{t("addData.draft.discard")}</Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <Stepper
          steps={STEP_IDS.map((id) => ({ id, label: t(`addData.steps.${id}`) }))}
          current={step}
          onStepClick={setStep}
        />
      </Card>

      <Card>
        {step === 0 ? <SourceStep selected={draft.sourceKind} onSelect={selectSource} /> : null}

        {step === 1 ? (
          <ConfigureStep
            draft={draft}
            updateDraft={updateDraft}
            catalog={catalog}
            providerConfigured={providerConfigured}
            onConnectProvider={handleConnectProvider}
            upload={upload}
            onUploadFile={handleUploadFile}
            specError={specResult.error}
            // 제출 가능 여부(sentinel fail-closed 포함)와 무관하게 지금 draft로 보여줄
            // 수 있는 canonical spec을 그린다(#283 후속 리뷰 §3) — sentinel 때문에
            // specResult.spec이 비어도 YAML 편집 자리 자체가 사라지지 않아야, 사용자가
            // sentinel을 실제 값으로 바꿔 다시 Apply할 수 있다.
            yamlText={editableSpec ? toYamlText(editableSpec) : ""}
            yamlEditError={yamlEditError}
            onApplyYaml={handleApplyYaml}
          />
        ) : null}

        {step === 2 ? (
          <PreviewValidationStep
            preview={preview}
            limit={draft.previewLimit}
            sampleMode={draft.previewSampleMode}
            columns={draft.previewColumns}
            onChangeLimit={(limit: PreviewLimit) => updateDraft({ previewLimit: limit })}
            onChangeSampleMode={(mode: PreviewSampleMode) => updateDraft({ previewSampleMode: mode })}
            onChangeColumns={(columns: PreviewColumnView) => updateDraft({ previewColumns: columns })}
            onRefresh={() => void runPreviewAndValidate()}
            isStale={isStale}
            view={previewView}
            onChangeView={setPreviewView}
          />
        ) : null}

        {step === 3 ? (
          <ReviewBuildStep
            draft={draft}
            spec={specResult.spec}
            specError={specResult.error}
            validation={validation}
            previewSources={previewSources}
            previewLimit={draft.previewLimit}
            previewSampleMode={draft.previewSampleMode}
            isStale={isStale}
            jobStatus={job.status}
            jobError={job.error}
            jobInterrupted={job.interrupted}
            runId={job.run?.id}
            onBuild={() => {
              if (specResult.spec) void job.start(specResult.spec);
            }}
            onCancel={job.cancel}
          />
        ) : null}

        <div className="sticky bottom-0 z-10 -mx-6 -mb-6 mt-8 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-6 py-3 backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none sm:dark:bg-transparent">
          <Button variant="ghost" onClick={goBack} disabled={step === 0}>{t("addData.nav.back")}</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={saveCurrentDraft}>
              {draftSaved ? t("addData.nav.saved") : t("addData.nav.saveDraft")}
            </Button>
            {step < STEP_IDS.length - 1 ? <Button onClick={goNext}>{t("addData.nav.next")}</Button> : null}
          </div>
        </div>
      </Card>
    </main>
  );
}
