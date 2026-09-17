/**
 * 어시스턴트 설정 상태 (#205, ST-A2).
 *
 * LLM API 키는 **기본 메모리 전용**. 인증 토큰과 달리 세션마다 재입력받으면
 * 마찰이 크므로 "이 브라우저에 저장" 옵트인을 명시적 경고와 함께 제공한다.
 * 기본값은 저장하지 않는 쪽이다.
 */
import { i18n } from "@/shared/i18n";
import { create } from "zustand";
import { checkLlmBaseUrl } from "./baseUrl";

const STORAGE_KEY = "kpubdata-assist-key";
const STORAGE_WARNING =
  i18n.t("assistant.config.persistWarning");

interface AssistConfigState {
  apiKey: string;
  model: string;
  baseUrl: string;
  persistToStorage: boolean;
  isConfigured: boolean;
  /** 이 config로 실제 요청을 보내도 되는지(#256 리뷰 §2 — HTTPS만 허용). */
  baseUrlSafe: boolean;
  /** 안전하지 않을 때 사용자에게 보여줄 사유. */
  baseUrlError?: string;
  /** 실제 요청에 쓰일 정규화된 base URL(빈 입력이면 기본값). */
  resolvedBaseUrl: string;
  /** 기본 Provider 주소를 그대로 쓰는지 — 아니면 UI가 경고를 보여준다. */
  isDefaultBaseUrl: boolean;
  setConfig: (config: { apiKey: string; model?: string; baseUrl?: string }) => void;
  enablePersistence: () => void;
  disablePersistence: () => void;
  clear: () => void;
}

function baseUrlFields(baseUrl: string) {
  const check = checkLlmBaseUrl(baseUrl);
  return {
    baseUrlSafe: check.safe,
    baseUrlError: check.reason,
    resolvedBaseUrl: check.resolvedUrl,
    isDefaultBaseUrl: check.isDefault,
  };
}

function _loadPersistedKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function savePersistedKey(key: string): void {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage 접근 실패(SSR/프라이빗 모드)는 무시
  }
}

export const useAssistConfig = create<AssistConfigState>((set, get) => ({
  apiKey: "",
  model: "",
  baseUrl: "",
  persistToStorage: false,
  isConfigured: false,
  ...baseUrlFields(""),
  setConfig: (config) => {
    const baseUrl = config.baseUrl ?? "";
    set({
      apiKey: config.apiKey,
      model: config.model ?? "",
      baseUrl,
      isConfigured: config.apiKey.length > 0,
      ...baseUrlFields(baseUrl),
    });
    if (get().persistToStorage) savePersistedKey(config.apiKey);
  },
  enablePersistence: () => {
    if (typeof window !== "undefined" && window.confirm(STORAGE_WARNING)) {
      set({ persistToStorage: true });
      savePersistedKey(get().apiKey);
    }
  },
  disablePersistence: () => {
    set({ persistToStorage: false });
    savePersistedKey("");
  },
  clear: () => {
    set({ apiKey: "", isConfigured: false });
    savePersistedKey("");
  },
}));

// 옵트인한 경우에만 시작 시 로드
if (typeof window !== "undefined") {
  try {
    const persisted = localStorage.getItem(STORAGE_KEY);
    if (persisted) {
      useAssistConfig.setState({
        apiKey: persisted,
        isConfigured: true,
        persistToStorage: true,
      });
    }
  } catch {
    // 무시
  }
}
