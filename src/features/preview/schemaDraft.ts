/**
 * 스키마 계약 초안 생성 (VAL-4, #227).
 *
 * /preview 응답의 컬럼 스키마에서 BuildSpec sources[].schema 초안을
 * 결정적으로 도출한다. LLM을 쓰지 않는다 — nullable/dtype/unique_count는
 * 전체 fetch된 테이블 기준으로 계산된 관측 사실이기 때문이다.
 *
 * 주의 — 단일 fetch의 한계:
 *   required 판정은 "이번에 조회한 파라미터 범위"에 대해서만 참이다. 다른
 *   날짜·지역을 조회하면 null이 나올 수 있다. 그래서 초안을 자동 확정하지
 *   말고 사용자 승인을 거쳐야 하며, UI는 warnings로 이 한계를 표시해야 한다.
 */
import { i18n } from "@/shared/i18n";
import type { PreviewColumn } from "@/shared/lib/builderApi.schema";
import type { SchemaContract } from "@/shared/lib/types";

/** 스키마 초안 도출 결과. */
export interface SchemaDraft {
  /** BuildSpec sources[].schema 로 직접 직렬화 가능한 계약. */
  contract: SchemaContract;
  /** unique_count == row_count 인 컬럼 (키 후보). 사용자 제안용. */
  keyCandidates: string[];
  /** 초안의 한계를 알리는 경고. UI가 사용자에게 표시해야 한다. */
  warnings: string[];
}

/**
 * /preview 컬럼 스키마에서 스키마 계약 초안을 도출한다.
 *
 * @param columns /preview 응답의 컬럼 목록 (name/dtype/nullable/unique_count).
 * @param rowCount 전체 fetch된 행 수 (preview_limit 과 무관).
 */
export function draftSchemaContract(
  columns: PreviewColumn[],
  rowCount: number,
): SchemaDraft {
  const required = columns.filter((c) => !c.nullable).map((c) => c.name);
  const dtypes: Record<string, string> = {};
  for (const c of columns) {
    dtypes[c.name] = c.dtype;
  }
  const keyCandidates = columns
    .filter((c) => rowCount > 0 && c.unique_count === rowCount)
    .map((c) => c.name);
  const warnings: string[] =
    rowCount === 0
      ? [i18n.t("preview.schemaDraft.zeroRows")]
      : [i18n.t("preview.schemaDraft.scopeNote")];
  return {
    contract: { required, dtypes, casts: {} },
    keyCandidates,
    warnings,
  };
}
