import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { Layout } from "@/app/Layout";
import { useUIStore } from "@/shared/hooks/useUIStore";

function renderLayout() {
  return render(
    <MemoryRouter>
      <Layout />
    </MemoryRouter>,
  );
}

describe("Layout sidebar accessibility", () => {
  beforeEach(() => {
    // jsdom에는 matchMedia가 없으므로 system 테마 분기를 피하도록 light로 고정한다.
    act(() =>
      useUIStore.setState({
        theme: "light",
        isMobileSidebarOpen: false,
        isDesktopSidebarCollapsed: false,
        isKubiDrawerOpen: false,
      }),
    );
  });

  it("closes the open mobile sidebar when Escape is pressed", () => {
    renderLayout();

    // 마운트 시 closeMobileSidebar가 호출되므로, ESC 동작을 검증하기 위해 다시 연다.
    act(() => useUIStore.setState({ isMobileSidebarOpen: true }));
    expect(useUIStore.getState().isMobileSidebarOpen).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useUIStore.getState().isMobileSidebarOpen).toBe(false);
  });

  it("does not react to Escape when the mobile sidebar is already closed", () => {
    renderLayout();
    expect(useUIStore.getState().isMobileSidebarOpen).toBe(false);

    // desktop collapse가 켜져 있어도 ESC는 모바일 오버레이 전용이라 아무 영향이 없어야 한다.
    act(() => useUIStore.setState({ isDesktopSidebarCollapsed: true }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(useUIStore.getState().isMobileSidebarOpen).toBe(false);
    expect(useUIStore.getState().isDesktopSidebarCollapsed).toBe(true);
  });
});

describe("Layout 제품 문구 중복 제거", () => {
  beforeEach(() => {
    act(() =>
      useUIStore.setState({
        theme: "light",
        isMobileSidebarOpen: false,
        isDesktopSidebarCollapsed: false,
        isKubiDrawerOpen: false,
      }),
    );
  });

  it("sidebar에는 제품명만 남기고 tagline은 두지 않는다", () => {
    renderLayout();
    const aside = screen.getByRole("navigation").closest("aside")!;

    expect(within(aside).getByRole("link", { name: "KPubData Studio 홈" })).toBeInTheDocument();
    expect(within(aside).queryByText("공공데이터를 데이터셋으로 만드는 워크스페이스")).not.toBeInTheDocument();
  });

  it("topbar에는 workspace context tagline이 그대로 남는다", () => {
    renderLayout();
    const header = screen.getByRole("banner");

    expect(within(header).getByText("공공데이터를 데이터셋으로 만드는 워크스페이스")).toBeInTheDocument();
  });
});

describe("Layout desktop sidebar collapse (#247)", () => {
  beforeEach(() => {
    act(() =>
      useUIStore.setState({
        theme: "light",
        isMobileSidebarOpen: false,
        isDesktopSidebarCollapsed: false,
        isKubiDrawerOpen: false,
      }),
    );
  });

  it("starts expanded by default and exposes a desktop toggle distinct from the mobile one", () => {
    renderLayout();

    // 데스크톱 토글은 lg 이상에서만 보이는 버튼이지만 항상 DOM에 존재해 접근 가능해야 한다.
    expect(screen.getByRole("button", { name: "사이드바 접기" })).toBeInTheDocument();
    // 모바일 오버레이 토글과는 별개의 버튼이다.
    expect(screen.getByRole("button", { name: "사이드바 열기/닫기" })).toBeInTheDocument();
  });

  it("collapses on toggle click and can be expanded again", () => {
    renderLayout();

    fireEvent.click(screen.getByRole("button", { name: "사이드바 접기" }));
    expect(useUIStore.getState().isDesktopSidebarCollapsed).toBe(true);
    expect(screen.getByRole("button", { name: "사이드바 펼치기" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "사이드바 펼치기" }));
    expect(useUIStore.getState().isDesktopSidebarCollapsed).toBe(false);
    expect(screen.getByRole("button", { name: "사이드바 접기" })).toBeInTheDocument();
  });

  it("is a focusable native <button> so Enter/Space activate it via the browser's default keyboard handling", () => {
    renderLayout();
    const toggle = screen.getByRole("button", { name: "사이드바 접기" });

    // 다른 사이드바/헤더 버튼과 동일한 패턴: 커스텀 key 핸들러 없이 네이티브 <button>의 활성화
    // 동작(Enter/Space → click)에 의존한다. 실제 활성화 이벤트는 fireEvent.click으로 검증한다.
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle).not.toHaveAttribute("tabindex", "-1");

    toggle.focus();
    expect(toggle).toHaveFocus();

    fireEvent.click(toggle);
    expect(useUIStore.getState().isDesktopSidebarCollapsed).toBe(true);
  });

  it("shrinks the sidebar's own width and keeps the toggle reachable when collapsed", () => {
    renderLayout();
    const aside = screen.getByRole("navigation").closest("aside")!;

    expect(aside.className).toContain("lg:w-72");

    fireEvent.click(screen.getByRole("button", { name: "사이드바 접기" }));

    expect(aside.className).toContain("lg:w-20");
    expect(aside.className).not.toContain("lg:w-72");
    // 사이드바 링크는 collapsed 상태에서도 여전히 접근 가능해야 한다(텍스트는 시각적으로만 숨김).
    const nav = screen.getByRole("navigation");
    const homeLink = within(nav).getByRole("link", { name: "홈" });
    const homeIcon = within(homeLink).getByTestId("nav-icon-home");

    expect(homeLink).toBeInTheDocument();
    expect(homeIcon).toBeVisible();
    expect(homeIcon).not.toHaveClass("lg:sr-only");
    expect(homeIcon).toHaveAttribute("aria-hidden", "true");
  });

  it("restores the expanded width after collapsing then expanding again", () => {
    renderLayout();
    const aside = screen.getByRole("navigation").closest("aside")!;

    fireEvent.click(screen.getByRole("button", { name: "사이드바 접기" }));
    expect(aside.className).toContain("lg:w-20");

    fireEvent.click(screen.getByRole("button", { name: "사이드바 펼치기" }));
    expect(aside.className).toContain("lg:w-72");
    expect(aside.className).not.toContain("lg:w-20");
  });

  it("keeps mobile overlay state independent from desktop collapse state", () => {
    renderLayout();

    // 데스크톱 collapse를 켜도 모바일 오버레이는 열리지 않는다.
    fireEvent.click(screen.getByRole("button", { name: "사이드바 접기" }));
    expect(useUIStore.getState().isDesktopSidebarCollapsed).toBe(true);
    expect(useUIStore.getState().isMobileSidebarOpen).toBe(false);

    // 모바일 오버레이를 열어도 데스크톱 collapse 상태는 그대로 유지된다.
    fireEvent.click(screen.getByRole("button", { name: "사이드바 열기/닫기" }));
    expect(useUIStore.getState().isMobileSidebarOpen).toBe(true);
    expect(useUIStore.getState().isDesktopSidebarCollapsed).toBe(true);
  });
});
