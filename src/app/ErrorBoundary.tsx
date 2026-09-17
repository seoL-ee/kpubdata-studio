/**
 * 앱 전역 React ErrorBoundary와 공통 오류 폴백 UI (#81).
 *
 * 렌더 중 발생한 예외가 SPA 전체를 빈 화면으로 만들지 않도록, 클래스 컴포넌트
 * `ErrorBoundary`가 하위 트리의 throw를 잡아 한국어 폴백 화면(새로고침 동작 포함)을
 * 보여준다. 동일한 폴백을 라우터 `errorElement`에서도 재사용한다.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useRouteError } from "react-router-dom";
import { i18n } from "@/shared/i18n";

/**
 * 오류 발생 시 보여줄 한국어 폴백 화면.
 *
 * @returns 새로고침 동작이 포함된 오류 안내 UI.
 */
export function ErrorFallback() {
  return (
    <main
      role="alert"
      className="flex min-h-screen flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center"
    >
      <p className="text-2xl font-semibold tracking-tight text-foreground">
        {i18n.t("errorBoundary.global.title")}
      </p>
      <p className="max-w-md text-sm leading-6 text-muted-foreground">
        {i18n.t("errorBoundary.global.desc")}
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center justify-center rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {i18n.t("errorBoundary.global.reload")}
      </button>
    </main>
  );
}

/**
 * 라우터 `errorElement`로 사용하는 오류 화면.
 *
 * 라우트 로더/액션/렌더 오류를 콘솔에 남기고 공통 폴백을 보여준다.
 *
 * @returns 오류 폴백 UI.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  console.error("Route error:", error);
  return <ErrorFallback />;
}

interface ErrorBoundaryProps {
  /** 보호할 하위 트리 */
  children: ReactNode;
}

interface ErrorBoundaryState {
  /** 하위 트리에서 예외가 발생했는지 여부 */
  hasError: boolean;
}

/**
 * 하위 트리의 렌더 예외를 잡아 폴백 UI로 대체하는 앱 전역 ErrorBoundary.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Uncaught render error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback />;
    }
    return this.props.children;
  }
}

/**
 * 단일 feature 영역에서만 보여줄 한국어 폴백 카드 (#97).
 *
 * 전역 폴백과 달리 화면 전체를 차지하지 않으며, 셸(사이드바/헤더)을 유지한 채 해당 feature
 * 영역만 오류 UI로 대체한다. 새로고침 대신 영역만 다시 그리는 ‘다시 시도’를 제공한다.
 *
 * @param feature - 오류가 난 기능의 i18n 키(예: "router.features.preview").
 * @param onRetry - 경계 상태를 초기화해 하위 트리를 다시 렌더하는 콜백.
 * @returns 영역 한정 오류 안내 UI.
 */
function FeatureErrorFallback({ feature, onRetry }: { feature: string; onRetry: () => void }) {
  return (
    <main
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center"
    >
      <p className="text-lg font-semibold tracking-tight text-foreground">
        {i18n.t("errorBoundary.feature.title", { feature: i18n.t(feature) })}
      </p>
      <p className="max-w-md text-sm leading-6 text-muted-foreground">
        {i18n.t("errorBoundary.feature.desc")}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center justify-center rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {i18n.t("errorBoundary.feature.retry")}
      </button>
    </main>
  );
}

interface FeatureErrorBoundaryProps {
  /** 폴백 메시지에 노출할 기능 이름의 i18n 키 */
  feature: string;
  /** 보호할 feature 하위 트리 */
  children: ReactNode;
}

/**
 * 개별 feature(라우트 세그먼트)의 렌더 예외를 잡아 해당 영역만 폴백으로 대체하는 경계 (#97).
 *
 * 전역 `ErrorBoundary`까지 버블업해 앱 전체가 빈 화면이 되는 것을 막아, 한 기능의 오류가
 * 나머지 셸(내비게이션/헤더)에 영향을 주지 않게 한다. ‘다시 시도’ 시 경계 상태만 초기화한다.
 */
export class FeatureErrorBoundary extends Component<
  FeatureErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Feature error (${this.props.feature}):`, error, info.componentStack);
  }

  private readonly handleRetry = () => this.setState({ hasError: false });

  render(): ReactNode {
    if (this.state.hasError) {
      return <FeatureErrorFallback feature={this.props.feature} onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}
