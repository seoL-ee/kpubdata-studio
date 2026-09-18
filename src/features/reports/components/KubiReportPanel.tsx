/**
 * "7. Kubi 분석" 섹션 전용 패널 (#258 Kubi Report UX 수정).
 *
 * 지금까지는 `KubiContent compact` 전체 — API Key/Model/Base URL 설정, 데모 질문, 자유
 * 채팅까지 — 를 한 번에 펼쳐서 보여줬다. 이건 Reports 안에 Kubi 앱 전체를 그대로 삽입한
 * 모습이라 목적이 불분명하다. 이 패널은 그 대신 "현재 Report용 AI 해석 생성"만 기본으로
 * 보여주고, BYOK 설정/자유 채팅은 각각 [AI 설정]/[직접 질문하기]를 눌렀을 때만 펼친다.
 *
 * 새 provider/LLM/evidence pipeline이나 새 action contract를 만들지 않는다 — `useKubiSession`
 * (#256)을 그대로 재사용하고, preset은 그 위에 얹는 단순 질문 template일 뿐이다. 생성된
 * 답변을 Report에 반영하는 것도 기존 `KubiInterpretationBlock` 모양 그대로다(`kubiBlocks.ts`의
 * `reportNoteToBlock`과 같은 필드 구성) — 다만 이 패널은 이미 Report 편집 화면 안에 있으므로
 * reportInbox 큐를 거치지 않고 생성 → 미리보기 → 승인을 한 화면에서 끝낸다. 승인 전에는
 * Report에 아무것도 저장하지 않는다(`onApprove`를 호출하기 전까지는 로컬 미리보기일 뿐).
 *
 * context(datasetId/baseRunId)는 Report가 고정한 값이다. `useKubiSession`은 URL의
 * pathname+search에서 context를 읽으므로(`features/kubi/context.ts`), 이 패널이 mount되어
 * 있는 동안 URL이 항상 Report 기준 `?dataset=&run=`을 가리키도록 보정한다 — 최신 run으로
 * 자동 전환하지 않는다(#258 §8/§6과 동일 불변식).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAssistConfig } from "@/features/assistant/config";
import { ApiKeySetup, KubiContent } from "@/features/kubi/KubiContent";
import { useKubiSession } from "@/features/kubi/useKubiSession";
import type { KubiTurn } from "@/features/kubi/types";
import { i18n } from "@/shared/i18n";
import { Button, Card } from "@/shared/ui";
import { renderMarkdownToReact } from "../markdown";
import type { KubiInterpretationBlock, ReportDraft } from "../types";

interface Preset {
  id: string;
  label: string;
  question: string;
}

/** 종합 분석은 Primary CTA, 나머지 넷은 quick action이다(#258 §2-1). 새 action contract가
 * 아니라 `useKubiSession.ask/askDemo`에 그대로 넘길 질문 template일 뿐이다. */
/**
 * preset의 label은 버튼 문구고 question은 Kubi에 그대로 보내는 사용자 질문이다 —
 * 둘 다 화면 언어를 따른다. 영어로 보면서 한국어 질문이 나가면 답변도 한국어로 온다.
 * 상수로 고정하면 언어 전환이 반영되지 않으므로 호출 시점에 만든다.
 */
const COMPREHENSIVE_PRESET_ID = "comprehensive";
const QUICK_PRESET_IDS = ["quality", "pipeline", "ideas", "caveats"] as const;

function preset(id: string): Preset {
  return {
    id,
    label: i18n.t(`reports.kubiPanel.preset.${id}.label`),
    question: i18n.t(`reports.kubiPanel.preset.${id}.question`),
  };
}

function mockDisclaimer(): string {
  return i18n.t("reports.kubiPanel.mockDisclaimer");
}

function newBlockId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `kubi-${crypto.randomUUID()}`;
  return `kubi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** turn.context가 이 Report의 기준 dataset/run과 같은지(참고 분석과 정본 분석을 구분). */
function turnMatchesReport(turn: KubiTurn, report: Pick<ReportDraft, "datasetId" | "baseRunId">): boolean {
  return turn.context.datasetId === report.datasetId && turn.context.runId === report.baseRunId;
}

export function KubiReportPanel({
  report,
  onApprove,
}: {
  report: Pick<ReportDraft, "id" | "datasetId" | "baseRunId">;
  onApprove: (block: KubiInterpretationBlock) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const session = useKubiSession();
  const { isConfigured } = useAssistConfig();
  const comprehensive = preset(COMPREHENSIVE_PRESET_ID);
  const quickPresets = QUICK_PRESET_IDS.map((id) => preset(id));

  const [showByok, setShowByok] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null);

  // Report가 고정한 dataset/run을 URL에 계속 반영한다 — 최신 run으로 자동 전환하지 않는다
  // (#258 §8 불변식). 이미 일치하면 아무것도 하지 않는다(불필요한 history 갱신 방지).
  useEffect(() => {
    if (session.liveContext.datasetId === report.datasetId && session.liveContext.runId === report.baseRunId) {
      return;
    }
    const params = new URLSearchParams({ dataset: report.datasetId, run: report.baseRunId });
    navigate(`/reports/${encodeURIComponent(report.id)}?${params.toString()}`, { replace: true });
  }, [report.id, report.datasetId, report.baseRunId, session.liveContext.datasetId, session.liveContext.runId, navigate]);

  const isDemoMode = !isConfigured && session.isDemoAvailable;
  const canGenerate = isConfigured || session.isDemoAvailable;

  function generate(question: string) {
    setActiveQuestion(question);
    if (!isConfigured && session.isDemoAvailable) {
      void session.askDemo(question);
      return;
    }
    void session.ask(question);
  }

  // 이 Report 기준(context)으로 마지막에 생성을 요청한 turn만 미리보기로 보여준다. 다른
  // 화면/context에서 만든 turn과 섞지 않는다.
  const activeTurn = activeQuestion
    ? [...session.turns]
        .reverse()
        .find((turn) => turn.question === activeQuestion && turnMatchesReport(turn, report))
    : undefined;

  function approve() {
    if (!activeTurn?.response) return;
    const now = new Date().toISOString();
    const block: KubiInterpretationBlock = {
      id: newBlockId(),
      provenance: "KUBI_INTERPRETATION",
      note: activeTurn.response.answer,
      reason: activeTurn.isDemo
        ? t("reports.kubiPanel.reasonDemo")
        : t("reports.kubiPanel.reason"),
      sourceContext: {
        datasetId: activeTurn.context.datasetId,
        runId: activeTurn.context.runId,
        stage: activeTurn.context.stage,
      },
      isSameContext: turnMatchesReport(activeTurn, report),
      generatedAt: activeTurn.createdAt,
      createdAt: now,
      updatedAt: now,
    };
    onApprove(block);
    setActiveQuestion(null);
  }

  if (showChat) {
    return (
      <Card className="space-y-3" data-testid="kubi-report-chat">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t("reports.kubiPanel.chatTitle", {
              dataset: report.datasetId,
              run: report.baseRunId,
            })}
          </p>
          <Button size="sm" variant="ghost" onClick={() => setShowChat(false)}>
            {t("reports.kubiPanel.close")}
          </Button>
        </div>
        <KubiContent compact />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="kubi-report-panel">
      <p className="text-xs text-muted-foreground">
        {t("reports.kubiPanel.intro")}
      </p>

      {!isConfigured ? (
        <Card variant="dashed" className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs">
          <span className="text-foreground">{t("reports.kubiPanel.needsKey")}</span>
          <Button size="sm" variant="ghost" onClick={() => setShowByok((prev) => !prev)}>
            {t("reports.kubiPanel.openAiSettings")}
          </Button>
        </Card>
      ) : null}

      {showByok ? <ApiKeySetup /> : null}

      {isDemoMode ? (
        <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-800 dark:bg-violet-950/30 dark:text-violet-300">
          {mockDisclaimer()}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={!canGenerate}
          loading={activeTurn?.question === comprehensive.question && activeTurn.status === "loading"}
          onClick={() => generate(comprehensive.question)}
        >
          {isDemoMode ? t("reports.kubiPanel.generateDemo") : comprehensive.label}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {quickPresets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            disabled={!canGenerate}
            onClick={() => generate(preset.question)}
            className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <Button size="sm" variant="ghost" onClick={() => setShowChat(true)}>
          {t("reports.kubiPanel.askDirectly")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowByok((prev) => !prev)}>
          {t("reports.kubiPanel.aiSettings")}
        </Button>
      </div>

      {activeTurn ? (
        <Card className="space-y-2 border-indigo-200 dark:border-indigo-900/60" data-testid="kubi-report-preview">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{t("reports.block.kubiTitle")}</h3>
            {activeTurn.isDemo ? (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-800 dark:bg-violet-950/50 dark:text-violet-300">
                DEMO
              </span>
            ) : null}
          </div>

          {activeTurn.isDemo ? (
            <p className="text-xs font-medium text-violet-800 dark:text-violet-300">{mockDisclaimer()}</p>
          ) : null}

          {activeTurn.status === "loading" ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {t("reports.kubiPanel.generating")}
              <Button size="sm" variant="ghost" onClick={() => session.cancel(activeTurn.id)}>
                {t("reports.kubiPanel.cancel")}
              </Button>
            </div>
          ) : null}

          {activeTurn.status === "error" ? (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              {t("reports.kubiPanel.error")}
            </p>
          ) : null}

          {activeTurn.response ? (
            <>
              <div className="space-y-2 text-sm text-foreground">
                {renderMarkdownToReact(activeTurn.response.answer)}
              </div>
              <div className="text-xs text-muted-foreground">
                <p className="font-semibold uppercase tracking-wider">{t("reports.kubiPanel.evidence")}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  <li>Dataset: {report.datasetId}</li>
                  <li>Run: {report.baseRunId}</li>
                  {activeTurn.response.evidenceRefs.map((ref) => (
                    <li key={`${ref.kind}:${ref.id}`}>{ref.label}</li>
                  ))}
                </ul>
              </div>
            </>
          ) : null}

          {activeTurn.status !== "loading" ? (
            <div className="flex flex-wrap gap-2">
              {activeTurn.response ? (
                <Button size="sm" onClick={approve}>
                  {t("reports.kubiPanel.addToReport")}
                </Button>
              ) : null}
              <Button size="sm" variant="secondary" onClick={() => generate(activeTurn.question)}>
                {t("reports.kubiPanel.regenerate")}
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
