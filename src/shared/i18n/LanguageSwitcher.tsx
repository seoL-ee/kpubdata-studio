/**
 * 언어 전환 토글 — 한국어/English.
 *
 * 현재 언어를 버튼 라벨로 보여주고 클릭 시 지원 언어를 순회한다.
 * 선택은 i18next 감지 캐시(localStorage)에 저장되어 재방문 시 유지된다.
 */
import { useTranslation } from "react-i18next";

import {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  changeLanguage,
  normalizeLanguage,
  type AppLanguage,
} from "./index";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = normalizeLanguage(i18n.language);

  const next: AppLanguage =
    SUPPORTED_LANGUAGES[
      (SUPPORTED_LANGUAGES.indexOf(current) + 1) % SUPPORTED_LANGUAGES.length
    ];

  return (
    <button
      type="button"
      onClick={() => changeLanguage(next)}
      aria-label={t("languageSwitcher.switchTo", { language: LANGUAGE_LABELS[next] })}
      title={LANGUAGE_LABELS[next]}
      data-testid="language-switcher"
      data-current-language={current}
      className="rounded-md border border-base-300 px-2 py-1 text-xs text-base-600 transition-colors hover:bg-base-100 hover:text-base-900 dark:border-base-600 dark:text-base-300 dark:hover:bg-base-800"
    >
      {LANGUAGE_LABELS[current]}
    </button>
  );
}
