/**
 * New Build 마법사의 폼 ↔ BuildSpec 조립 로직 (#379로 NewBuildPage에서 분리).
 *
 * 화면 렌더와 분리해 두면 "무엇이 스펙이 되는가"를 JSX 를 읽지 않고 확인할 수 있고,
 * 단계 구성이 바뀌어도 조립 규칙은 한 곳에 남는다.
 */
import { parseSourceParams } from "@/features/build-spec/paramsInput";
import {
  jsonValueHasRedactedSecret,
  redactSourceParamsText,
  sourceParamsHasRedactedSecret,
} from "@/features/add-data/paramsRedaction";
import { i18n } from "@/shared/i18n";
import type { CatalogDataset, CatalogProvider } from "@/shared/lib/builderApi";
import { buildSpecSchema } from "@/shared/lib/schemas";
import type { BuildSpec } from "@/shared/lib/types";
import type { StepItem } from "@/shared/ui";

export interface BuildFormValues {
  datasetId: string;
  title: string;
  description: string;
  provider: string;
  sourceDataset: string;
  sourceParams: string;
  outputPath: string;
  exportFormats: string[];
}

export const initialValues: BuildFormValues = {
  datasetId: "",
  title: "",
  description: "",
  provider: "",
  sourceDataset: "",
  sourceParams: "{}",
  outputPath: "artifacts/builds/example",
  exportFormats: ["jsonl"],
};


export function buildSteps(t: (k: string) => string): StepItem[] {
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
export const STEP_FIELDS: Array<Array<keyof BuildFormValues>> = [
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
export function toBuildSpec(
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
export function toFormValues(spec: BuildSpec): BuildFormValues {
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
export function redactDraftForStorage(values: BuildFormValues): BuildFormValues {
  return { ...values, sourceParams: redactSourceParamsText(values.sourceParams).text };
}

export interface PreviewState {
  status: "idle" | "loading" | "loaded" | "error";
  rows: Record<string, unknown>[];
  schema: Record<string, string>;
  warnings: string[];
  error?: string;
}

export interface ValidationState {
  status: "idle" | "validating" | "validated";
  isValid: boolean;
  errors: string[];
}

export type CatalogState =
  | { readonly status: "loading"; readonly providers: readonly CatalogProvider[]; readonly error?: undefined }
  | { readonly status: "loaded"; readonly providers: readonly CatalogProvider[]; readonly error?: undefined }
  | { readonly status: "error"; readonly providers: readonly CatalogProvider[]; readonly error: string };

export function catalogProvider(providers: readonly CatalogProvider[], provider: string): CatalogProvider | undefined {
  return providers.find((entry) => entry.name === provider);
}

export function catalogDataset(
  providers: readonly CatalogProvider[],
  provider: string,
  dataset: string,
): CatalogDataset | undefined {
  return catalogProvider(providers, provider)?.datasets.find((entry) => entry.name === dataset);
}

