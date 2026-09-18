/**
 * Preview 전 usability preflight — 선택한 Dataset의 metadata(`request_parameters`)로
 * 필수 요청 파라미터를 아는 경우에만 동작한다.
 *
 * - JSON 구문 오류는 여기서 만들지 않는다(그 경로는 `buildSpecFromDraft`가 이미
 *   담당) — 필수 key 누락만 사용자 문구로 돌려준다.
 * - 빈 문자열/공백만 있는 값도 누락으로 취급한다(공공데이터 API 다수가 빈 값을
 *   "미전달"로 처리하고, 실제 E2E에서도 `{}` → NO_MANDATORY_REQUEST_PARAMETERS).
 * - Builder/Core validation을 대체하지 않는다 — 어디까지나 사전 안내다.
 */
import { i18n } from "@/shared/i18n";
import type { CatalogRequestParameter } from "@/shared/lib/builderApi";

export interface RequiredParamsCheck {
  /** 사용자에게 보여줄 오류(없으면 통과). */
  error?: string;
}

export function requiredParamNames(
  requestParameters: readonly CatalogRequestParameter[] | undefined,
): string[] {
  return (requestParameters ?? []).filter((p) => p.required).map((p) => p.name);
}

export function checkRequiredParams(
  sourceParamsText: string,
  requestParameters: readonly CatalogRequestParameter[] | undefined,
): RequiredParamsCheck {
  const required = requiredParamNames(requestParameters);
  if (required.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceParamsText.trim() || "{}");
  } catch {
    // JSON 오류는 별도 경로에서 안내한다.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const obj = parsed as Record<string, unknown>;

  const missing = required.filter((name) => {
    const value = obj[name];
    return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  });
  if (missing.length === 0) return {};
  return { error: i18n.t("addData.requiredParams", { params: missing.join(", ") }) };
}

/**
 * 요청 파라미터 입력 도움말/placeholder에 쓸 예시 JSON 텍스트.
 * metadata가 있으면 그 파라미터로 구체 예시를, 없으면 중립 예시를 만든다.
 */
export function exampleParamsText(
  requestParameters: readonly CatalogRequestParameter[] | undefined,
): string {
  const params = requestParameters ?? [];
  if (params.length === 0) return '{"region": "seoul"}';
  // 예시는 "필수 최소치"를 보여준다 — 필수가 하나도 없으면 전체를 쓴다.
  const shown = params.some((p) => p.required) ? params.filter((p) => p.required) : params;
  const entries = shown.map((p) => [p.name, p.example ?? ""] as const);
  return JSON.stringify(Object.fromEntries(entries));
}

/** "예시값 적용" 버튼에 표시할 대상이 있는지 — example이 있는 파라미터가 하나라도 있어야 한다. */
export function hasExampleParams(
  requestParameters: readonly CatalogRequestParameter[] | undefined,
): boolean {
  return (requestParameters ?? []).some((p) => p.example);
}

/**
 * "예시값 적용" 버튼 동작 — metadata의 example 값을 요청 파라미터 JSON에 채운다.
 *
 * - secret parameter는 애초에 Builder `/catalog`가 request_parameters에 담지
 *   않으므로(serviceKey 등 allowlist에서 제외) 여기서 생성할 값 자체가 없다.
 * - example이 없는 parameter에 임의 값을 만들지 않는다 — example이 있는 항목만 채운다.
 * - 사용자가 이미 입력한 값은 덮어쓰지 않는다(이미 채워진 key는 건드리지 않는 안전한
 *   merge) — 버튼을 눌러도 기존 입력을 잃지 않는다.
 * - 기존 텍스트가 유효한 JSON object가 아니면(빈 값 포함) example만으로 새로 만든다.
 */
export function mergeExampleParams(
  currentText: string,
  requestParameters: readonly CatalogRequestParameter[] | undefined,
): string {
  const withExample = (requestParameters ?? []).filter(
    (p): p is CatalogRequestParameter & { example: string } => Boolean(p.example),
  );
  if (withExample.length === 0) return currentText;

  let base: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(currentText.trim() || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      base = { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // 기존 텍스트가 JSON이 아니면 example만으로 새로 만든다.
  }

  for (const p of withExample) {
    const existing = base[p.name];
    const isEmpty = existing === undefined || existing === null || (typeof existing === "string" && existing.trim() === "");
    if (isEmpty) base[p.name] = p.example;
  }

  return JSON.stringify(base, null, 2);
}
