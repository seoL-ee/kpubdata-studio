/**
 * Public API Dataset 선택 후 credential prerequisite를 preview 이전에 확인한다
 * (#S-add-data). 뒤늦게 Preview에서 credential 오류로 실패하지 않도록, Configure
 * 단계에서 미리 안내한다.
 *
 * 확정 조건(둘 다 참일 때만 막는다):
 *   1. 선택한 Dataset/Provider가 credential을 요구한다(`CatalogDataset.requires_service_key`
 *      — provider 인증 필요 여부와 dataset의 `service_key_param` 존재 여부를 Builder가
 *      이미 합쳐서 계산한 값이다).
 *   2. `GET /providers` 요약의 effective `configured`(user credential > server default >
 *      없음, ADR 0012)로 확인했을 때 이 provider가 미설정이다.
 *
 * `providerConfigured`가 아직 로딩 중이거나(null) 이 provider 항목 자체가 없으면
 * (조회 실패 등) 막지 않는다 — Studio가 credential 존재 여부를 추측하지 않는다는
 * 원칙(요구사항 §3)에 따라, "확실히 미설정"으로 확인된 경우에만 진행을 막는다.
 */
import { i18n } from "@/shared/i18n";
import type { CatalogDataset } from "@/shared/lib/builderApi";

export interface CredentialPrerequisite {
  /** true면 이 Dataset을 계속 진행하기 전에 API 연결이 필요하다. */
  blocked: boolean;
}

export function checkCredentialPrerequisite(
  dataset: CatalogDataset | undefined,
  providerConfigured: Record<string, boolean> | null,
  provider: string,
): CredentialPrerequisite {
  if (!dataset?.requires_service_key) return { blocked: false };
  if (!providerConfigured || !(provider in providerConfigured)) return { blocked: false };
  return { blocked: providerConfigured[provider] === false };
}

export interface CredentialPrerequisiteMessage {
  title: string;
  body: string;
  cta: string;
}

/**
 * credential 미설정 안내 문구를 **호출 시점에** 해석한다.
 *
 * 예전에는 모듈 최상위 상수였는데, 그러면 import 시점 언어에 문구가 굳어
 * 언어를 바꿔도 이 카드만 이전 언어로 남는다(#350). 함수로 두면 렌더마다
 * 현재 언어가 반영된다.
 */
export function credentialPrerequisiteMessage(): CredentialPrerequisiteMessage {
  return {
    title: i18n.t("addData.credential.title"),
    body: i18n.t("addData.credential.body"),
    cta: i18n.t("addData.credential.cta"),
  };
}
