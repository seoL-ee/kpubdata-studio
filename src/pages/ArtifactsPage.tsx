/**
 * 결과물 랜딩 페이지 (/artifacts).
 *
 * 결과물은 빌드 단위로 관리되므로(제안 §5.7), 이 전역 화면은 빌드 선택으로 안내한다.
 * 빌드별 상세 결과물은 /builds/:buildId/artifacts 에서 확인한다.
 */
import { useTranslation } from "react-i18next";
import { Card, EmptyState, PageHeader } from "@/shared/ui";

/**
 * 빌드별 결과물 화면으로 안내하는 전역 결과물 랜딩 페이지.
 *
 * @returns 결과물 랜딩 화면.
 */
export function ArtifactsPage() {
  const { t } = useTranslation();
  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow={t("artifactsPage.eyebrow")}
        title={t("artifactsPage.title")}
        description={t("artifactsPage.desc")}
      />

      <Card className="p-0">
        <EmptyState
          title={t("artifactsPage.emptyTitle")}
          description={t("artifactsPage.emptyDesc")}
          actionLabel={t("artifactsPage.cta")}
          actionHref="/builds"
        />
      </Card>
    </main>
  );
}
