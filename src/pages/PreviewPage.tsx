/**
 * 미리보기 페이지 (/preview, 레거시 딥링크).
 *
 * 미리보기는 이제 New Build 마법사의 ‘미리보기’ 단계에 통합되어 있다(제안 §5.3).
 * 이 화면은 딥링크 호환을 위해 유지하며, 마법사로 안내한다.
 */
import { useTranslation } from "react-i18next";
import { Card, EmptyState, PageHeader } from "@/shared/ui";

/**
 * 미리보기 흐름을 마법사로 안내하는 레거시 페이지.
 *
 * @returns 미리보기 안내 화면.
 */
export function PreviewPage() {
  const { t } = useTranslation();
  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow={t("previewPage.eyebrow")}
        title={t("previewPage.title")}
        description={t("previewPage.desc")}
      />

      <Card className="p-0">
        <EmptyState
          title={t("previewPage.emptyTitle")}
          description={t("previewPage.emptyDesc")}
          actionLabel={t("previewPage.cta")}
          actionHref="/builds/new"
        />
      </Card>
    </main>
  );
}
