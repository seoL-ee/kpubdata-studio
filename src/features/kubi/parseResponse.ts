/**
 * LLM 원본 출력에서 구조화 응답을 추출/검증한다 (#256).
 *
 * 4중 게이트의 1단계(zod 파싱)만 담당한다. "모양"은 맞지만 "내용"(실존 dataset/run 등)이
 * 맞는지는 `crossCheck.ts`가 담당한다.
 */
import { i18n } from "@/shared/i18n";
import { kubiEvidenceRefSchema, kubiStructuredResponseSchema } from "./schema";
import type { KubiStructuredResponse } from "./types";

export type ParseKubiResponseResult =
  | { ok: true; response: KubiStructuredResponse; malformedEvidenceRefs: string[] }
  | { ok: false; message: string };

/** 잘못된 evidenceRef 항목을 사용자에게 보여줄 짧은 설명으로 바꾼다. */
function describeMalformedRef(item: unknown): string {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : "?";
    const id = typeof record.id === "string" ? record.id : "?";
    return `kind="${kind}" id="${id}"`;
  }
  const serialized = JSON.stringify(item);
  return serialized ? serialized.slice(0, 60) : String(item);
}

/**
 * evidenceRefs를 항목 단위로 검증한다(#256 리뷰 — evidenceRefs만 tolerant).
 *
 * evidenceRefs는 표시 전용이고 이후 `crossCheck`가 evidence와 대조하므로, 개별 항목 하나가
 * (예: `kind`가 허용 목록 밖) 잘못돼도 실행 가능한 `answer`/`generatedSql`/`suggestedActions`
 * 전체를 버리지 않는다. 잘못된 항목만 떼어내고, 나머지는 strict schema가 그대로 검증한다.
 */
function sanitizeEvidenceRefs(candidate: unknown): { malformed: string[] } {
  if (!candidate || typeof candidate !== "object") return { malformed: [] };
  const record = candidate as Record<string, unknown>;
  if (!("evidenceRefs" in record)) return { malformed: [] };

  const raw = record.evidenceRefs;
  if (!Array.isArray(raw)) {
    // 배열 자체가 아니면 항목 단위 검증이 불가능하다 — evidenceRefs는 표시 전용이므로
    // 통째로 비우고(실행 안전성에 영향 없음) 나머지 응답은 살린다.
    record.evidenceRefs = [];
    return { malformed: [describeMalformedRef(raw)] };
  }

  const valid: unknown[] = [];
  const malformed: string[] = [];
  for (const item of raw) {
    if (kubiEvidenceRefSchema.safeParse(item).success) valid.push(item);
    else malformed.push(describeMalformedRef(item));
  }
  record.evidenceRefs = valid;
  return { malformed };
}

/**
 * LLM 원본 텍스트에서 ```json 블록(또는 텍스트 전체)을 추출해 zod로 검증한다.
 *
 * @param rawOutput - provider.stream()이 반환한 누적 텍스트.
 * @returns 검증된 구조화 응답 또는 사람이 읽을 수 있는 실패 사유.
 */
export function parseKubiResponse(rawOutput: string): ParseKubiResponseResult {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    return { ok: false, message: i18n.t("kubi.parse.empty") };
  }

  const jsonMatch = trimmed.match(/```json\s*\n([\s\S]*?)\n```/) ?? trimmed.match(/\{[\s\S]*\}/);
  const jsonText = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : trimmed;

  let candidate: unknown;
  try {
    candidate = JSON.parse(jsonText);
  } catch {
    return { ok: false, message: i18n.t("kubi.parse.notJson") };
  }

  // evidenceRefs만 항목 단위로 관대하게 정리한다. answer/generatedSql/suggestedActions는
  // 아래 strict schema가 그대로 검증한다(fail-closed 유지).
  const { malformed: malformedEvidenceRefs } = sanitizeEvidenceRefs(candidate);

  const result = kubiStructuredResponseSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: i18n.t("kubi.parse.shapeMismatch", { issues }) };
  }

  return {
    ok: true,
    response: {
      answer: result.data.answer,
      evidenceRefs: result.data.evidenceRefs,
      generatedSql: result.data.generatedSql,
      suggestedActions: result.data.suggestedActions,
    },
    malformedEvidenceRefs,
  };
}
