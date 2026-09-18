/**
 * LLM base URL 안전장치 (#256 리뷰 §2).
 *
 * BYOK는 사용자가 직접 base URL을 바꿀 수 있어, API key가 잘못된(또는 악의적인) 서버로
 * 전송될 위험이 있다. Studio는 별도 provider 시스템을 새로 설계하지 않고, key exfiltration을
 * 막는 최소 안전장치만 둔다: 기본 주소는 고정 안전값, 사용자가 바꾸면 HTTPS만 허용하고
 * 화면에 어떤 주소로 전송되는지 항상 보여준다(§2 "API Key가 전송되는 주소를 확인할 수 있어야
 * 합니다").
 */

/** BYOK 기본 LLM base URL. `provider.ts`의 DEFAULT_BASE_URL과 반드시 같은 값을 유지한다. */
import { i18n } from "@/shared/i18n";

export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";

export interface BaseUrlCheck {
  /** 요청을 보내도 되는 주소인지 여부 */
  safe: boolean;
  /** safe=false일 때 사용자에게 보여줄 사유 */
  reason?: string;
  /** 실제 요청 시 사용할 정규화된 URL(빈 입력이면 기본값) */
  resolvedUrl: string;
  /** 기본 주소를 그대로 쓰는지 여부(아니면 UI가 경고를 보여줘야 함) */
  isDefault: boolean;
}

/**
 * 사용자가 입력한 base URL이 안전하게 사용할 수 있는 값인지 검사한다.
 *
 * @param rawUrl - 설정 화면에서 입력한 base URL(빈 문자열이면 기본값 사용).
 * @returns 안전 여부, 사유, 정규화된 URL.
 */
export function checkLlmBaseUrl(rawUrl: string): BaseUrlCheck {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { safe: true, resolvedUrl: DEFAULT_LLM_BASE_URL, isDefault: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      safe: false,
      reason: i18n.t("assistant.baseUrl.invalid"),
      resolvedUrl: trimmed,
      isDefault: false,
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      safe: false,
      reason: i18n.t("assistant.baseUrl.httpsOnly"),
      resolvedUrl: trimmed,
      isDefault: false,
    };
  }

  const normalized = trimmed.replace(/\/+$/, "");
  return {
    safe: true,
    resolvedUrl: normalized,
    isDefault: normalized === DEFAULT_LLM_BASE_URL.replace(/\/+$/, ""),
  };
}

/** 오류 메시지/로그에 API key가 그대로 남지 않도록 알려진 key 값을 치환한다. */
export function redactApiKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join("[REDACTED]");
}
