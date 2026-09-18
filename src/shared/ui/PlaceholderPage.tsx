/**
 * 아직 실제 화면이 연결되지 않은 route를 위한 공통 placeholder (#247).
 *
 * Epic #246의 새 IA는 하위 이슈 단위로 순차 구현된다. App Shell/Navigation(#247) 단계에서
 * route와 메뉴가 먼저 존재해야 이후 화면 이슈들이 동일한 layout에서 이어받을 수 있으므로,
 * 아직 구현되지 않은 화면은 관련 없는 기존 화면을 재사용하는 대신 명시적인 placeholder를 보여준다.
 */
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { Card } from "./Card";
import { PageHeader } from "./PageHeader";

export interface PlaceholderPageProps {
  /** PageHeader 상단 라벨 */
  eyebrow: string;
  /** 페이지 제목 */
  title: string;
  /** 이 화면이 최종적으로 어떤 역할을 하는지에 대한 설명 */
  description: string;
  /** 어떤 이슈에서 실제로 구현되는지 안내하는 문구 */
  note: ReactNode;
}

/**
 * 제목/설명과 함께 "아직 준비 중" 안내를 보여주는 placeholder 페이지.
 *
 * @param props - eyebrow/title/description/note.
 * @returns placeholder 화면 엘리먼트.
 */
export function PlaceholderPage({ eyebrow, title, description, note }: PlaceholderPageProps) {
  const { t } = useTranslation();
  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <Card variant="dashed" className="flex flex-col items-center gap-2 py-16 text-center">
        <p className="text-lg font-medium tracking-tight">{t("placeholder.notReady")}</p>
        <p className="mx-auto max-w-xl text-sm leading-6 text-muted-foreground">{note}</p>
      </Card>
    </main>
  );
}
