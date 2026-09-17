/**
 * Saved BuildSpec 로컬 저장소 (#260).
 *
 * `reports/repository.ts`(#258)와 같은 저장 계층을 그대로 재사용한다 — 저장 실패를 조용히
 * 삼키지 않고 명시적 `SaveResult`로 알리며, 개수 상한 초과 시 오래된 항목을 자동 삭제하는
 * 대신 저장 자체를 거부한다(사용자가 직접 저장한 자산이므로), 낙관적 동시성(revision)으로
 * 여러 탭에서의 충돌을 감지한다.
 *
 * 저장 전 `redactSecrets()`(#206, assistant/scrub.ts)를 적용해 API Key/토큰으로 보이는
 * 값이 로컬 저장소에 평문으로 남지 않게 한다.
 */
import { i18n } from "@/shared/i18n";
import { redactSecrets } from "@/features/assistant/scrub";
import { ownedStorageKey } from "@/features/auth/storageOwner";
import type { BuildSpec } from "@/shared/lib/types";
import {
  SAVED_SPEC_VERSION,
  type SavedBuildSpec,
  type SavedBuildSpecSummary,
  type SavedSpecValidation,
} from "./types";

const STORE_KEY = "kpubdata-studio:saved-build-specs";
export const STORE_VERSION = 1;

/** 저장 가능한 최대 Saved BuildSpec 수. 넘으면 가장 오래 수정되지 않은 것부터 저장을 거부한다(자동 삭제하지 않음). */
export const SAVED_SPEC_LIMIT = 30;

interface StoreEnvelope {
  version: number;
  specs: Record<string, SavedBuildSpec>;
}

export type SaveResult =
  | { ok: true; revision: number }
  | { ok: false; reason: string; conflict?: boolean };

function emptyEnvelope(): StoreEnvelope {
  return { version: STORE_VERSION, specs: {} };
}

function isStorageAvailable(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

/** 저장된 봉투를 읽는다. 없거나 버전이 다르거나 손상되면 빈 봉투를 반환한다(손상 값은 정리). */
function readEnvelope(): StoreEnvelope {
  if (!isStorageAvailable()) return emptyEnvelope();
  try {
    const raw = localStorage.getItem(ownedStorageKey(STORE_KEY));
    if (!raw) return emptyEnvelope();
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as StoreEnvelope).version !== STORE_VERSION ||
      typeof (parsed as StoreEnvelope).specs !== "object" ||
      (parsed as StoreEnvelope).specs === null
    ) {
      localStorage.removeItem(ownedStorageKey(STORE_KEY));
      return emptyEnvelope();
    }
    return parsed as StoreEnvelope;
  } catch {
    return emptyEnvelope();
  }
}

/**
 * 봉투를 저장한다. 성공/실패를 그대로 알린다 — quota 초과·storage 미지원·직렬화 실패를
 * 구분해 이유를 돌려주고, 실패했는데도 저장된 것처럼 보이게 하지 않는다.
 */
function writeEnvelope(envelope: StoreEnvelope): SaveResult {
  if (!isStorageAvailable()) {
    return { ok: false, reason: i18n.t("workspace.storage.noStorage") };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(envelope);
  } catch {
    return { ok: false, reason: i18n.t("workspace.storage.serializeFailed") };
  }
  try {
    localStorage.setItem(ownedStorageKey(STORE_KEY), serialized);
    return { ok: true, revision: 0 };
  } catch (cause) {
    const isQuota =
      cause instanceof DOMException &&
      (cause.name === "QuotaExceededError" || cause.name === "NS_ERROR_DOM_QUOTA_REACHED" || cause.code === 22);
    return {
      ok: false,
      reason: isQuota
        ? i18n.t("workspace.storage.quotaExceeded")
        : i18n.t("workspace.storage.saveFailed"),
    };
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `saved-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function firstSourceProvider(spec: BuildSpec): string {
  return spec.sources[0]?.provider ?? "";
}

function outputPath(spec: BuildSpec): string {
  // metadata는 JsonValue 사전(#250)이므로 string으로 좁혀서만 읽는다(표시용 요약).
  const value = spec.metadata.outputPath;
  return typeof value === "string" ? value : "";
}

/** 저장된 Saved BuildSpec 목록을 최근 수정 순으로 요약해 반환한다. */
export function listSavedSpecSummaries(): SavedBuildSpecSummary[] {
  const envelope = readEnvelope();
  return Object.values(envelope.specs)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      provider: firstSourceProvider(entry.spec),
      outputPath: outputPath(entry.spec),
      validationStatus: entry.validation.status,
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** id로 Saved BuildSpec 전체를 불러온다. 없으면 null. */
export function getSavedSpec(id: string): SavedBuildSpec | null {
  if (!id) return null;
  return readEnvelope().specs[id] ?? null;
}

/**
 * Saved BuildSpec을 저장한다(생성/수정 공용). 이미 저장된 revision보다 낮은 revision으로
 * 저장을 시도하면(다른 탭에서 먼저 저장한 경우) 기본적으로 거부한다 — "먼저 저장한 내용을
 * 보존하고 사용자에게 알린다"는 최소 안전 모델을 따른다. `force: true`를 넘기면 그래도
 * 덮어쓴다(사용자가 명시적으로 선택했을 때만 호출부가 사용).
 */
export function saveSpec(entry: SavedBuildSpec, options: { force?: boolean } = {}): SaveResult {
  const envelope = readEnvelope();
  const existing = envelope.specs[entry.id];

  if (existing && !options.force && existing.revision > entry.revision) {
    return {
      ok: false,
      conflict: true,
      reason: i18n.t("workspace.storage.staleWrite"),
    };
  }

  const keys = Object.keys(envelope.specs);
  if (!existing && keys.length >= SAVED_SPEC_LIMIT) {
    return {
      ok: false,
      reason: i18n.t("workspace.storage.limitExceeded", { limit: SAVED_SPEC_LIMIT }),
    };
  }

  const nextRevision = (existing?.revision ?? 0) + 1;
  const toStore: SavedBuildSpec = {
    ...entry,
    spec: redactSecrets(entry.spec) as BuildSpec,
    revision: nextRevision,
    updatedAt: new Date().toISOString(),
  };
  envelope.specs[entry.id] = toStore;

  const result = writeEnvelope(envelope);
  if (!result.ok) return result;
  return { ok: true, revision: nextRevision };
}

export interface CreateSavedSpecInput {
  name: string;
  spec: BuildSpec;
  validation: SavedSpecValidation;
}

/** 새 Saved BuildSpec을 만들어 저장한다. 저장 실패 시 entry는 반환하되 저장은 되지 않았음을 result로 알린다. */
export function createSavedSpec(input: CreateSavedSpecInput): { entry: SavedBuildSpec; result: SaveResult } {
  const now = new Date().toISOString();
  const entry: SavedBuildSpec = {
    id: newId(),
    name: input.name,
    spec: input.spec,
    validation: input.validation,
    createdAt: now,
    updatedAt: now,
    version: SAVED_SPEC_VERSION,
    revision: 0,
  };
  const result = saveSpec(entry, { force: true });
  if (!result.ok) return { entry, result };
  // saveSpec은 저장 시각을 새로 찍으므로, 저장된 정본을 그대로 돌려준다 —
  // 생성 시각과 저장 시각이 어긋나면 caller가 updatedAt를 신뢰할 수 없다.
  const stored = getSavedSpec(entry.id);
  return { entry: stored ?? { ...entry, revision: result.revision }, result };
}

/** 이름만 바꿔 저장한다. */
export function renameSavedSpec(id: string, name: string): SaveResult {
  const entry = getSavedSpec(id);
  if (!entry) return { ok: false, reason: i18n.t("workspace.storage.notFound") };
  return saveSpec({ ...entry, name }, { force: true });
}

/**
 * 기존 Saved BuildSpec을 복제해 새 id로 저장한다. 새 이름("(복제본)")과 새 생성/수정
 * 시각을 부여하고, 검증 결과는 이 복사본에 대해 아직 확인되지 않았으므로 초기화한다
 * (원본을 검증했다고 복사본도 검증된 것으로 표시하지 않는다).
 */
export function duplicateSavedSpec(id: string, nameOverride?: string): { entry: SavedBuildSpec; result: SaveResult } | null {
  const source = getSavedSpec(id);
  if (!source) return null;
  const now = new Date().toISOString();
  const cloned: SavedBuildSpec = {
    ...structuredClone(source),
    id: newId(),
    name: nameOverride ?? i18n.t("workspace.storage.copyOf", { name: source.name }),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    validation: { status: "not_validated", errors: [] },
  };
  const result = saveSpec(cloned, { force: true });
  return { entry: result.ok ? { ...cloned, revision: result.revision } : cloned, result };
}

/** id의 Saved BuildSpec을 삭제한다. 존재하지 않았거나 저장소 사용 불가 시 false. */
export function deleteSavedSpec(id: string): boolean {
  if (!isStorageAvailable()) return false;
  const envelope = readEnvelope();
  if (!envelope.specs[id]) return false;
  delete envelope.specs[id];
  return writeEnvelope(envelope).ok;
}

/**
 * 현재 소유자(로그인 사용자 또는 anonymous)의 Saved BuildSpec을 전부 삭제한다 (#293).
 * 다른 소유자 버킷은 건드리지 않는다.
 */
export function clearAllSavedSpecs(): boolean {
  if (!isStorageAvailable()) return false;
  try {
    localStorage.removeItem(ownedStorageKey(STORE_KEY));
    return true;
  } catch {
    return false;
  }
}

/** 저장된 Saved BuildSpec이 있는지 확인한다(빈 상태 안내용). */
export function hasAnySavedSpec(): boolean {
  return Object.keys(readEnvelope().specs).length > 0;
}
