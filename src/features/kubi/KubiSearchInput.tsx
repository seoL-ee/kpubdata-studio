/**
 * 상단 Kubi 자연어 검색 입력 (#247, #256).
 *
 * 입력값을 여기서 직접 LLM에 보내지 않는다 — `useKubiSession`이 관리하는 대화에 질문을
 * "seed"로 남겨 두고 전역 drawer를 연다. 실제 evidence 조회/LLM 호출/구조화 응답 처리는
 * drawer(`KubiContent`)가 열리는 시점에 `useKubiSession`이 이어받는다. 여기서 결과를 임의로
 * 만들어내지 않는다 — hallucinated dataset을 만들지 않기 위함이다.
 */
import { useTranslation } from "react-i18next";
import { useState, type FormEvent } from "react";
import { useUIStore } from "@/shared/hooks/useUIStore";
import { useKubiStore } from "./useKubiSession";

export function KubiSearchInput() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const openKubiDrawer = useUIStore((state) => state.openKubiDrawer);
  const seedQuestion = useKubiStore((state) => state.seedQuestion);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed) seedQuestion(trimmed);
    setQuery("");
    openKubiDrawer();
  }

  return (
    <form
      role="search"
      onSubmit={handleSubmit}
      className="hidden min-w-0 max-w-md flex-1 items-center gap-2 rounded-lg border border-input bg-card px-3 py-2 text-sm text-muted-foreground focus-within:ring-2 focus-within:ring-ring sm:flex"
    >
      <span aria-hidden="true">🔍</span>
      <label className="sr-only" htmlFor="kubi-search">
        {t("kubi.search.label")}
      </label>
      <input
        className="w-full min-w-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        id="kubi-search"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("kubi.search.placeholder")}
        type="search"
        value={query}
      />
    </form>
  );
}
