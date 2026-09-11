/**
 * 새 빌드 작성 마법사(New Build Wizard) 화면.
 *
 * 단일 폼 대신 단계별 Stepper로 안내한다(제안 §5.2): 기본 정보 → 데이터 소스 →
 * 파라미터 → 미리보기 → 출력 형식 → 검증·실행. React Hook Form으로 입력을 관리하고
 * 각 단계 진행 전에 해당 단계 필드만 검증한다. Preview/Validate는 독립 페이지가 아니라
 * 마법사 내부 단계로 통합되어 있다(§5.3/§5.4).
 */
import { useTranslation } from "react-i18next";
import { i18n } from "@/shared/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useParams, useSearchParams } from "react-router-dom";
import { clearDraft, hasDraft, loadDraft, saveDraft } from "@/features/build-spec/draftStorage";
import { parseSourceParams } from "@/features/build-spec/paramsInput";
import {
  jsonValueHasRedactedSecret,
  redactSourceParamsText,
  sourceParamsHasRedactedSecret,
} from "@/features/add-data/paramsRedaction";
import { previewBuild } from "@/features/preview/api";
import { useBuild } from "@/features/runs/useBuild";
import { useBuildJob } from "@/features/runs/useBuildJob";
import { validateSpec } from "@/features/validation/api";
import { createSavedSpec, getSavedSpec } from "@/features/workspace/savedSpecs";
import type { SavedSpecValidation } from "@/features/workspace/types";
import { builderApi, type CatalogDataset, type CatalogProvider } from "@/shared/lib/builderApi";
import { providerLabel } from "@/shared/lib/providerLabels";
import { buildFormValuesSchema, buildSpecSchema, exportFormatSchema } from "@/shared/lib/schemas";
import type { BuildSpec } from "@/shared/lib/types";
import {
  Button,
  Card,
  EmptyState,
  FormField,
  PageHeader,
  Select,
  StatusBadge,
  Stepper,
  TextInput,
  Textarea,
  type StepItem,
} from "@/shared/ui";

const exportFormats = exportFormatSchema.options;

interface BuildFormValues {
  datasetId: string;
  title: string;
  description: string;
  provider: string;
  sourceDataset: string;
  sourceParams: string;
  outputPath: string;
  exportFormats: string[];
}

const initialValues: BuildFormValues = {
  datasetId: "",
  title: "",
  description: "",
  provider: "",
  sourceDataset: "",
  sourceParams: "{}",
  outputPath: "artifacts/builds/example",
  exportFormats: ["jsonl"],
};

// 빌드 시작 템플릿(제안 §5.2.1). 선택 시 폼을 해당 값으로 채우고 다음 단계로 넘어간다.
interface BuildTemplate {
  id: string;
  name: string;
  description: string;
  values: BuildFormValues;
}

const TEMPLATES: BuildTemplate[] = [
  {
    id: "blank",
    name: i18n.t("newBuild.templates.blank"),
    description: i18n.t("newBuild.templates.blankDesc"),
    values: initialValues,
  },
  {
    id: "air_quality",
    name: i18n.t("newBuild.templates.air"),
    description: i18n.t("newBuild.templates.airDesc"),
    values: {
      datasetId: "datago-air-quality",
      title: i18n.t("newBuild.templates.airTitle"),
      description: i18n.t("newBuild.templates.airSourceDesc"),
      provider: "datago",
      sourceDataset: "air_quality",
      sourceParams: '{"sidoName": "서울"}',
      outputPath: "artifacts/builds/air-quality",
      exportFormats: ["jsonl"],
    },
  },
  {
    id: "interest_rate",
    name: i18n.t("newBuild.templates.rate"),
    description: i18n.t("newBuild.templates.rateDesc"),
    values: {
      datasetId: "bok-interest-rate",
      title: i18n.t("newBuild.templates.rateTitle"),
      description: i18n.t("newBuild.templates.rateSourceDesc"),
      provider: "bok",
      sourceDataset: "base_rate",
      sourceParams: '{"stat_code": "722Y001"}',
      outputPath: "artifacts/builds/bok-interest-rate",
      exportFormats: ["jsonl", "parquet"],
    },
  },
  {
    id: "population",
    name: i18n.t("newBuild.templates.pop"),
    description: i18n.t("newBuild.templates.popDesc"),
    values: {
      datasetId: "kosis-population",
      title: i18n.t("newBuild.templates.popTitle"),
      description: i18n.t("newBuild.templates.popSourceDesc"),
      provider: "kosis",
      sourceDataset: "population_migration",
      sourceParams: '{"region": "11"}',
      outputPath: "artifacts/builds/population",
      exportFormats: ["jsonl"],
    },
  },
];

function buildSteps(t: (k: string) => string): StepItem[] {
  return [
    { id: "template", label: t("newBuild.steps.template") },
    { id: "identity", label: t("newBuild.steps.identity") },
    { id: "source", label: t("newBuild.steps.source") },
    { id: "params", label: t("newBuild.steps.params") },
    { id: "preview", label: t("newBuild.steps.preview") },
    { id: "output", label: t("newBuild.steps.output") },
    { id: "review", label: t("newBuild.steps.review") },
  ];
}

// 각 단계에서 Next 진입 전에 검증할 폼 필드. Template/Preview/Review 단계는 입력 필드가 없다.
const STEP_FIELDS: Array<Array<keyof BuildFormValues>> = [
  [],
  ["datasetId", "title", "description"],
  ["provider", "sourceDataset"],
  ["sourceParams"],
  [],
  ["exportFormats", "outputPath"],
  [],
];

/**
 * 폼 입력값으로 BuildSpec 후보를 만들고 zod로 검증한다.
 *
 * 폼은 소스 하나와 outputPath만 다루지만, 편집 대상 스펙은 소스를 여럿 갖거나 폼에
 * 대응 필드가 없는 메타데이터(source_url, hf_repo 등)를 갖고 있을 수 있다. `base`가
 * 주어지면 폼이 표현하지 못하는 부분을 그대로 이어받아, 편집 왕복만으로 스펙이
 * 손실되는 것을 막는다 (#120).
 *
 * @param values - 현재 폼 입력값.
 * @param base - 편집 중인 원본 스펙(신규 작성 시 생략).
 * @returns 검증을 통과한 스펙 또는 한국어 오류 메시지.
 */
function toBuildSpec(
  values: BuildFormValues,
  base?: BuildSpec | null,
): { spec?: BuildSpec; error?: string } {
  // 저장된 초안/스펙을 복원했는데 sourceParams의 secret 값이 이미 redaction marker로 지워져
  // 있으면 fail-closed — marker를 실제 파라미터처럼 Builder에 제출하지 않는다(S07, Add Data
  // Workbench의 `buildSpecFromDraft`와 동일 정책). 사용자가 값을 다시 입력해야 한다.
  // `[REDACTED]`(specStore/savedSpecs) · `__KPD_*_REDACTED__`(draft) · `__SCRUBBED_*` 모두 포함.
  if (sourceParamsHasRedactedSecret(values.sourceParams)) {
    return { error: i18n.t("newBuild.errors.draftSecretRemoved") };
  }

  const parsedParams = parseSourceParams(values.sourceParams);
  if (parsedParams.error) {
    return { error: parsedParams.error };
  }

  const candidate: BuildSpec = {
    datasetId: values.datasetId,
    title: values.title,
    description: values.description,
    sources: [
      { provider: values.provider, dataset: values.sourceDataset, params: parsedParams.data ?? {} },
      // 폼이 편집하지 않는 2번째 이후 소스는 원본 그대로 보존한다.
      ...(base?.sources.slice(1) ?? []),
    ],
    exports: values.exportFormats.map((format) => ({
      format,
      options: format === "huggingface" ? { outputPath: values.outputPath } : undefined,
    })),
    // 원본 메타데이터를 먼저 펼쳐 폼이 다루지 않는 키를 유지하고, outputPath만 덮어쓴다.
    metadata: { ...base?.metadata, outputPath: values.outputPath },
  };

  // 폼이 편집하지 않는 영역(base의 sources[1+], 원본 metadata)에 redaction marker가 남아
  // 있으면 여기서 fail-closed — sources[0] sourceParams 검사만으로는 놓치는 경로다.
  if (jsonValueHasRedactedSecret(candidate)) {
    return { error: i18n.t("newBuild.errors.specSecretRemoved") };
  }

  const result = buildSpecSchema.safeParse(candidate);
  if (!result.success) {
    return { error: result.error.issues[0]?.message ?? i18n.t("newBuild.errors.specInvalid") };
  }
  return { spec: result.data };
}

/**
 * BuildSpec을 BuildFormValues로 변환한다.
 *
 * @param spec - BuildSpec 객체.
 * @returns BuildFormValues.
 */
function toFormValues(spec: BuildSpec): BuildFormValues {
  const firstSource = spec.sources[0] ?? { provider: "", dataset: "", params: {} };
  return {
    datasetId: spec.datasetId,
    title: spec.title,
    description: spec.description,
    // New Build Wizard는 kind="public_api" source만 편집한다(file/url은 #250 Add Data
    // Workbench 전용) — provider/dataset이 없는 소스를 불러오면 빈 문자열로 대체한다.
    provider: firstSource.provider ?? "",
    sourceDataset: firstSource.dataset ?? "",
    sourceParams: Object.keys(firstSource.params).length > 0
      ? JSON.stringify(firstSource.params, null, 2)
      : "{}",
    exportFormats: spec.exports.map((e) => e.format),
    outputPath: typeof spec.metadata.outputPath === "string" ? spec.metadata.outputPath : "",
  };
}

/**
 * localStorage 초안 저장 경계 정책(S07): sourceParams JSON에 credential-like 값이 들어와도
 * 평문으로 남지 않도록 redact한다. 저장 직전(saveCurrentDraft)과 복원 직후(restoreDraft의
 * read-time rewrite) 양쪽에서 같은 함수를 써 초안 저장본이 항상 이 불변식을 만족하게 한다.
 * Add Data draft(`saveAddDataDraft`)와 동일한 `paramsRedaction` 헬퍼·sentinel을 재사용한다.
 */
function redactDraftForStorage(values: BuildFormValues): BuildFormValues {
  return { ...values, sourceParams: redactSourceParamsText(values.sourceParams).text };
}

interface PreviewState {
  status: "idle" | "loading" | "loaded" | "error";
  rows: Record<string, unknown>[];
  schema: Record<string, string>;
  warnings: string[];
  error?: string;
}

interface ValidationState {
  status: "idle" | "validating" | "validated";
  isValid: boolean;
  errors: string[];
}

type CatalogState =
  | { readonly status: "loading"; readonly providers: readonly CatalogProvider[]; readonly error?: undefined }
  | { readonly status: "loaded"; readonly providers: readonly CatalogProvider[]; readonly error?: undefined }
  | { readonly status: "error"; readonly providers: readonly CatalogProvider[]; readonly error: string };

function catalogProvider(providers: readonly CatalogProvider[], provider: string): CatalogProvider | undefined {
  return providers.find((entry) => entry.name === provider);
}

function catalogDataset(
  providers: readonly CatalogProvider[],
  provider: string,
  dataset: string,
): CatalogDataset | undefined {
  return catalogProvider(providers, provider)?.datasets.find((entry) => entry.name === dataset);
}

function isTemplateAvailable(template: BuildTemplate, catalog: CatalogState): boolean {
  if (!template.values.provider || !template.values.sourceDataset || catalog.status !== "loaded") return true;
  return catalogDataset(catalog.providers, template.values.provider, template.values.sourceDataset) !== undefined;
}

/** 템플릿 선택 버튼 — 사용 가능/준비 중 두 그리드가 이 렌더링 하나를 공유한다(#Phase2 UI polish). */
function TemplateButton({ template, catalog, onSelect }: { template: BuildTemplate; catalog: CatalogState; onSelect: (template: BuildTemplate) => void }) {
  const available = isTemplateAvailable(template, catalog);
  const resolvedDataset = catalogDataset(catalog.providers, template.values.provider, template.values.sourceDataset);
  return (
    <button
      type="button"
      disabled={!available}
      onClick={() => onSelect(template)}
      className="rounded-2xl border border-border bg-card p-4 text-left transition enabled:hover:border-accent/50 enabled:hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p className="text-base font-semibold tracking-tight">{template.name}</p>
      <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>
      {template.values.provider && template.values.sourceDataset ? (
        <p className="mt-3 text-xs font-medium text-muted-foreground">
          {resolvedDataset
            ? `${providerLabel(template.values.provider)} / ${resolvedDataset.title}`
            : i18n.t("newBuild.errors.unknownSource")}
        </p>
      ) : null}
    </button>
  );
}

/**
 * 단계별 New Build Wizard 페이지 컴포넌트.
 *
 * @returns 마법사 UI.
 */
export function NewBuildPage() {
  const { t } = useTranslation();
  const steps = buildSteps(t);
  // /builds/:buildId/edit 로 진입한 경우(편집 모드). buildId가 있으면 기존 스펙을 로드한다.
  const { buildId } = useParams();
  const [searchParams] = useSearchParams();
  const { build, isLoading: buildLoading } = useBuild(buildId || "");
  const isEditMode = !!buildId && build !== null;

  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle", rows: [], schema: {}, warnings: [] });
  const [validation, setValidation] = useState<ValidationState>({
    status: "idle",
    isValid: false,
    errors: [],
  });
  // 편집 중인 원본 스펙. 폼이 표현하지 못하는 소스/메타데이터를 보존하는 기준이 된다.
  const [baseSpec, setBaseSpec] = useState<BuildSpec | null>(null);
  // 저장된 초안이 있으면 복원 배너를 보여준다 (#10). 마운트 시 한 번만 확인한다.
  // 편집 모드에서는 초안을 복원하면 불러온 스펙을 덮어써 버리므로 배너를 띄우지 않는다.
  const [draftAvailable, setDraftAvailable] = useState(() => !buildId && hasDraft());
  const [draftSaved, setDraftSaved] = useState(false);
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading", providers: [] });
  // Workspace(#260)에서 "?savedSpecId=" 로 열었을 때 어떤 Saved BuildSpec을 불러왔는지.
  // 열었다고 곧바로 원본을 덮어쓰지 않는다 — 아래 "이 스펙 저장"을 눌러야만 반영된다.
  const [openedSavedSpecName, setOpenedSavedSpecName] = useState<string | null>(null);
  const [saveSpecMessage, setSaveSpecMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const job = useBuildJob();

  const {
    formState: { errors, isDirty },
    register,
    trigger,
    watch,
    getValues,
    reset,
    setValue,
  } = useForm<BuildFormValues>({ defaultValues: initialValues, mode: "onChange" });

  const values = watch();
  const specPreview = useMemo(() => toBuildSpec(values, baseSpec), [values, baseSpec]);
  const selectedProvider = values.provider;
  const providerOptions = catalog.providers.map((provider) => ({
    value: provider.name,
    label: providerLabel(provider.name),
  }));
  const datasetOptions = catalogProvider(catalog.providers, selectedProvider)?.datasets ?? [];

  // 마지막으로 검증한 폼 입력의 스냅샷. 검증 이후 입력이 바뀌면 검증 결과를 초기화하기 위해
  // 비교 기준으로 사용한다(stale validation 방지, #72).
  const validatedSnapshotRef = useRef<string | null>(null);

  // 검증을 통과/완료한 뒤 watch된 폼 값이 바뀌면, 검증되지 않은(수정된) 스펙이 그대로
  // 실행되지 않도록 검증 상태를 idle/invalid로 되돌린다(#72).
  useEffect(() => {
    if (validation.status === "idle") return;
    const current = JSON.stringify(values);
    if (validatedSnapshotRef.current === null) {
      validatedSnapshotRef.current = current;
      return;
    }
    if (current !== validatedSnapshotRef.current) {
      validatedSnapshotRef.current = null;
      setValidation({ status: "idle", isValid: false, errors: [] });
    }
  }, [values, validation.status]);

  useEffect(() => {
    const controller = new AbortController();
    builderApi.catalog(controller.signal)
      .then((response) => {
        setCatalog({ status: "loaded", providers: response.providers });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setCatalog({
          status: "error",
          providers: [],
          error: cause instanceof Error ? cause.message : i18n.t("newBuild.errors.catalogFail"),
        });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (catalog.status !== "loaded" || selectedProvider === "") return;
    const datasets = catalogProvider(catalog.providers, selectedProvider)?.datasets ?? [];
    if (datasets.length === 0) return;
    if (datasets.some((dataset) => dataset.name === values.sourceDataset)) return;
    setValue("sourceDataset", datasets[0].name, { shouldDirty: true, shouldValidate: true });
  }, [catalog, selectedProvider, setValue, values.sourceDataset]);

  // 편집 모드에서 build가 로드되면 폼을 초기화한다.
  //
  // 템플릿 선택(selectTemplate)과 동일하게, 폼을 갈아끼울 때는 이전 스펙 기준으로 만든
  // 미리보기/검증 결과가 남지 않도록 함께 초기화한다(stale 상태 방지, #72).
  useEffect(() => {
    if (!isEditMode || !build || buildLoading) return;
    setBaseSpec(build.spec);
    reset(toFormValues(build.spec));
    setPreview({ status: "idle", rows: [], schema: {}, warnings: [] });
    setValidation({ status: "idle", isValid: false, errors: [] });
    validatedSnapshotRef.current = null;
    setStep(1); // 템플릿 단계를 건너뛰고 기본 정보부터 시작
  }, [isEditMode, build, buildLoading, reset]);

  // Workspace(#260)에서 "Saved BuildSpec 열기"로 진입한 경우(`?savedSpecId=`). 마운트 시
  // 한 번만 반영한다 — 열자마자 원본을 덮어쓰지 않고 폼만 채운다(#260 review §3).
  const savedSpecPrefillApplied = useRef(false);
  useEffect(() => {
    if (savedSpecPrefillApplied.current || buildId) return;
    const savedSpecId = searchParams.get("savedSpecId");
    if (!savedSpecId) return;
    savedSpecPrefillApplied.current = true;
    const entry = getSavedSpec(savedSpecId);
    if (!entry) return;
    setBaseSpec(entry.spec);
    reset(toFormValues(entry.spec));
    setPreview({ status: "idle", rows: [], schema: {}, warnings: [] });
    setValidation({ status: "idle", isValid: false, errors: [] });
    validatedSnapshotRef.current = null;
    setOpenedSavedSpecName(entry.name);
    setStep(1);
  }, [buildId, searchParams, reset]);

  const draftStatus = validation.isValid ? "validated" : isDirty ? "dirty" : "new";

  // 템플릿을 선택하면 폼을 해당 값으로 채우고 기본 정보 단계로 넘어간다 (#11).
  // 이전 템플릿에서 로드된 미리보기/검증 결과가 남지 않도록 함께 초기화한다.
  function selectTemplate(template: BuildTemplate) {
    reset(template.values);
    // 템플릿으로 새로 시작하므로 편집 중이던 원본 스펙의 잔여 소스/메타데이터를 버린다.
    setBaseSpec(null);
    setPreview({ status: "idle", rows: [], schema: {}, warnings: [] });
    setValidation({ status: "idle", isValid: false, errors: [] });
    validatedSnapshotRef.current = null;
    setStep(1);
  }

  // 현재 입력을 localStorage 초안으로 저장한다 (#10).
  // 방금 저장한 값을 기준으로 reset 하여 dirty 상태를 정리하고, 같은 세션에서 복원 배너가
  // 뜨지 않도록 draftAvailable은 건드리지 않는다(배너는 새 마운트 시 복원용).
  function saveCurrentDraft() {
    const current = getValues();
    // persistence boundary(S07): credential-like 값이 localStorage 초안에 평문으로 남지
    // 않도록 저장 직전에 redact한다. 화면의 in-memory 폼 상태(current)는 그대로 두므로
    // 진행 중인 Preview/Build는 영향이 없다.
    saveDraft(redactDraftForStorage(current));
    reset(current);
    setDraftSaved(true);
  }

  // 저장된 초안을 복원해 기본 정보 단계로 이동한다.
  function restoreDraft() {
    // 저장된 초안을 버전·스키마로 검증해 복원한다. 버전 불일치/손상 시 null을 받는다(#84).
    // 과거 버전이 평문 secret을 저장해 둔 초안이면 복원 시점에 redact본으로 다시 저장되고
    // (loadDraft의 sanitize rewrite), 반환값도 redact된 상태다 — 아래 toBuildSpec 가드가
    // marker를 감지해 재입력을 요구한다.
    const saved = loadDraft<BuildFormValues>(buildFormValuesSchema, undefined, redactDraftForStorage);
    if (!saved) {
      // 깨진 값이 남아 배너가 반복되지 않도록 정리하고, 이동/숨김은 하지 않는다.
      clearDraft();
      setDraftAvailable(false);
      return;
    }
    reset(saved);
    setDraftAvailable(false);
    setStep(1);
  }

  // 저장된 초안을 삭제하고 배너를 숨긴다.
  function discardDraft() {
    clearDraft();
    setDraftAvailable(false);
  }

  async function goNext() {
    const fields = STEP_FIELDS[step];
    const ok = fields.length === 0 ? true : await trigger(fields);
    if (!ok) return;
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  function goBack() {
    setStep((current) => Math.max(current - 1, 0));
  }

  async function runPreview() {
    const next = toBuildSpec(getValues(), baseSpec);
    if (next.error || !next.spec) {
      setPreview({ status: "error", rows: [], schema: {}, warnings: [], error: next.error });
      return;
    }
    setPreview({ status: "loading", rows: [], schema: {}, warnings: [] });
    try {
      const result = await previewBuild(next.spec);
      setPreview({
        status: "loaded",
        rows: result.rows,
        schema: result.schema,
        warnings: result.warnings.map((warning) => `${warning.sourceKey}: ${warning.error}`),
      });
    } catch (cause) {
      setPreview({
        status: "error",
        rows: [],
        schema: {},
        warnings: [],
        error: cause instanceof Error ? cause.message : i18n.t("newBuild.errors.previewFail"),
      });
    }
  }

  async function runValidate() {
    // 검증 대상 입력의 스냅샷을 기록한다. 이후 폼이 바뀌면 effect가 이를 감지해 검증 상태를
    // 초기화한다(#72).
    validatedSnapshotRef.current = JSON.stringify(getValues());
    const next = toBuildSpec(getValues(), baseSpec);
    if (next.error || !next.spec) {
      setValidation({ status: "validated", isValid: false, errors: [next.error ?? i18n.t("newBuild.errors.specError")] });
      return;
    }
    setValidation({ status: "validating", isValid: false, errors: [] });
    try {
      const result = await validateSpec(next.spec);
      setValidation({ status: "validated", isValid: result.valid, errors: result.errors });
    } catch (cause) {
      // 네트워크/5xx/파싱 실패를 화면에서 확인할 수 있게 오류로 반영한다(미처리 rejection 방지).
      setValidation({
        status: "validated",
        isValid: false,
        errors: [cause instanceof Error ? cause.message : i18n.t("newBuild.errors.validateFail")],
      });
    }
  }

  // 현재 스펙을 Workspace(#260)의 Saved BuildSpec으로 저장한다. 저장 시점의 검증 상태를
  // 그대로 함께 기록한다 — 검증 안 한 스펙을 "통과"로 보여주지 않기 위함이다.
  function saveAsSavedSpec() {
    if (!specPreview.spec) return;
    const name = window.prompt(i18n.t("newBuild.review.savePrompt"), specPreview.spec.title || i18n.t("newBuild.review.unnamed"));
    if (!name) return;

    const validationSummary: SavedSpecValidation =
      validation.status === "validated"
        ? { status: validation.isValid ? "validated_pass" : "validated_fail", errors: validation.errors }
        : { status: "not_validated", errors: [] };

    const { result } = createSavedSpec({ name, spec: specPreview.spec, validation: validationSummary });
    setSaveSpecMessage(
      result.ok
        ? { type: "success", text: i18n.t("newBuild.review.savedAs", { name }) }
        : { type: "error", text: result.reason },
    );
  }

  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow={isEditMode ? t("newBuild.page.eyebrowEdit") : t("newBuild.page.eyebrowNew")}
        title={isEditMode ? t("newBuild.page.titleEdit", { title: baseSpec?.title || buildId }) : t("newBuild.page.titleNew")}
        description={
          isEditMode
            ? t("newBuild.page.descEdit")
            : t("newBuild.page.descNew")
        }
        actions={<StatusBadge status={draftStatus} />}
      />

      {buildId && buildLoading ? (
        <Card variant="dashed" className="p-4">
          <p className="text-sm text-muted-foreground">{t("newBuild.page.loadingSpec")}</p>
        </Card>
      ) : null}

      {buildId && !buildLoading && !isEditMode ? (
        <Card variant="dashed" className="p-4">
          <p className="text-sm text-foreground">
            {t("newBuild.page.specNotFound", { id: buildId })}
          </p>
        </Card>
      ) : null}

      {isEditMode ? (
        <Card variant="dashed" className="p-4">
          <p className="text-sm text-foreground">
            {t("newBuild.page.specEditing", { id: buildId })}
          </p>
        </Card>
      ) : null}

      {openedSavedSpecName ? (
        <Card variant="dashed" className="p-4">
          <p className="text-sm text-foreground">
            {t("newBuild.page.savedSpecLoaded", { name: openedSavedSpecName })}
          </p>
        </Card>
      ) : null}

      {draftAvailable ? (
        <Card variant="dashed" className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-foreground">
            {t("newBuild.page.draftExists")}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={restoreDraft}>
              {t("newBuild.page.load")}
            </Button>
            <Button size="sm" variant="ghost" onClick={discardDraft}>
              {t("newBuild.page.delete")}
            </Button>
          </div>
        </Card>
      ) : null}

      <Card>
        <Stepper steps={steps} current={step} onStepClick={setStep} />
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(20rem,0.8fr)]">
        <Card>
          {step === 0 ? (
            <div className="space-y-4">
              <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.template.selectTitle")}</h3>
              <p className="text-sm text-muted-foreground">
                {t("newBuild.template.selectDesc")}
              </p>
              {catalog.status === "loading" ? (
                <p className="text-sm text-muted-foreground">{t("newBuild.template.catalogLoading")}</p>
              ) : null}
              {catalog.status === "error" ? (
                <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                  {t("newBuild.template.catalogError", { error: catalog.error })}
                </p>
              ) : null}
              {catalog.status === "loaded" ? (
                (() => {
                  const available = TEMPLATES.filter((template) => isTemplateAvailable(template, catalog));
                  const unavailable = TEMPLATES.filter((template) => !isTemplateAvailable(template, catalog));
                  return (
                    <>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {available.map((template) => (
                          <TemplateButton key={template.id} template={template} catalog={catalog} onSelect={selectTemplate} />
                        ))}
                      </div>
                      {unavailable.length > 0 ? (
                        <div className="rounded-2xl border border-dashed border-border p-4">
                          <p className="text-sm font-medium text-muted-foreground">
                            {t("newBuild.templates.unavailableCount", { count: unavailable.length })}
                          </p>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            {unavailable.map((template) => (
                              <TemplateButton key={template.id} template={template} catalog={catalog} onSelect={selectTemplate} />
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  );
                })()
              ) : (
                // catalog가 아직 loading/error인 동안은 가용성을 판정할 수 없으므로(isTemplateAvailable도
                // 이 경우 항상 true를 반환) 원본 grid를 그대로 보여준다 — "대부분 disabled"처럼
                // 보이는 깜빡임을 만들지 않는다.
                <div className="grid gap-3 sm:grid-cols-2">
                  {TEMPLATES.map((template) => (
                    <TemplateButton key={template.id} template={template} catalog={catalog} onSelect={selectTemplate} />
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-4">
              <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.identity.title")}</h3>
              <FormField
                id="datasetId"
                label={t("newBuild.identity.datasetIdLabel")}
                required
                help={t("newBuild.identity.datasetIdHelp")}
                error={errors.datasetId?.message}
              >
                {(field) => (
                  <TextInput
                    placeholder="kma-daily-observations"
                    {...field}
                    {...register("datasetId", { required: i18n.t("newBuild.errors.datasetIdRequired") })}
                  />
                )}
              </FormField>
              <FormField id="title" label={t("newBuild.identity.titleLabel")} required error={errors.title?.message}>
                {(field) => (
                  <TextInput
                    placeholder={t("newBuild.identity.titlePlaceholder")}
                    {...field}
                    {...register("title", { required: i18n.t("newBuild.errors.titleRequired") })}
                  />
                )}
              </FormField>
              <FormField
                id="description"
                label={t("newBuild.identity.descLabel")}
                required
                help={t("newBuild.identity.descHelp")}
                error={errors.description?.message}
              >
                {(field) => (
                  <Textarea
                    {...field}
                    {...register("description", { required: i18n.t("newBuild.errors.descriptionRequired") })}
                  />
                )}
              </FormField>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.source.title")}</h3>
              <FormField id="provider" label={t("newBuild.source.providerLabel")} required error={errors.provider?.message}>
                {(field) => (
                  <Select {...field} {...register("provider", { required: i18n.t("newBuild.errors.providerRequired") })}>
                    <option value="">{t("newBuild.source.providerSelect")}</option>
                    {providerOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              <FormField
                id="sourceDataset"
                label={t("newBuild.source.datasetLabel")}
                required
                help={t("newBuild.source.datasetHelp")}
                error={errors.sourceDataset?.message}
              >
                {(field) => (
                  <Select
                    {...field}
                    disabled={!selectedProvider || datasetOptions.length === 0}
                    {...register("sourceDataset", { required: i18n.t("newBuild.errors.datasetRequired") })}
                  >
                    <option value="">{t("newBuild.source.datasetSelect")}</option>
                    {datasetOptions.map((dataset) => (
                      <option key={dataset.name} value={dataset.name}>
                        {dataset.title} ({dataset.name})
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              {catalog.status === "loading" ? (
                <p className="text-sm text-muted-foreground">{t("newBuild.template.catalogLoading")}</p>
              ) : null}
              {catalog.status === "error" ? (
                <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                  {catalog.error}
                </p>
              ) : null}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-4">
              <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.params.title")}</h3>
              <FormField
                id="sourceParams"
                label={t("newBuild.params.label")}
                help={t("newBuild.params.help")}
                error={errors.sourceParams?.message}
              >
                {(field) => (
                  <Textarea
                    mono
                    rows={8}
                    {...field}
                    {...register("sourceParams", {
                      required: i18n.t("newBuild.errors.paramsRequired"),
                      // JSON 문법/객체 여부를 단계 이동(trigger) 시점에 바로 막고 필드에 표시한다.
                      validate: (value) => parseSourceParams(value).error ?? true,
                    })}
                  />
                )}
              </FormField>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.preview.title")}</h3>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={preview.status === "loading"}
                  onClick={() => void runPreview()}
                >
                  {t("newBuild.preview.refresh")}
                </Button>
              </div>
              {preview.status === "idle" ? (
                <EmptyState
                  title={t("newBuild.preview.guideTitle")}
                  description={t("newBuild.preview.guideDesc")}
                />
              ) : null}
              {preview.status === "error" ? (
                <EmptyState
                  title={t("newBuild.preview.failTitle")}
                  description={preview.error ?? t("newBuild.preview.failDesc")}
                />
              ) : null}
              {preview.status === "loaded" && preview.rows.length === 0 ? (
                <EmptyState
                  title={t("newBuild.preview.emptyTitle")}
                  description={t("newBuild.preview.emptyDesc")}
                />
              ) : null}
              {preview.status === "loaded" && preview.warnings.length > 0 ? (
                <ul className="space-y-2">
                  {preview.warnings.map((warning) => (
                    <li
                      key={warning}
                      role="alert"
                      className="rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
                    >
                      {warning}
                    </li>
                  ))}
                </ul>
              ) : null}
              {preview.status === "loaded" && preview.rows.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("newBuild.preview.rowsCols", { rows: preview.rows.length, cols: Object.keys(preview.schema).length })}
                </p>
              ) : null}
            </div>
          ) : null}

          {step === 5 ? (
            <div className="space-y-4">
              <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.output.title")}</h3>
              <fieldset>
                <legend className="text-sm font-medium text-foreground">
                  {t("newBuild.output.formatsLabel")}
                </legend>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {exportFormats.map((format) => (
                    <label
                      key={format}
                      className="flex items-center gap-3 rounded-xl border border-border bg-muted px-4 py-3"
                    >
                      <input
                        type="checkbox"
                        value={format}
                        className="h-4 w-4 accent-emerald-600"
                        {...register("exportFormats", {
                          validate: (selected) =>
                            (selected?.length ?? 0) > 0 || i18n.t("newBuild.errors.outputRequired"),
                        })}
                      />
                      <span className="text-sm font-medium capitalize">{format}</span>
                    </label>
                  ))}
                </div>
                {errors.exportFormats ? (
                  <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
                    {errors.exportFormats.message}
                  </p>
                ) : null}
              </fieldset>
              <FormField
                id="outputPath"
                label={t("newBuild.output.pathLabel")}
                required
                error={errors.outputPath?.message}
              >
                {(field) => (
                  <TextInput
                    placeholder="artifacts/builds/air-quality"
                    {...field}
                    {...register("outputPath", { required: i18n.t("newBuild.errors.outputPathRequired") })}
                  />
                )}
              </FormField>
            </div>
          ) : null}

          {step === 6 ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-semibold tracking-tight">{t("newBuild.review.title")}</h3>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={validation.status === "validating"}
                  onClick={() => void runValidate()}
                >
                  {t("newBuild.review.revalidate")}
                </Button>
              </div>
              {validation.status === "idle" ? (
                <p className="text-sm text-muted-foreground">
                  {t("newBuild.review.guide")}
                </p>
              ) : null}
              {validation.status === "validated" && validation.isValid ? (
                <Card variant="success" className="p-4">
                  <p className="text-sm font-medium text-accent-subtle-foreground">
                    {t("newBuild.review.passed")}
                  </p>
                </Card>
              ) : null}
              {validation.errors.length > 0 ? (
                <ul className="space-y-2">
                  {validation.errors.map((error) => (
                    <li
                      key={error}
                      role="alert"
                      className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-200"
                    >
                      {error}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  disabled={!validation.isValid || job.status === "running" || !specPreview.spec}
                  loading={job.status === "running"}
                  onClick={() => {
                    if (specPreview.spec) void job.start(specPreview.spec);
                  }}
                >
                  {t("newBuild.review.run")}
                </Button>
                {job.status === "running" ? (
                  <Button variant="secondary" onClick={job.cancel}>
                    {t("newBuild.review.cancel")}
                  </Button>
                ) : null}
                {job.status === "succeeded" ? (
                  <span className="text-sm text-accent-subtle-foreground">
                    {t("newBuild.review.success", { id: job.run?.id })}
                  </span>
                ) : null}
                {job.status === "failed" ? (
                  <span role="alert" className="text-sm text-red-700 dark:text-red-300">
                    {job.error}
                  </span>
                ) : null}
                {job.status === "cancelled" ? (
                  <span className="text-sm text-muted-foreground">{t("newBuild.review.cancelled")}</span>
                ) : null}
                {job.interrupted && job.status !== "cancelled" ? (
                  <span className="text-sm text-muted-foreground">
                    {t("newBuild.review.aborted")}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button variant="secondary" disabled={!specPreview.spec} onClick={saveAsSavedSpec}>
                  {t("newBuild.review.saveSpec")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t("newBuild.review.saveSpecDesc")}
                </span>
              </div>
              {saveSpecMessage ? (
                <p
                  role={saveSpecMessage.type === "error" ? "alert" : undefined}
                  className={`text-sm ${saveSpecMessage.type === "error" ? "text-red-700 dark:text-red-300" : "text-accent-subtle-foreground"}`}
                >
                  {saveSpecMessage.text}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* 모바일에서는 하단 sticky action bar로 고정해 긴 폼에서도 이전/다음이 항상 보이게 한다(§13). */}
          <div className="sticky bottom-0 z-10 -mx-6 -mb-6 mt-8 flex items-center justify-between gap-3 border-t border-border bg-background/95 px-6 py-3 backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none sm:dark:bg-transparent">
            <Button variant="ghost" onClick={goBack} disabled={step === 0}>
              {t("newBuild.nav.prev")}
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={saveCurrentDraft}>
                {draftSaved && !isDirty ? t("newBuild.nav.saved") : t("newBuild.nav.saveDraft")}
              </Button>
              {step < steps.length - 1 ? (
                <Button onClick={() => void goNext()}>{t("newBuild.nav.next")}</Button>
              ) : null}
            </div>
          </div>
        </Card>

        <aside className="space-y-5">
          <Card>
            {/* 모바일에서 공간을 아끼도록 기본 접힘(details). 데스크톱(xl)에서는 별도 컬럼에
                표시되며 필요 시 펼친다(§13). */}
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("newBuild.nav.specTitle")}
                <span className="text-base transition group-open:rotate-180" aria-hidden="true">
                  ⌄
                </span>
              </summary>
              <pre className="mt-4 overflow-x-auto rounded-xl bg-zinc-950 p-4 text-xs leading-6 text-zinc-100">
                <code>{JSON.stringify(specPreview.spec ?? values, null, 2)}</code>
              </pre>
            </details>
          </Card>
        </aside>
      </div>
    </main>
  );
}
