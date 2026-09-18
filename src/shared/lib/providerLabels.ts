/**
 * Builder `/catalog` provider 코드의 표시명.
 *
 * NewBuildPage(#29)와 Discover(#249)가 같은 provider 목록을 서로 다른 화면에서
 * 보여주므로, 라벨 매핑을 여기 하나로 모아 중복 정의를 피한다.
 *
 * 문구는 `provider.labels.*` 키로 i18n에 있다(#350) — 기관명은 공식 영문명을 쓴다.
 * 상수 맵으로 들고 있으면 모듈 로드 시점에 언어가 굳는다.
 */
import { i18n } from "@/shared/i18n";

export const PROVIDER_CODES = [
  "bok",
  "datago",
  "kosis",
  "krx",
  "law",
  "localdata",
  "lofin",
  "semas",
  "seoul",
  "sgis",
] as const;

/** 알려진 provider 코드는 현재 언어 라벨로, 모르는 코드는 원문 그대로 보여준다. */
export function providerLabel(provider: string): string {
  return (PROVIDER_CODES as readonly string[]).includes(provider)
    ? i18n.t(`provider.labels.${provider}`)
    : provider;
}
