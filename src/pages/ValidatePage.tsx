/**
 * 검증 결과 페이지 (/validate, 레거시 딥링크).
 *
 * 검증은 New Build 마법사에 통합되어 있지만, 이 페이지에서 어시스턴트(ST-A5)를
 * 통해 검증 오류 설명과 수정 제안을 받을 수 있다.
 */
import { useTranslation } from "react-i18next";
import { Card, EmptyState, PageHeader } from "@/shared/ui";
import { AssistantChat } from "@/features/assistant/AssistantChat";

export function ValidatePage() {
  const { t } = useTranslation();
  return (
    <main className="flex flex-1 flex-col gap-6 px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        eyebrow={t("validatePage.eyebrow")}
        title={t("validatePage.title")}
        description={t("validatePage.desc")}
      />

      <Card className="p-0">
        <EmptyState
          title={t("validatePage.emptyTitle")}
          description={t("validatePage.emptyDesc")}
          actionLabel={t("validatePage.cta")}
          actionHref="/builds/new"
        />
      </Card>

      <AssistantChat />
    </main>
  );
}
