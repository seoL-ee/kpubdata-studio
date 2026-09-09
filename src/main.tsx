/**
 * Vite 기반 KPubData Studio 애플리케이션의 브라우저 진입점.
 *
 * DOM에서 루트 컨테이너를 찾은 뒤 React 19 `createRoot` API로 앱을 마운트한다.
 * 개발 중 부작용을 더 엄격하게 확인하기 위해 `StrictMode`로 전체 앱을 감싼다.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { initAuth } from "@/features/auth/init";
import "@/shared/i18n"; // 다국어 초기화(사이드 이펙트 — App보다 먼저)
import "./globals.css";

const faviconUrl = new URL("../assets/logo/kpubdata-brand-assets/svg/favicon.svg", import.meta.url).href;
const faviconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement("link");
faviconLink.rel = "icon";
faviconLink.href = faviconUrl;
if (!faviconLink.parentNode) document.head.append(faviconLink);

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root container not found");
}

initAuth();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
