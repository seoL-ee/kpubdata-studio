import type { BuildQualityResponse, PreviewSource, QualityCheckResult, SchemaDriftFinding } from "@/shared/lib/builderApi";
import { i18n } from "@/shared/i18n";

export type ValidationStatus = "PASS" | "WARN" | "FAIL" | "N/A";

/** Builder quality 결과를 점수 없이 PASS/WARN/FAIL/N/A로만 집계한다. */
export function summarizeQuality(
  quality: BuildQualityResponse | null | undefined,
  sourceKey?: string,
): ValidationStatus {
  if (!quality) return "N/A";
  const groups = sourceKey
    ? [quality.quality_results[sourceKey] ?? []]
    : Object.values(quality.quality_results);
  const results = groups.flat();
  if (results.length === 0) return "N/A";
  if (results.some((result) => result.status === "fail")) return "FAIL";
  if (results.some((result) => result.status === "warn")) return "WARN";
  return "PASS";
}

/** 선택 source의 실제 quality 결과만 반환한다. */
export function qualityResultsForSource(
  quality: BuildQualityResponse | null | undefined,
  sourceKey: string,
): QualityCheckResult[] {
  return quality?.quality_results[sourceKey] ?? [];
}

/**
 * Quality Center(#254)용 확장.
 *
 * 위 두 함수(#253)는 dataset detail의 단일 source 스코프 표시에 쓰이므로 그대로 둔다.
 * Quality Center는 여러 source를 가로지르는 집계, availability, evaluated_checks=0(N/A)을
 * 구분해서 보여줘야 해서 별도 함수로 확장한다.
 */

/** run 전체(availability 포함)와 개별 결과 집계를 함께 표현하는 대표 상태.
 * Builder #486 semantics 보존: NOT_EVALUATED(평가된 check 없음)와 UNAVAILABLE(availability=unavailable)을
 * PASS/N/A로 뭉개지 않고 구분한다. */
export type QualityState = "FAIL" | "WARN" | "PASS" | "NOT_EVALUATED" | "UNAVAILABLE";

const PERCENTAGE_QUALITY_RULES = new Set(["max_null_ratio", "max_duplicate_rate"]);
const ROW_COUNT_QUALITY_RULES = new Set(["min_rows"]);

/**
 * Builder canonical rule에 대해서만 단위를 붙인다.
 * 구조화된 threshold와 알 수 없는 rule은 의미를 추측하지 않고 원래 JSON 표현을 보존한다.
 */
export function formatQualityValue(rule: string, value: unknown): string {
  if (value === null || value === undefined) return "N/A";
  if (typeof value === "number") {
    if (PERCENTAGE_QUALITY_RULES.has(rule) && value >= 0 && value <= 1) {
      return `${(value * 100).toFixed(1)}%`;
    }
    const formatted = value.toLocaleString(
      i18n.language?.startsWith("en") ? "en-US" : "ko-KR",
    );
    return ROW_COUNT_QUALITY_RULES.has(rule)
      ? i18n.t("quality.model.rows", { count: formatted })
      : formatted;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function worstResultStatus(results: QualityCheckResult[]): "fail" | "warn" | "pass" | null {
  if (results.some((result) => result.status === "fail")) return "fail";
  if (results.some((result) => result.status === "warn")) return "warn";
  if (results.length > 0) return "pass";
  return null;
}

/** quality_results를 (선택적으로 source_key로 스코프해) 하나의 배열로 펼친다. */
export function flattenQualityResults(
  quality: BuildQualityResponse | null | undefined,
  sourceKey?: string,
): QualityCheckResult[] {
  if (!quality) return [];
  const groups = sourceKey ? [quality.quality_results[sourceKey] ?? []] : Object.values(quality.quality_results);
  return groups.flat();
}

/** schema_drift를 (선택적으로 source_key로 스코프해) 하나의 배열로 펼친다. */
export function flattenSchemaDrift(
  quality: BuildQualityResponse | null | undefined,
  sourceKey?: string,
): SchemaDriftFinding[] {
  if (!quality) return [];
  const groups = sourceKey ? [quality.schema_drift[sourceKey] ?? []] : Object.values(quality.schema_drift);
  return groups.flat();
}

/**
 * 평가 결과의 대표 severity를 먼저 정한다(FAIL > WARN > PASS > NOT_EVALUATED).
 * availability는 별도 축이며, quality 응답 자체가 없을 때만 UNAVAILABLE을 대표 상태로 사용한다.
 */
export function overallQualityState(
  quality: BuildQualityResponse | null | undefined,
  sourceKey?: string,
): QualityState {
  if (!quality) return "UNAVAILABLE";
  const worst = worstResultStatus(flattenQualityResults(quality, sourceKey));
  if (worst === "fail") return "FAIL";
  if (worst === "warn") return "WARN";
  if (worst === "pass") return "PASS";
  return "NOT_EVALUATED";
}

export interface ChecksPassedSummary {
  pass: number;
  warn: number;
  fail: number;
  /** 분모. 항상 실제 평가된 check 수이며, 0이면 status는 N/A다(가짜 PASS/0%로 표시하지 않음). */
  evaluated: number;
  status: ValidationStatus;
}

/** PASS/evaluated 형태의 요약. evaluated===0이면 status는 N/A. */
export function summarizeChecksPassed(results: QualityCheckResult[]): ChecksPassedSummary {
  const pass = results.filter((result) => result.status === "pass").length;
  const warn = results.filter((result) => result.status === "warn").length;
  const fail = results.filter((result) => result.status === "fail").length;
  const evaluated = results.length;
  const worst = worstResultStatus(results);
  const status: ValidationStatus = worst === "fail" ? "FAIL" : worst === "warn" ? "WARN" : worst === "pass" ? "PASS" : "N/A";
  return { pass, warn, fail, evaluated, status };
}

/**
 * Quality Center header의 "Kubi 분석" 버튼이 seed할 질문을 현재 Quality 상태에 맞춰 고른다.
 *
 * 이전에는 상태와 무관하게 "WARN/FAIL의 원인과 조치"를 고정 seed해서, 모든 check가 PASS인
 * Run에서도 존재하지 않는 WARN/FAIL을 전제한 질문이 들어갔다(real Builder E2E에서 확인).
 * per-issue "Kubi 분석" 버튼은 이미 이슈 문맥을 담으므로 이 함수는 header 버튼에만 쓴다.
 */
export function qualityKubiSeedQuestion(summary: ChecksPassedSummary): string {
  if (summary.evaluated === 0) {
    return i18n.t("quality.model.seed.none");
  }
  if (summary.warn > 0 || summary.fail > 0) {
    return i18n.t("quality.model.seed.issues");
  }
  return i18n.t("quality.model.seed.allPass");
}

export interface CategorySummary extends ChecksPassedSummary {
  /** 표시용으로 고른 가장 심각한 개별 결과(FAIL > WARN > 첫 PASS). 평가된 결과가 없으면 null. */
  worst: QualityCheckResult | null;
}

/** category 매처에 해당하는 결과만 골라 요약한다. Builder category는 자유 문자열이라 정확한 값 목록을 가정하지 않는다. */
export function summarizeByCategory(
  results: QualityCheckResult[],
  matches: (category: string) => boolean,
): CategorySummary {
  const filtered = results.filter((result) => matches(result.category));
  const base = summarizeChecksPassed(filtered);
  const worst =
    filtered.find((result) => result.status === "fail") ??
    filtered.find((result) => result.status === "warn") ??
    filtered[0] ??
    null;
  return { ...base, worst };
}

export const isMissingCategory = (category: string): boolean => /missing|null/i.test(category);
export const isDuplicateCategory = (category: string): boolean => /duplicate/i.test(category);
export const isSchemaCategory = (category: string): boolean => /schema/i.test(category);
/** category === "range"(Builder rule 목록: min_rows/range/compare_columns 등, #497). */
export const isRangeCategory = (category: string): boolean => /range/i.test(category);
/**
 * rule === "dtype"(Add Data Preview & Validation의 "Type" 버킷, #250). Builder는 별도
 * "type" category를 두지 않고 schema category 안의 dtype rule로 표현하므로, category가
 * 아닌 rule 이름으로 매칭한다.
 */
export const isTypeRule = (rule: string): boolean => rule === "dtype";

/** 결과를 최초 등장 순서를 유지한 채 실제 category 값별로 묶는다(고정 목록을 가정하지 않음). */
export function groupByCategory(results: QualityCheckResult[]): { category: string; results: QualityCheckResult[] }[] {
  const order: string[] = [];
  const groups = new Map<string, QualityCheckResult[]>();
  for (const result of results) {
    if (!groups.has(result.category)) {
      groups.set(result.category, []);
      order.push(result.category);
    }
    groups.get(result.category)!.push(result);
  }
  return order.map((category) => ({ category, results: groups.get(category)! }));
}

/** WARN/FAIL 결과만 "Recent quality issues"용으로 남긴다. */
export function warnOrFailResults(results: QualityCheckResult[]): QualityCheckResult[] {
  return results.filter((result) => result.status !== "pass");
}

/**
 * PreviewResponse.previews[]가 여러 source를 반환할 때(#250 §3), 각 source를
 * Studio가 임의로 하나의 PASS/FAIL로 뭉개지 않고 그대로 구분해 보여주기 위한 상태.
 *
 * Builder가 준 값 그대로를 분류만 한다 — 어떤 status도 새로 지어내지 않는다.
 *   - "failed": source.status === "failed" (fetch/조회 실패)
 *   - "zero_rows": 정상 응답이지만 total_rows === 0 (0-row는 fetch 실패와 다르다)
 *   - "not_evaluated": 정상 응답이고 행도 있지만 quality_results가 비어 있음(N/A)
 *   - "ok": 위 셋에 해당하지 않는 정상 평가 결과
 */
export type PreviewSourceState = "ok" | "failed" | "zero_rows" | "not_evaluated";

export function previewSourceState(source: PreviewSource): PreviewSourceState {
  if (source.status === "failed") return "failed";
  if (source.total_rows === 0) return "zero_rows";
  if (source.quality_results.length === 0) return "not_evaluated";
  return "ok";
}

export interface PreviewSourceSummary {
  source: PreviewSource;
  state: PreviewSourceState;
  quality: ChecksPassedSummary;
}

export interface PreviewSourcesSummary {
  /** source가 2개 이상이고 상태(state)가 서로 다를 때만 true(#250 §3, "mixed"). */
  mixed: boolean;
  perSource: PreviewSourceSummary[];
}

/**
 * source별 상태/quality 요약과, 전체가 "mixed"(일부 성공 + 일부 실패/미평가)인지를 계산한다.
 * 여러 source의 quality_results를 합쳐 하나의 PASS로 추정하지 않는다 — source별 결과를
 * 그대로 나열할 뿐이다.
 */
export function summarizePreviewSources(previews: readonly PreviewSource[]): PreviewSourcesSummary {
  const perSource = previews.map((source) => ({
    source,
    state: previewSourceState(source),
    quality: summarizeChecksPassed(source.quality_results),
  }));
  const states = new Set(perSource.map((p) => p.state));
  return { mixed: previews.length > 1 && states.size > 1, perSource };
}

// NOTE(#350): 이 상수는 PR #360이 수정 중인 화면들이 인덱싱해서 쓰므로 그대로 둔다 —
// 함수로 바꾸면 그 PR과 충돌한다. 문구 자체는 `quality.model.previewState.*`에 이미
// 올려 뒀으니, #360 머지 후 사용처와 함께 한 번에 전환하면 된다.
/**
 * preview source 상태 라벨을 **호출 시점에** 해석한다.
 *
 * 모듈 최상위 상수로 두면 import 시점 언어에 라벨이 굳어, 언어를 바꿔도 이 탭만
 * 이전 언어로 남는다(#350). 표를 키로만 들고 렌더마다 번역한다.
 */
const _PREVIEW_SOURCE_STATE_KEY: Record<PreviewSourceState, string> = {
  ok: "quality.previewSourceState.ok",
  failed: "quality.previewSourceState.failed",
  zero_rows: "quality.previewSourceState.zeroRows",
  not_evaluated: "quality.previewSourceState.notEvaluated",
};

export function previewSourceStateLabel(state: PreviewSourceState): string {
  return i18n.t(_PREVIEW_SOURCE_STATE_KEY[state]);
}
