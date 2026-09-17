/**
 * Suggested Action 실행기 (#256).
 *
 * 여기 있는 함수는 전부 "사용자가 이미 승인 버튼을 눌렀을 때"만 `useKubiSession`에서 호출된다.
 * 이 파일 자체는 승인 여부를 판단하지 않는다 — 호출 자체가 승인의 증거다.
 *
 * Build 실행/Publish/Credential 변경/SQL 자동 실행/기존 BuildSpec 덮어쓰기는 이 파일에 아예
 * 구현하지 않는다 — allowlist에 없는 동작은 만들 수 있는 함수 자체가 없다.
 */
import { loadBuildSpec, saveBuildSpec } from "@/features/build-spec/specStore";
import { saveDraft } from "@/features/build-spec/draftStorage";
import { validateSpec } from "@/features/validation/api";
import { hasSecretPlaceholder, isSecretKey, redactSecrets } from "@/features/assistant/scrub";
import { i18n } from "@/shared/i18n";

/** 이 파일의 문구는 모두 `kubi.actions.*` 아래에 있다(#350). */
const t = (key: string, params?: Record<string, unknown>): string =>
  i18n.t(`kubi.actions.${key}`, params ?? {});
import { jsonValueHasRedactedSecret } from "@/features/add-data/paramsRedaction";
import { buildFormValuesSchema } from "@/shared/lib/schemas";
import type { BuildSpec, JsonValue } from "@/shared/lib/types";
import type { KubiAction, BuildSpecPatchOp } from "./schema";
import { queueKubiReportNote } from "./reportInbox";
import type { KubiContext } from "./types";

/**
 * PATCH_BUILDSPEC이 건드릴 수 있는 경로만 허용한다.
 *
 * datasetId/provider/dataset(소스 정체성)과 export format은 의도적으로 제외했다 — AI가
 * 데이터 출처 자체를 조용히 바꿔치기할 수 없게 한다(#256 리뷰 §10 "AI가 수정하지 않은
 * Source/Export/Quality/Metadata가 사라지지 않는지" 원칙을 patch 허용 범위로도 지킨다).
 */
const ALLOWED_PATCH_PATH = /^\/(title|description|metadata\/[^/]+|sources\/\d+\/(alias|params\/[^/]+)|exports\/\d+\/options\/[^/]+)$/;

/** `/sources/{index}/params/{key}` 경로에서 `{key}` 세그먼트만 뽑아낸다. 그 외 경로는 대상이 아니다. */
const SOURCE_PARAM_PATCH_PATH = /^\/sources\/\d+\/params\/([^/]+)$/;

export type BuildSpecPatchPreview =
  | { ok: true; before: BuildSpec; after: BuildSpec }
  | { ok: false; reason: string };

function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * `/sources/{index}/params/{key}` patch가 credential성 필드를 건드리는지 판정한다(#277 리뷰).
 *
 * ADD_REPORT_BLOCK/OPEN_* 등 다른 action은 애초에 patch를 만들지 않으므로 이 검사와 무관하다.
 * 새 secret 판정 규칙을 여기서 따로 만들지 않고, 기존 scrub(#206, #226)이 evidence/outbound
 * 메시지에 쓰는 `isSecretKey`를 그대로 재사용한다 — "serviceKey/apiKey/token/secret로 끝나는
 * 키"라는 하나의 정의만 유지하기 위함이다.
 */
function isCredentialPatchPath(path: string): boolean {
  const match = SOURCE_PARAM_PATCH_PATH.exec(path);
  if (!match) return false;
  return isSecretKey(unescapePointerSegment(match[1]));
}

/** 최소 JSON Patch(add/replace/remove) 적용. 경로는 사전에 allowlist로 검증된 것만 들어온다. */
function applyPointerOp(target: Record<string, unknown>, op: BuildSpecPatchOp): void {
  const segments = op.path.split("/").slice(1).map(unescapePointerSegment);
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = cursor[segments[i]];
    if (typeof next !== "object" || next === null) {
      throw new Error(t("missingParent", { path: op.path }));
    }
    cursor = next as Record<string, unknown>;
  }
  const lastKey = segments[segments.length - 1];
  if (op.op === "remove") {
    delete cursor[lastKey];
    return;
  }
  cursor[lastKey] = op.value as JsonValue;
}

/**
 * PATCH_BUILDSPEC 액션을 diff 미리보기로 변환한다. 실제 저장은 하지 않는다.
 *
 * @param action - 승인 대기 중인 PATCH_BUILDSPEC 액션.
 * @returns 원본 spec을 찾을 수 없거나 허용되지 않은 경로가 있으면 실패 사유, 아니면 before/after.
 */
export function previewBuildSpecPatch(
  action: Extract<KubiAction, { type: "PATCH_BUILDSPEC" }>,
): BuildSpecPatchPreview {
  const before = loadBuildSpec(action.runId);
  if (!before) {
    return {
      ok: false,
      reason: t("specNotFound", { runId: action.runId }),
    };
  }

  // 로컬 보관 정책상 저장된 spec에서 secret 값이 이미 redaction marker로 지워져 있으면
  // fail-closed — marker가 남은 채로 patch를 적용하면 validate 단계에서 literal placeholder가
  // Builder로 제출된다(S07 리뷰 §1). credential 재입력은 Provider 설정 화면 몫이다.
  if (jsonValueHasRedactedSecret(before)) {
    return {
      ok: false,
      reason: t("secretsRedacted"),
    };
  }

  const invalidPath = action.patch.find((op) => !ALLOWED_PATCH_PATH.test(op.path));
  if (invalidPath) {
    return {
      ok: false,
      reason: t("pathNotAllowed", { path: invalidPath.path }),
    };
  }

  // credential성 params는 allowlist를 통과했더라도 여기서 결정적으로 다시 막는다(#277 리뷰) —
  // "prompt에 하지 말라고 적기"가 아니라 Studio gate에서 저장/validate 이전에 차단한다.
  const credentialPath = action.patch.find((op) => isCredentialPatchPath(op.path));
  if (credentialPath) {
    return {
      ok: false,
      reason: t("credentialPath", { path: credentialPath.path }),
    };
  }

  try {
    const clone = structuredClone(before) as unknown as Record<string, unknown>;
    for (const op of action.patch) applyPointerOp(clone, op);
    if (jsonValueHasRedactedSecret(clone)) {
      return {
        ok: false,
        reason: t("redactionMarker"),
      };
    }
    return { ok: true, before, after: clone as unknown as BuildSpec };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : t("patchFailed") };
  }
}

/**
 * 사용자가 승인한 BuildSpec patch를 저장하고 Builder `/validate`를 재실행한다(#256 리뷰 §10).
 *
 * @param runId - patch 대상 run.
 * @param after - `previewBuildSpecPatch`가 만든 적용 후 spec.
 * @returns 저장 후 validate 결과.
 */
export async function applyBuildSpecPatch(
  runId: string,
  after: BuildSpec,
  validate: typeof validateSpec = validateSpec,
): Promise<{ valid: boolean; errors: string[] }> {
  // `[REDACTED]`(specStore/savedSpecs) · `__KPD_*_REDACTED__`(draft) · `__SCRUBBED_*` 모두
  // 차단한다 — 어느 marker든 남은 채로 validate하면 literal placeholder가 Builder로 간다.
  if (jsonValueHasRedactedSecret(after)) {
    return { valid: false, errors: [t("unresolvedPlaceholder")] };
  }
  const result = await validate(after);
  if (result.valid) saveBuildSpec(runId, after);
  return result;
}

function assertSafeGeneratedValue(value: unknown): void {
  if (hasSecretPlaceholder(value)) {
    throw new Error(t("unresolvedPlaceholder"));
  }
}

function assertSafeSourceParams(value: string): void {
  assertSafeGeneratedValue(value);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (JSON.stringify(redactSecrets(parsed)) !== JSON.stringify(parsed)) {
      throw new Error(t("paramsCredential"));
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(t("paramsNotObject"), {
        cause: error,
      });
    }
    throw error;
  }
}

/** CREATE_BUILD_DRAFT이 New Build Wizard 초안 슬롯에 실제로 쓸 값을 만든다(부족한 필드는 안전한 기본값). */
export function draftValuesFromAction(
  action: Extract<KubiAction, { type: "CREATE_BUILD_DRAFT" }>,
): ReturnType<typeof buildFormValuesSchema.parse> {
  assertSafeGeneratedValue(action.values);
  assertSafeSourceParams(action.values.sourceParams ?? "{}");
  return buildFormValuesSchema.parse({
    datasetId: action.values.datasetId,
    title: action.values.title,
    description: action.values.description,
    provider: action.values.provider,
    sourceDataset: action.values.sourceDataset,
    sourceParams: action.values.sourceParams ?? "{}",
    outputPath: action.values.outputPath ?? `artifacts/builds/${action.values.datasetId}`,
    exportFormats: action.values.exportFormats ?? ["jsonl"],
  });
}

/** New Build Wizard의 단일 초안 슬롯에 값을 쓴다. 기존 미저장 초안이 있으면 덮어쓴다(승인 화면에서 미리 경고해야 함). */
export function applyCreateBuildDraft(action: Extract<KubiAction, { type: "CREATE_BUILD_DRAFT" }>): void {
  saveDraft(draftValuesFromAction(action));
}

/** ADD_REPORT_BLOCK 승인 결과를 Reports 진입점 큐에 넣는다(#258 전체 편집 기능은 만들지 않음). */
export function applyAddReportBlock(
  action: Extract<KubiAction, { type: "ADD_REPORT_BLOCK" }>,
  context: KubiContext,
): void {
  assertSafeGeneratedValue({ note: action.note, reason: action.reason });
  queueKubiReportNote({
    note: action.note,
    reason: action.reason,
    context: { datasetId: context.datasetId, runId: context.runId, stage: context.stage },
    savedAt: new Date().toISOString(),
  });
}

/** 순수 navigation action의 목적지 경로를 계산한다(실제 이동은 호출부가 react-router로 수행). */
export function actionHref(action: KubiAction): string | null {
  switch (action.type) {
    case "OPEN_PROVIDER":
      return "/provider";
    case "OPEN_BUILD":
      return `/builds/${encodeURIComponent(action.runId)}`;
    case "OPEN_QUALITY": {
      const params = new URLSearchParams();
      params.set("dataset", action.datasetId);
      if (action.runId) params.set("run", action.runId);
      if (action.source) params.set("source", action.source);
      if (action.stage) params.set("stage", action.stage);
      return `/quality?${params.toString()}`;
    }
    case "PATCH_BUILDSPEC":
    case "CREATE_BUILD_DRAFT":
    case "ADD_REPORT_BLOCK":
      return null;
  }
}

/** 사용자에게 보여줄 액션 요약 한 줄. */
export function describeAction(action: KubiAction): string {
  switch (action.type) {
    case "OPEN_PROVIDER":
      return t("describe.openProvider", { provider: action.provider });
    case "OPEN_BUILD":
      return t("describe.openBuild", { runId: action.runId });
    case "OPEN_QUALITY":
      return t("describe.openQuality", { datasetId: action.datasetId });
    case "PATCH_BUILDSPEC":
      return t("describe.patchSpec", { runId: action.runId, count: action.patch.length });
    case "CREATE_BUILD_DRAFT":
      return t("describe.createDraft", { title: action.values.title });
    case "ADD_REPORT_BLOCK":
      return t("describe.addReportBlock");
  }
}
