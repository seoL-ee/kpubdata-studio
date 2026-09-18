/**
 * Provider 상태 → 사용자 문구 변환의 단일 지점.
 *
 * - `describeCredentialReadiness` (현재 user-facing): ProviderPage / Add Data가
 *   generic live probe 대신 쓰는 credential readiness 표현. Provider 수준에서
 *   신뢰성 있게 확인 가능한 축(요구 여부 / effective configured / 사용자 저장
 *   credential 유무)만 다룬다.
 * - `describeProviderProbe` (retained): Builder `ProviderTestResponse` 매핑.
 *   generic probe는 임의의 첫 Dataset을 필수 파라미터 없이 호출하므로 "연결 성공
 *   여부"로 신뢰할 수 없어 user flow에서는 제거됐다(#S-provider-probe). Builder
 *   API contract는 유지되므로 매핑/테스트는 남겨 둔다(직접 진단용).
 * - 어느 경우든 선택한 Dataset의 실제 사용 가능 여부는 Preview가 SSOT다.
 *
 * 문구는 모두 `provider.status.*` 키로 옮겼다(#350). 상수로 고정하면 모듈 로드 시점에
 * 언어가 박혀 전환이 반영되지 않으므로, 호출 시점에 해석한다.
 */
import { i18n } from "@/shared/i18n";

const t = (key: string, params?: Record<string, unknown>): string =>
  i18n.t(`provider.status.${key}`, params ?? {});


export type ProviderProbeStatus = "connected" | "failed" | "not_configured" | "unknown";
export type ProviderProbeTone = "success" | "warning" | "error" | "neutral";

export interface ProviderProbeInput {
  /** `ProviderTestResponse.status` (`unknown` = 아직 점검 안 함). */
  status: ProviderProbeStatus;
  /** `ProviderTestResponse.error_category`. */
  errorCategory?: string;
  /** `ProviderTestResponse.response_code` — Provider가 실제로 돌려준 HTTP 코드. */
  responseCode?: number;
  /**
   * 이 principal에 대해 credential이 (effective하게) 구성돼 있는지.
   * 저장된 credential이 있는데도 403이면 단순 인증 실패가 아니라 Dataset/API별
   * 사용 권한 문제일 수 있으므로 "확인 필요"로 승격한다.
   */
  credentialConfigured?: boolean;
}

export interface ProviderProbePresentation {
  tone: ProviderProbeTone;
  /** 짧은 배지 문구. */
  label: string;
  /** 자세히 보기 제목(연결 오류/확인 필요일 때만, 그 외 null). */
  title: string | null;
  /** 사용자 행동 안내 1–2문장(없으면 null). */
  detail: string | null;
}

function permissionCheck(): { title: string; detail: string } {
  return { title: t("permission.title"), detail: t("permission.detail") };
}

/** Builder `error_category` → 문구. 알 수 없는 값은 unknown으로 떨어진다. */
const FAILURE_CATEGORIES = ["auth", "network", "timeout", "provider", "unknown"] as const;

function failure(category: string | undefined): { title: string; detail: string } {
  const key = (FAILURE_CATEGORIES as readonly string[]).includes(category ?? "")
    ? (category as string)
    : "unknown";
  return { title: t(`failure.${key}.title`), detail: t(`failure.${key}.detail`) };
}

/** Provider 수준 검사 결과임을 항상 함께 안내한다(Dataset 사용 가능 여부와 구분). */
export function providerProbeScopeNote(): string {
  return t("scopeNote");
}

/**
 * Provider 상태를 **credential readiness** 로 표현한다(#S-provider-probe). Provider
 * 수준에서 신뢰성 있게 확인 가능한 축은 이것뿐이다:
 *   - provider가 credential을 요구하는지(`requires_credential`)
 *   - effective credential이 구성돼 있는지(`configured`: user credential > server
 *     default > 없음, ADR 0012)
 *   - 이 사용자가 직접 저장한 credential이 있는지(GET /providers/{provider}/credential)
 *
 * "이 API Key가 해당 Dataset에서 실제 유효한가 / 활용신청이 됐는가 / 필수 파라미터가
 * 맞는가 / 실제 응답이 성공하는가" 는 Provider 수준에서 판정하지 않는다 — 선택한
 * Dataset의 Preview가 SSOT다. generic probe(`ProviderTestResponse`)를 사용자-facing
 * "연결 성공 여부" 로 쓰지 않는다.
 */
export interface CredentialReadinessInput {
  /** GET /providers 요약의 `requires_credential`. */
  requiresCredential: boolean;
  /** GET /providers 요약의 effective `configured`(user credential > server default > 없음). */
  summaryConfigured: boolean;
  /**
   * 이 사용자가 직접 저장한 credential 유무(GET /providers/{provider}/credential
   * 메타데이터). server default와 구분한다 — 목록처럼 이 값을 모를 때는 생략한다.
   */
  userCredentialConfigured?: boolean;
}

export interface CredentialReadinessPresentation {
  tone: Exclude<ProviderProbeTone, "error">;
  /** 짧은 배지/헤드라인 문구. */
  label: string;
  /** 안내 1–2문장. */
  detail: string;
}

/** Preview가 실제 사용 가능 여부의 최종 확인임을 항상 함께 안내한다. */
function readinessPreviewNote(): string {
  return t("readiness.previewNote");
}

export function describeCredentialReadiness(
  input: CredentialReadinessInput,
): CredentialReadinessPresentation {
  if (!input.requiresCredential) {
    return {
      tone: "neutral",
      label: t("readiness.noAuthLabel"),
      detail: t("readiness.noAuthDetail"),
    };
  }
  if (input.userCredentialConfigured) {
    return {
      tone: "success",
      label: t("readiness.userKeyLabel"),
      detail: `${t("readiness.userKeyDetail")} ${readinessPreviewNote()}`,
    };
  }
  if (input.summaryConfigured) {
    // server default 로 사용 중 — 사용자 등록 API Key와 동일하게 표현하지 않는다.
    return {
      tone: "success",
      label: t("readiness.serverDefaultLabel"),
      detail: `${t("readiness.serverDefaultDetail")} ${readinessPreviewNote()}`,
    };
  }
  return {
    tone: "warning",
    label: t("readiness.missingKeyLabel"),
    detail: t("readiness.missingKeyDetail"),
  };
}

export function describeProviderProbe(input: ProviderProbeInput): ProviderProbePresentation {
  if (input.status === "connected") {
    return { tone: "success", label: t("probe.connected"), title: null, detail: null };
  }
  if (input.status === "not_configured") {
    return {
      tone: "neutral",
      label: t("probe.notConfigured"),
      title: t("probe.notConfiguredTitle"),
      detail: t("probe.notConfiguredDetail"),
    };
  }
  if (input.status === "unknown") {
    return { tone: "neutral", label: t("probe.unknown"), title: null, detail: null };
  }
  // status === "failed"
  const needsPermissionCheck = Boolean(input.credentialConfigured) && input.responseCode === 403;
  if (needsPermissionCheck) {
    return { tone: "warning", label: t("probe.needsCheck"), ...permissionCheck() };
  }
  return { tone: "error", label: t("probe.failed"), ...failure(input.errorCategory) };
}
