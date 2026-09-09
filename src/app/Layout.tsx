/**
 * Studio의 공통 앱 셸과 내비게이션 레이아웃을 정의하는 파일.
 *
 * 좌측 grouped 사이드바, 상단 헤더(Kubi 검색·Kubi 버튼·avatar), 테마 전환, 모바일 오버레이,
 * 전역 Kubi drawer mount를 한곳에서 관리하며 실제 라우트 콘텐츠는 `Outlet`을 통해 주입한다.
 * 메뉴 구성은 `kpubdata_ui_prototype_v1.html` IA(WORKSPACE/DATA/AI/SYSTEM)를 따른다(#247).
 */
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { LanguageSwitcher } from "@/shared/i18n/LanguageSwitcher";
import { useAuthStore } from "@/features/auth/store";
import { KubiDrawer } from "@/features/kubi/KubiDrawer";
import { KubiSearchInput } from "@/features/kubi/KubiSearchInput";
import { useUIStore } from "@/shared/hooks/useUIStore";

const sidebarLogoUrl = new URL("../../assets/logo/kpubdata-brand-assets/svg/horizontal_dark.svg", import.meta.url).href;
const sidebarSymbolUrl = new URL("../../assets/logo/kpubdata-brand-assets/svg/sidebar_dark.svg", import.meta.url).href;

/**
 * 현재 라우트에 맞는 헤더 CTA(라벨/이동 경로)를 고른다(제안 §6.4).
 *
 * 새 빌드 작성 화면에서는 중복되는 '새 빌드 만들기' 대신 '빌드 목록'으로 안내하고,
 * 그 외 화면에서는 새 빌드 작성으로 유도한다. 새 IA의 Discover/Add Data/Quality 등 신규
 * placeholder 화면은 이 조건들과 겹치지 않으므로 그대로 기본값(새 빌드 만들기)을 받는다(#247).
 *
 * @param pathname - 현재 경로.
 * @returns 헤더 CTA의 라벨과 이동 경로.
 */
function headerCtaFor(
  pathname: string,
  t: (key: string) => string,
): { to: string; label: string } {
  if (pathname === "/builds/new") return { to: "/builds", label: t("header.buildList") };
  if (pathname.startsWith("/builds/") && pathname.endsWith("/run"))
    return { to: pathname.replace(/\/run$/, "/artifacts"), label: t("header.viewArtifacts") };
  return { to: "/builds/new", label: t("header.newBuild") };
}

interface NavItem {
  /** 이동 경로 */
  to: string;
  /** 사이드바에 표시할 라벨 */
  label: string;
  /** 링크 title(hover 설명) */
  description: string;
  /** collapsed 상태에서도 메뉴를 식별할 수 있게 항상 표시하는 아이콘 */
  icon: ReactNode;
  /** index 라우트처럼 정확히 일치할 때만 active로 표시할지 여부 */
  end?: boolean;
}

interface SidebarIconProps {
  /** 테스트와 디버깅에서 아이콘을 식별할 이름 */
  name: string;
  /** 아이콘을 그리는 SVG 요소 */
  children: ReactNode;
}

/** 새 아이콘 의존성 없이 사이드바에서 공통으로 쓰는 선형 SVG 아이콘이다. */
function SidebarIcon({ name, children }: SidebarIconProps) {
  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center"
      data-testid={`nav-icon-${name}`}
    >
      <svg
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
        viewBox="0 0 24 24"
      >
        {children}
      </svg>
    </span>
  );
}

interface NavGroup {
  /** 그룹 헤더 라벨(대문자 표기, 프로토타입 IA와 동일) */
  label: string;
  items: NavItem[];
}

// 최종 IA(WORKSPACE/DATA/AI/SYSTEM)를 그대로 반영한 grouped nav model이다(#247).
// New Build Wizard(`/builds/new`)는 메뉴에서 제거됐지만 route와 헤더 CTA에서는 계속 쓰인다 —
// Add Data Workbench(#250)가 이를 흡수하기 전까지는 유일한 실제 빌드 생성 흐름이기 때문이다.
function buildNavGroups(t: (key: string) => string): NavGroup[] {
  return [
  {
    label: t("nav.groupWorkspace"),
    items: [
      {
        to: "/",
        label: t("nav.home"),
        description: t("navDescription.home"),
        end: true,
        icon: (
          <SidebarIcon name="home">
            <path d="m3 11 9-8 9 8" />
            <path d="M5 10v10h14V10M9 20v-6h6v6" />
          </SidebarIcon>
        ),
      },
      {
        to: "/discover",
        label: t("nav.discover"),
        description: t("navDescription.discover"),
        icon: (
          <SidebarIcon name="discover">
            <circle cx="12" cy="12" r="9" />
            <path d="m15 9-2 4-4 2 2-4 4-2Z" />
          </SidebarIcon>
        ),
      },
      {
        to: "/workspace",
        label: t("nav.workspace"),
        description: t("navDescription.workspace"),
        icon: (
          <SidebarIcon name="workspace">
            <rect width="16" height="14" x="4" y="6" rx="2" />
            <path d="M9 6V4h6v2M4 11h16" />
          </SidebarIcon>
        ),
      },
    ],
  },
  {
    label: t("nav.groupData"),
    items: [
      {
        to: "/add",
        label: t("nav.addData"),
        description: t("navDescription.addData"),
        icon: (
          <SidebarIcon name="add">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v8M8 12h8" />
          </SidebarIcon>
        ),
      },
      {
        to: "/datasets",
        label: t("nav.datasets"),
        description: t("navDescription.datasets"),
        icon: (
          <SidebarIcon name="datasets">
            <ellipse cx="12" cy="5" rx="7" ry="3" />
            <path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
          </SidebarIcon>
        ),
      },
      {
        to: "/builds",
        label: t("nav.builds"),
        description: t("navDescription.builds"),
        icon: (
          <SidebarIcon name="builds">
            <circle cx="12" cy="12" r="9" />
            <path d="m10 8 6 4-6 4V8Z" />
          </SidebarIcon>
        ),
      },
      {
        to: "/quality",
        label: t("nav.quality"),
        description: t("navDescription.quality"),
        icon: (
          <SidebarIcon name="quality">
            <circle cx="12" cy="12" r="9" />
            <path d="m8 12 3 3 5-6" />
          </SidebarIcon>
        ),
      },
    ],
  },
  {
    label: t("nav.groupAi"),
    items: [
      {
        to: "/kubi",
        label: t("nav.kubi"),
        description: t("navDescription.kubi"),
        icon: (
          <SidebarIcon name="kubi">
            <rect width="14" height="12" x="5" y="7" rx="3" />
            <path d="M12 3v4M9 12h.01M15 12h.01M9 16h6" />
          </SidebarIcon>
        ),
      },
      {
        to: "/reports",
        label: t("nav.reports"),
        description: t("navDescription.reports"),
        icon: (
          <SidebarIcon name="reports">
            <path d="M6 3h9l3 3v15H6V3Z" />
            <path d="M14 3v4h4M9 12h6M9 16h6" />
          </SidebarIcon>
        ),
      },
    ],
  },
  {
    label: t("nav.groupSystem"),
    items: [
      {
        to: "/provider",
        label: t("nav.provider"),
        description: t("navDescription.provider"),
        icon: (
          <SidebarIcon name="provider">
            <path d="M4 21V7l8-4 8 4v14M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01" />
          </SidebarIcon>
        ),
      },
      {
        to: "/monitoring",
        label: t("nav.monitoring"),
        description: t("navDescription.monitoring"),
        icon: (
          <SidebarIcon name="monitoring">
            <path d="M3 12h4l2-5 4 10 2-5h6" />
          </SidebarIcon>
        ),
      },
    ],
  },
  ];
}

/**
 * 현재 테마 모드에 대응하는 DOM 테마 값.
 *
 * @param theme - UI 스토어에 저장된 현재 테마 모드.
 * @returns DOM `data-theme` 속성에 기록할 최종 테마 값.
 */
function getResolvedTheme(theme: ReturnType<typeof useUIStore.getState>["theme"]):
  | "light"
  | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  return theme;
}

/**
 * 사이드바 링크의 활성/비활성 상태에 맞는 공통 Tailwind 클래스를 만든다.
 *
 * @param isActive - 현재 라우트와 링크가 일치하는지 여부.
 * @returns 시각 상태가 반영된 클래스 문자열.
 */
function navigationClassName({ isActive }: { isActive: boolean }) {
  return [
    "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
    isActive
      ? "bg-sidebar-active text-sidebar-active-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-active-foreground",
  ].join(" ");
}

/**
 * 로그인된 이메일에서 avatar에 표시할 이니셜 한 글자를 뽑는다.
 *
 * 로그인 전이거나 이메일이 없으면 물음표를 보여줘 "아직 로그인하지 않음"을 드러낸다.
 * 실제 avatar 메뉴/프로필 화면은 #263(Email/Password Auth)에서 이 상태를 이어받는다.
 *
 * @param email - 로그인된 사용자 이메일(없으면 `null`).
 * @returns avatar에 표시할 한 글자.
 */
function avatarInitial(email: string | null): string {
  return email ? email.charAt(0).toUpperCase() : "?";
}

/**
 * Studio 모든 페이지에 공통으로 적용되는 앱 셸 컴포넌트.
 *
 * @returns 사이드바, 헤더, 본문 슬롯, 전역 Kubi drawer를 포함한 전체 레이아웃.
 */
export function Layout() {
  const { t } = useTranslation();
  const navGroups = buildNavGroups(t);
  const closeMobileSidebar = useUIStore((state) => state.closeMobileSidebar);
  const isMobileSidebarOpen = useUIStore((state) => state.isMobileSidebarOpen);
  const isDesktopSidebarCollapsed = useUIStore((state) => state.isDesktopSidebarCollapsed);
  const openKubiDrawer = useUIStore((state) => state.openKubiDrawer);
  const setTheme = useUIStore((state) => state.setTheme);
  const theme = useUIStore((state) => state.theme);
  const toggleMobileSidebar = useUIStore((state) => state.toggleMobileSidebar);
  const toggleDesktopSidebarCollapsed = useUIStore(
    (state) => state.toggleDesktopSidebarCollapsed,
  );
  const email = useAuthStore((state) => state.email);
  const { pathname } = useLocation();
  const headerCta = headerCtaFor(pathname, t);

  useEffect(() => {
    document.documentElement.dataset.theme = getResolvedTheme(theme);
  }, [theme]);

  useEffect(() => {
    closeMobileSidebar();
  }, [closeMobileSidebar]);

  // 모바일 사이드바가 열려 있을 때 ESC로 닫을 수 있게 한다(접근성, 제안 §12.2).
  // 데스크톱 collapse는 오버레이가 아니므로 ESC 대상이 아니다 — 이 핸들러는 모바일 상태만 본다.
  // Kubi drawer의 ESC 처리는 drawer 자신이 열려 있을 때만 담당한다(KubiDrawer 참고).
  useEffect(() => {
    if (!isMobileSidebarOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMobileSidebar();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isMobileSidebarOpen, closeMobileSidebar]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen">
        {isMobileSidebarOpen ? (
          <button
            aria-label="내비게이션 닫기"
            className="fixed inset-0 z-30 bg-zinc-950/45 lg:hidden"
            onClick={closeMobileSidebar}
            type="button"
          />
        ) : null}

          <aside
            data-tour="sidebar"
          className={[
            "fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar px-4 py-5 text-sidebar-foreground transition-all lg:static lg:translate-x-0",
            isMobileSidebarOpen ? "translate-x-0" : "-translate-x-full",
            isDesktopSidebarCollapsed ? "lg:w-20 lg:px-2" : "lg:w-72",
          ].join(" ")}
        >
          <div className="flex items-start justify-between gap-3 pb-5">
            <div>
              <div className="flex items-center gap-2">
                <Link aria-label="KPubData Studio 홈" className="flex min-w-0 items-center" to="/">
                  <img
                    alt="KPubData Studio"
                    className={["w-[156px] max-w-full", isDesktopSidebarCollapsed ? "lg:hidden" : ""].join(" ")}
                    src={sidebarLogoUrl}
                  />
                  <img
                    alt="KPubData Studio"
                    className={["hidden h-8 w-8", isDesktopSidebarCollapsed ? "lg:block" : ""].join(" ")}
                    src={sidebarSymbolUrl}
                  />
                </Link>
              </div>
              {/* tagline은 Topbar가 workspace/product context를 담당하므로 Sidebar에서는
                  제품명/로고만 유지한다(중복 제거). */}
            </div>
            <button
              aria-label="사이드바 닫기"
              className="rounded-lg border border-sidebar-border p-1.5 text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-active-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar lg:hidden"
              onClick={closeMobileSidebar}
              type="button"
            >
              ✕
            </button>
            {/* 데스크톱 전용 접기/펼치기 토글 — 모바일 닫기 버튼과 반대로 lg 이상에서만 노출되어
                항상 접근 가능하다(#247). collapsed 상태에서도 이 버튼 자체는 숨지 않는다. */}
            <button
              aria-label={isDesktopSidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기"}
              className="hidden shrink-0 rounded-lg border border-sidebar-border p-1.5 text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-active-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar lg:inline-flex"
              onClick={toggleDesktopSidebarCollapsed}
              type="button"
            >
              {isDesktopSidebarCollapsed ? "»" : "«"}
            </button>
          </div>

          <nav className="mt-2 flex flex-1 flex-col gap-5">
            {navGroups.map((group) => (
              <div key={group.label}>
                <p
                  className={[
                    "px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-sidebar-muted",
                    isDesktopSidebarCollapsed ? "lg:sr-only" : "",
                  ].join(" ")}
                >
                  {group.label}
                </p>
                <div className="space-y-1">
                  {group.items.map((item) => (
                    <NavLink
                      className={navigationClassName}
                      end={item.end}
                      key={item.to}
                      onClick={closeMobileSidebar}
                      title={item.description}
                      to={item.to}
                    >
                      {item.icon}
                      <span className={isDesktopSidebarCollapsed ? "lg:sr-only" : undefined}>
                        {item.label}
                      </span>
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}

            <div className="mt-auto space-y-1 border-t border-sidebar-border pt-3">
              <NavLink
                className={navigationClassName}
                onClick={closeMobileSidebar}
                title={t("navDescription.settings")}
                to="/settings"
              >
                <SidebarIcon name="settings">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1A7 7 0 0 0 15 6l-.3-2.5h-4L10.4 6a7 7 0 0 0-1.7 1L6.5 6 4.5 9.5 6.5 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1A7 7 0 0 0 10.4 18l.3 2.5h4L15 18a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" />
                </SidebarIcon>
                <span className={isDesktopSidebarCollapsed ? "lg:sr-only" : undefined}>
                  {t("nav.settings")}
                </span>
              </NavLink>
            </div>
          </nav>

          <div
            className={[
              "mt-4 rounded-lg border border-sidebar-border bg-sidebar-hover p-3",
              isDesktopSidebarCollapsed ? "lg:sr-only" : "",
            ].join(" ")}
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">테마</p>
              <select
                aria-label="테마 선택"
                className="rounded-lg border border-sidebar-border bg-sidebar px-2.5 py-1.5 text-sm text-sidebar-foreground"
                onChange={(event) => setTheme(event.target.value as "system" | "light" | "dark")}
                value={theme}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          </div>
        </aside>

        <div className="flex min-h-screen min-w-0 flex-1 flex-col lg:pl-0">
          <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 sm:px-8">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  aria-label="사이드바 열기/닫기"
                  className="inline-flex rounded-lg border border-border bg-card p-2 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:hidden"
                  onClick={toggleMobileSidebar}
                  type="button"
                >
                  ☰
                </button>
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    KPubData Studio
                  </p>
                  <h1 className="truncate text-base font-semibold tracking-tight">
                    공공데이터를 데이터셋으로 만드는 워크스페이스
                  </h1>
                </div>
              </div>

              {/* min-w-0가 여기 있으면 이 그룹의 최소너비 보호가 사라져 flex-shrink 계산에서
                  이 그룹이 자기 컨텐츠(Kubi 버튼/avatar)보다 더 작게 줄어들 수 있다 — 그 안의
                  버튼들은 title처럼 truncate로 줄어들 수 있는 요소가 아니라 overflow로 그대로
                  삐져나와 왼쪽 subtitle과 겹쳤다(390px 폭, UI audit #6-A). min-w-0를 빼서 이
                  그룹이 자기 컨텐츠의 min-content보다 작아지지 않게 하고, truncate가 적용된
                  title 쪽(왼쪽 그룹)이 필요한 만큼 대신 줄어들게 한다. */}
              <div className="flex flex-1 items-center justify-end gap-2 sm:gap-3">
                <KubiSearchInput />

                <button
                  aria-haspopup="dialog"
                  aria-label="Kubi 열기"
                  className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  onClick={openKubiDrawer}
                  type="button"
                >
                  <span aria-hidden="true">✨</span>
                  <span className="hidden sm:inline">Kubi</span>
                </button>

                <LanguageSwitcher />

                <Link
                  className="hidden rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background md:inline-flex"
                  to={headerCta.to}
                >
                  {headerCta.label}
                </Link>

                {/* avatar 진입점 — #263에서 실제 프로필/로그아웃 메뉴로 확장될 구조(#247). */}
                <Link
                  aria-label={email ? `${email} 설정으로 이동` : "로그인이 필요합니다 — 설정으로 이동"}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-sm font-semibold text-foreground hover:bg-accent-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  title={email ?? "로그인이 필요합니다"}
                  to="/settings"
                >
                  {avatarInitial(email)}
                </Link>
              </div>
            </div>
          </header>

          <Outlet />
        </div>
      </div>

      <KubiDrawer />
    </div>
  );
}
