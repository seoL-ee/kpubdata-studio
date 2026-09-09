/**
 * LanguageSwitcher 단위 테스트 — 토글 동작과 언어별 라벨 렌더링을 검증한다.
 */
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { i18n } from "./index";
import { LanguageSwitcher } from "./LanguageSwitcher";

describe("LanguageSwitcher (#i18n)", () => {
  beforeEach(() => {
    void i18n.changeLanguage("ko");
  });

  it("현재 언어(ko) 라벨을 보여준다", () => {
    render(<LanguageSwitcher />);
    expect(screen.getByTestId("language-switcher").textContent).toBe("한국어");
  });

  it("클릭하면 en으로 전환되고 라벨이 바뀐다", () => {
    render(<LanguageSwitcher />);
    const button = screen.getByTestId("language-switcher");
    act(() => {
      button.click();
    });
    expect(i18n.language).toBe("en");
    expect(screen.getByTestId("language-switcher").textContent).toBe("English");
    expect(screen.getByTestId("language-switcher").dataset.currentLanguage).toBe("en");
  });

  it("en에서 다시 클릭하면 ko로 돌아온다", () => {
    void i18n.changeLanguage("en");
    render(<LanguageSwitcher />);
    act(() => {
      screen.getByTestId("language-switcher").click();
    });
    expect(i18n.language).toBe("ko");
    expect(i18n.hasResourceBundle("en", "translation")).toBe(true);
  });

  it("ko/en 키 집합이 동일해야 한다(누락 번역 방지)", async () => {
    const { flattenForTest: flatten } = await import("./flattenForTest");
    const ko = (await import("./locales/ko.json")).default;
    const en = (await import("./locales/en.json")).default;
    expect([...flatten(en)].sort()).toEqual([...flatten(ko)].sort());
  });
});
