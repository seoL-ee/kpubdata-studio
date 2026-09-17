/**
 * Canonical BuildSpec GUI ↔ YAML 텍스트 변환 (#250, #251).
 *
 * `BuildSpecEditor`의 "YAML" 탭 전용 모듈이다 — Builder에 실제로 제출되는 wire
 * 페이로드는 이 모듈을 거치지 않는다(`specMapping.ts`의 `serializeSpec`이 유일한
 * 제출 정본이며, `toBuilderSpec`을 그대로 재사용한다). 이 모듈은 사람이 읽고 고치기
 * 좋은 YAML 문자열을 만들고(`toYamlText`) 그 문자열을 다시 Studio BuildSpec으로
 * 되돌리는(`fromYamlText`) 편집 편의만 담당한다.
 *
 * 오류 두 층을 구분한다:
 *  - **YAML syntax error**: `yaml` 파서 자체가 텍스트를 파싱하지 못한 경우.
 *  - **구조 오류(structural)**: 파싱은 됐지만 canonical BuildSpec 모양이 아닌 경우
 *    (필수 최상위 키 누락, sources/exports가 배열이 아님 등).
 * Builder `/validate`의 semantic 오류(예: provider가 존재하지 않음)는 이 모듈의 책임이
 * 아니다 — 그 둘을 여기서 미리 재현하거나 대체하지 않는다.
 */
import { i18n } from "@/shared/i18n";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { fromBuilderSpec, toBuilderSpec, type BuilderSpec } from "@/features/build-spec/specMapping";
import type { BuildSpec } from "@/shared/lib/types";

/** YAML 파서가 텍스트를 파싱하지 못했을 때(문법 오류). */
export class YamlSyntaxError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : i18n.t("buildSpec.yaml.parseFailed"));
    this.name = "YamlSyntaxError";
  }
}

/** 파싱은 됐지만 canonical BuildSpec 모양이 아닐 때(구조 오류, Builder semantic 오류와 다름). */
export class BuildSpecShapeError extends Error {
  constructor(readonly issues: string[]) {
    super(i18n.t("buildSpec.yaml.invalidShape", { issues: issues.join(", ") }));
    this.name = "BuildSpecShapeError";
  }
}

// 필수 최상위 키/구조만 확인하는 의도적으로 느슨한 스키마. `.passthrough()`로 Studio가
// 모델링하지 않는 필드(publish/splits/pii/license/quality/composition 등)를 그대로 통과시켜,
// "이 값이 있으면 구조 오류로 처리해 잘라낸다"는 실수를 방지한다. sources[]/exports[]도 항목
// 단위로는 필수 키만 확인하고 나머지는 통과시킨다 — kind별 세부 필수 조건은 Builder
// `/validate`(semantic)의 몫이다.
const looseSourceRefSchema = z.object({ params: z.record(z.string(), z.unknown()).optional() }).passthrough();
const looseExportTargetSchema = z.object({ kind: z.string(), output_path: z.string() }).passthrough();

const canonicalSpecShapeSchema = z
  .object({
    dataset_id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    sources: z.array(looseSourceRefSchema).min(1),
    exports: z.array(looseExportTargetSchema).min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * Studio BuildSpec을 사람이 읽기 좋은 canonical YAML 텍스트로 직렬화한다.
 *
 * `toBuilderSpec`(제출 정본과 동일한 매핑 함수)의 결과를 그대로 YAML로 stringify한다 —
 * 값 자체는 제출 payload와 항상 같고, 표현 형식(YAML vs JSON 문자열)만 다르다.
 *
 * @param spec - Studio 측 BuildSpec.
 * @returns 편집용 YAML 텍스트.
 */
export function toYamlText(spec: BuildSpec): string {
  return stringifyYaml(toBuilderSpec(spec));
}

/**
 * YAML 텍스트를 Studio BuildSpec으로 되돌린다.
 *
 * @param text - 사용자가 편집한 YAML 텍스트.
 * @returns 매핑된 BuildSpec.
 * @throws YamlSyntaxError YAML 자체를 파싱하지 못한 경우.
 * @throws BuildSpecShapeError 파싱은 됐지만 canonical BuildSpec 모양이 아닌 경우.
 */
export function fromYamlText(text: string): BuildSpec {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (cause) {
    throw new YamlSyntaxError(cause);
  }

  // 구조 검증은 safeParse로만 수행하고(strip 방지), fromBuilderSpec에는 원본 raw 객체를
  // 그대로 넘긴다 — Zod 결과를 넘기면 canonicalSpecShapeSchema가 모르는 최상위 키
  // (publish/splits/...)가 조용히 사라져 round-trip이 깨진다(#250 amendment 2).
  const result = canonicalSpecShapeSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    throw new BuildSpecShapeError(issues);
  }

  return fromBuilderSpec(raw as BuilderSpec);
}
