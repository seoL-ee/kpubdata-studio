/**
 * Builds/Runs "이 Run 분석" inline 결과 카드 (#255 §3).
 *
 * 전역 Kubi drawer를 자동으로 열지 않는다 — Selected Run의 Pipeline/Quality/Events를 같이
 * 보면서 확인해야 하는 문맥이라, 같은 화면 안에서 답을 보여준다. 새 Kubi 엔진/store/context를
 * 만들지 않고 기존 `useKubiSession`(#256)을 그대로 재사용한다: 이 카드가 mount되는 시점에
 * BuildsPage가 이미 세팅해 둔 `seedQuestion`을 `useKubiSession`의 기존 pending-seed 소비
 * effect가 그대로 집어가 `ask()`를 실행한다.
 *
 * 표시할 turn은 "가장 최근이면서 현재 route context와 일치하는(=stale 아닌) turn" 하나뿐이다
 * (#256 stale-context guard). Run을 바꾸면 BuildsPage가 이 카드 자체를 닫으므로, 이전 Run의
 * 결과가 새 Run의 context에서 유효한 것처럼 보이는 일은 없다.
 */
import { useMemo } from "react";
import { useAssistConfig } from "@/features/assistant/config";
import { ErrorNotice, EvidenceSection } from "@/features/kubi/KubiContent";
import { MarkdownContent } from "@/features/kubi/MarkdownContent";
import { useKubiSession } from "@/features/kubi/useKubiSession";
import { Button, Card } from "@/shared/ui";
import { useTranslation } from "react-i18next";

export interface KubiRunAnalysisProps {
  onClose: () => void;
  /** "더 질문하기" — 이 경우에만 기존 전역 Kubi drawer를 연다. */
  onAskMore: () => void;
}

/** Selected Run summary 바로 아래, Pipeline/Stage Progress 위에 표시되는 inline Kubi 분석 카드. */
export function KubiRunAnalysis({ onClose, onAskMore }: KubiRunAnalysisProps) {
  const { t } = useTranslation();
  const session = useKubiSession();
  const { isConfigured } = useAssistConfig();
  // API Key 미설정 상태를 최우선으로 처리한다 — session.isDemoAvailable(mock Builder 모드에서
  // 항상 true)로 우회하지 않는다. pending seed는 항상 useKubiSession의 일반 ask()로 소비되고
  // ask()는 isConfigured만 보고 no_key 여부를 판정하므로, 이 카드의 canAsk 판단도 정확히
  // 그 기준(isConfigured)에 맞춰야 seed 후 no_key 에러가 뜨는 상황을 미리 막을 수 있다.
  const canAsk = isConfigured;

  // 현재 route context(=이 Run)와 일치하는 가장 최근 turn만 보여준다 — 다른 화면/이전 run에서
  // 만든 turn과 섞지 않는다(#256 stale-context guard, KubiContent의 ContextBar와 동일 원칙).
  const turn = useMemo(() => {
    for (let i = session.turns.length - 1; i >= 0; i -= 1) {
      const candidate = session.turns[i];
      if (!session.isStale(candidate)) return candidate;
    }
    return null;
  }, [session.turns, session.isStale]);

  return (
    <Card className="border-accent/50">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("kubi.runAnalysis.title")}</h3>
        <button type="button" onClick={onClose} className="text-xs font-medium text-muted-foreground underline">
          {t("kubi.runAnalysis.close")}
        </button>
      </div>

      {!canAsk ? (
        // API Key 미설정 — no_key ErrorNotice를 렌더링할 일 자체가 없다(seed 자체를 안 하므로
        // turn이 생기지 않는다). API Key 입력 UI를 여기 복제하지 않고, 기존 Kubi Drawer로
        // 안내만 한다. 이 상태에서는 "더 질문하기"도 보여주지 않는다(아래에서 canAsk로 게이팅).
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">{t("kubi.runAnalysis.needsKey")}</p>
          <Button size="sm" variant="secondary" onClick={onAskMore}>
            {t("kubi.runAnalysis.openSettings")}
          </Button>
        </div>
      ) : (
        <>
          {!turn ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {t("kubi.runAnalysis.preparing")}
            </div>
          ) : (
            <div className="mt-3 space-y-2.5 text-sm">
              {turn.status === "loading" ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {t("kubi.runAnalysis.thinking")}
                  <Button size="sm" variant="ghost" onClick={() => session.cancel(turn.id)}>
                    {t("kubi.runAnalysis.cancel")}
                  </Button>
                </div>
              ) : null}

              {turn.status === "error" && turn.error ? <ErrorNotice error={turn.error} /> : null}

              {turn.response ? (
                <>
                  {/* Drawer(KubiContent)와 동일한 안전 Markdown 렌더러를 재사용한다(#320). */}
                  <MarkdownContent>{turn.response.answer}</MarkdownContent>

                  {/* status가 "ok"여도 cross-check가 근거/action/SQL을 제외했으면 그 사실을
                      숨기지 않는다 — KubiContent와 동일한 경고 + EvidenceSection 표현을 쓴다.
                      status === "error" 전용 ErrorNotice(위)와는 별개다. */}
                  {turn.error?.kind === "hallucinated_refs" ? (
                    <p role="alert" className="text-[11px] text-amber-700 dark:text-amber-400">
                      {turn.error.message}
                    </p>
                  ) : null}

                  <EvidenceSection turn={turn} />
                </>
              ) : null}
            </div>
          )}

          <div className="mt-3">
            <Button size="sm" variant="secondary" onClick={onAskMore}>
              {t("kubi.runAnalysis.askMore")}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
