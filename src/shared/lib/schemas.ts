/**
 * Studio에서 사용하는 zod 기반 입력/도메인 스키마 모음.
 *
 * 폼 입력과 API 페이로드가 공유 타입 규약을 어기지 않도록 런타임 검증 규칙을 제공한다.
 */
import { i18n } from "@/shared/i18n";
import { z } from "zod";

/** 지원하는 export 형식 목록을 제한하는 enum 스키마 */
export const exportFormatSchema = z.enum([
  "markdown",
  "jsonl",
  "parquet",
  "huggingface",
]);

export type JsonValueInput = string | number | boolean | null | JsonValueInput[] | { [key: string]: JsonValueInput };

export const jsonValueSchema: z.ZodType<JsonValueInput> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const recordSchema = z.record(z.string(), z.string());

export const jsonRecordSchema = z.record(z.string(), jsonValueSchema);

/** export 옵션은 문자열 키에 임의 값(unknown)을 허용한다 (ExportTarget.options 규약과 정렬) */
export const exportOptionsSchema = z.record(z.string(), jsonValueSchema);

/** 소스 스키마 계약 (VAL-1). Builder sources[].schema 와 1:1. */
export const schemaContractSchema = z.object({
  required: z.array(z.string()),
  dtypes: z.record(z.string(), z.string()),
  casts: z.record(z.string(), z.string()),
});

/** kind="public_api"(기본)/file/url 구분(#498). */
export const sourceKindSchema = z.enum(["public_api", "file", "url"]);

/** kind="file"/"url" source가 실제로 지원하는 포맷(Builder #498 계약 기준). */
export const sourceFormatSchema = z.enum(["csv", "json", "jsonl", "parquet"]);

/** `POST /uploads`가 발급하는 upload_id 형식(Builder #498: `upl_` + hex 32자). */
export const uploadIdSchema = z.string().regex(/^upl_[a-f0-9]{32}$/, i18n.t("schemas.uploadIdFormat"));

/**
 * 단일 원본 데이터 참조가 가져야 할 필드를 검증하는 스키마 (#250, #498).
 *
 * kind별 필수 필드는 discriminated union 대신 `superRefine`으로 강제한다 — Builder
 * 계약(SourceRef) 자체가 OpenAPI object schema로 조건부 필수를 표현하지 않고
 * `additionalProperties: true` 위에서 loader/validator가 강제하는 것과 같은 패턴이다.
 */
export const sourceRefSchema = z
  .object({
    kind: sourceKindSchema.optional(),
    provider: z.string().optional(),
    dataset: z.string().optional(),
    params: jsonRecordSchema,
    alias: z.string().min(1, "Alias cannot be empty.").optional(),
    schema: schemaContractSchema.optional(),
    uploadId: uploadIdSchema.optional(),
    format: sourceFormatSchema.optional(),
    encoding: z.string().optional(),
    endpoint: z.string().optional(),
    method: z.literal("GET").optional(),
  })
  .superRefine((source, ctx) => {
    const kind = source.kind ?? "public_api";
    if (kind === "public_api") {
      if (!source.provider) {
        ctx.addIssue({ code: "custom", path: ["provider"], message: "Provider is required." });
      }
      if (!source.dataset) {
        ctx.addIssue({ code: "custom", path: ["dataset"], message: "Dataset is required." });
      }
    } else if (kind === "file") {
      if (!source.uploadId) {
        ctx.addIssue({ code: "custom", path: ["uploadId"], message: i18n.t("schemas.uploadRequired") });
      }
      if (!source.format) {
        ctx.addIssue({ code: "custom", path: ["format"], message: i18n.t("schemas.formatRequired") });
      }
    } else if (kind === "url") {
      if (!source.endpoint) {
        ctx.addIssue({ code: "custom", path: ["endpoint"], message: i18n.t("schemas.endpointRequired") });
      } else if (!/^https:\/\//i.test(source.endpoint)) {
        ctx.addIssue({ code: "custom", path: ["endpoint"], message: i18n.t("schemas.httpsOnly") });
      }
      if (source.format && !["csv", "json", "jsonl"].includes(source.format)) {
        ctx.addIssue({ code: "custom", path: ["format"], message: i18n.t("schemas.urlFormats") });
      }
    }
  });

/** 결과물 export 대상 정의를 검증하는 스키마 */
export const exportTargetSchema = z.object({
  format: z.string().min(1, "Export format is required."),
  options: exportOptionsSchema.optional(),
});

/** 새 빌드 작성 화면에서 생성하는 전체 스펙 구조를 검증하는 스키마 */
export const buildSpecSchema = z.object({
  datasetId: z.string().min(1, "Dataset ID is required."),
  title: z.string().min(1, "Title is required."),
  description: z.string().min(1, "Description is required."),
  sources: z.array(sourceRefSchema).min(1, "At least one source is required."),
  exports: z.array(exportTargetSchema).min(1, "Select at least one export format."),
  metadata: jsonRecordSchema,
  // Studio가 편집 UI를 제공하지 않는 canonical 최상위 필드(publish/splits/pii/...)를
  // round-trip 중 유실하지 않도록 보존하는 bucket (#250). specMapping.ts 참고.
  extra: jsonRecordSchema.optional(),
});

/**
 * New Build Wizard 폼 입력값(localStorage 초안으로 저장되는 실제 형태)을 검증하는 스키마.
 *
 * 저장된 초안(#84)을 복원할 때 형태가 깨졌거나 오래된 버전인 경우를 안전하게 걸러내기 위해
 * 사용한다. 빌드 실행용 스펙(`buildSpecSchema`)이 아니라 폼 입력 형태를 기술한다.
 */
export const buildFormValuesSchema = z.object({
  datasetId: z.string(),
  title: z.string(),
  description: z.string(),
  provider: z.string(),
  sourceDataset: z.string(),
  sourceParams: z.string(),
  outputPath: z.string(),
  exportFormats: z.array(z.string()),
});

/** `buildFormValuesSchema`를 통과한 폼 입력 타입 추론 결과 */
export type BuildFormValuesInput = z.infer<typeof buildFormValuesSchema>;

/** `buildSpecSchema`를 통과한 입력 타입 추론 결과 */
export type BuildSpecInput = z.infer<typeof buildSpecSchema>;
/** `exportTargetSchema`를 통과한 입력 타입 추론 결과 */
export type ExportTargetInput = z.infer<typeof exportTargetSchema>;
/** `sourceRefSchema`를 통과한 입력 타입 추론 결과 */
export type SourceRefInput = z.infer<typeof sourceRefSchema>;
