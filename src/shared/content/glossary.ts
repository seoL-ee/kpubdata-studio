/**
 * 용어 사전 — 화면 곳곳의 `TermHelp` 툴팁이 쓰는 설명 문구.
 *
 * 문구 자체는 `glossary.*` 키로 i18n에 있다(#350). 여기서는 **어떤 용어가 있는지**만
 * 선언한다 — 모듈 상수로 문구를 들고 있으면 언어 전환이 반영되지 않는다.
 */
import { i18n } from "@/shared/i18n";

export const GLOSSARY_TERMS = [
  "dataset",
  "build",
  "run",
  "buildSpec",
  "provider",
  "credential",
  "preview",
  "bronze",
  "silver",
  "gold",
  "quality",
  "schemaDrift",
  "evidence",
  "context",
  "generatedSql",
  "artifact",
  "manifest",
  "readiness",
] as const;

export type GlossaryKey = (typeof GLOSSARY_TERMS)[number];

/** 용어 설명 문구를 현재 언어로 돌려준다. */
export function glossaryDescription(term: GlossaryKey): string {
  return i18n.t(`glossary.${term}`);
}
