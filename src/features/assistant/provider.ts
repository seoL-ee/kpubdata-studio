/**
 * BuildSpec 어시스턴트 — LLM 호출 추상화 (#205, ST-A2).
 *
 * Studio는 정적 SPA라 서버가 없다. v1은 BYOK(Bring Your Own Key)로
 * 사용자가 Settings에서 자기 API 키를 입력하고 브라우저가 LLM API를 직접 호출한다.
 *
 * **공용 키를 VITE_*로 주입하는 것은 절대 금지** — 번들에 평문으로 박힌다.
 */
import { i18n } from "@/shared/i18n";
import { createSecretScrubber, type SecretScrubber } from "./scrub";

import { checkLlmBaseUrl, redactApiKey, DEFAULT_LLM_BASE_URL } from "./baseUrl";

export interface AssistExchangeOptions {
  /**
   * generic 엔트로피 오탐에서만 면제할 exact 값 집합(현재는 Kubi가 evidence에서 확인한
   * run id). LLM egress 스크러버(prepareMessages → scrubText/scrub)까지 그대로 전달돼
   * canonical run id가 `[REDACTED]`되지 않게 한다. 넘기지 않으면 기존과 동일 동작.
   */
  safeRunIds?: ReadonlySet<string>;
}

export interface AssistMessage {
  role: "system" | "user" | "assistant";
  content: string;
  structuredContent?: unknown;
}

export interface AssistExchange {
  readonly output: AsyncIterable<string>;
  readonly displayOutput: AsyncIterable<string>;
  readonly hadSecrets: boolean;
  restoreText(text: string): string;
}

const SAFE_PROVIDER: unique symbol = Symbol("safe-assist-provider");

export interface AssistProvider {
  readonly [SAFE_PROVIDER]: true;
  exchange(messages: AssistMessage[], signal?: AbortSignal, options?: AssistExchangeOptions): AssistExchange;
  stream(messages: AssistMessage[], signal?: AbortSignal, options?: AssistExchangeOptions): AsyncIterable<string>;
  readonly isConfigured: boolean;
}

export interface AssistConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = DEFAULT_LLM_BASE_URL;

/**
 * LLM 서버가 돌려준 HTTP 오류를 안전한 고정 메시지로 바꾼다(#256 리뷰 §2).
 *
 * 서버 raw response body는 사용자가 지정한 임의 서버가 만든 값이라 API key를 반사하거나
 * 내부 구현/스택을 노출할 수 있다 — 그래서 절대 그대로 읽어서 Error message에 담지 않는다.
 * status/status category만 근거로 고정 메시지를 고른다.
 */
export function describeLlmHttpError(status: number): string {
  if (status === 401 || status === 403) {
    return i18n.t("assistant.provider.auth");
  }
  if (status === 429) {
    return i18n.t("assistant.provider.rateLimit");
  }
  if (status >= 500) {
    return i18n.t("assistant.provider.serverError");
  }
  return i18n.t("assistant.provider.callFailedStatus", { status });
}

interface AssistTransport {
  stream(messages: AssistMessage[], signal?: AbortSignal): AsyncIterable<string>;
  readonly isConfigured: boolean;
}

class ByokTransport implements AssistTransport {
  constructor(private config: AssistConfig) {}

  get isConfigured(): boolean {
    return this.config.apiKey.length > 0;
  }

  async *stream(messages: AssistMessage[], signal?: AbortSignal): AsyncIterable<string> {
    // key exfiltration 최소 방어(#256 리뷰 §2): 이 provider가 실제로 호출하는 순간에도
    // base URL을 다시 검증한다 — 설정 화면 우회로 안전하지 않은 값이 들어와도 여기서 막는다.
    const check = checkLlmBaseUrl(this.config.baseUrl);
    if (!check.safe) {
      throw new Error(i18n.t("assistant.provider.unsafeBaseUrl", { reason: check.reason }));
    }

    let response: Response;
    try {
      response = await fetch(`${check.resolvedUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: true,
        }),
        signal,
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw new Error(
        redactApiKey(cause instanceof Error ? cause.message : i18n.t("assistant.provider.callFailed"), this.config.apiKey),
        { cause },
      );
    }

    if (!response.ok) {
      // raw response body는 절대 읽어서 Error message/log에 담지 않는다(#256 리뷰 §2) —
      // status만 근거로 고정 메시지를 사용한다.
      throw new Error(describeLlmHttpError(response.status));
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta as string;
        } catch {
          // SSE 파싱 오류는 무시 — 일부 청크는 불완전할 수 있음
        }
      }
    }
  }
}

function prepareMessages(messages: AssistMessage[], scrubber: SecretScrubber): AssistMessage[] {
  return messages.map(({ role, content, structuredContent }) => {
    const safeText = scrubber.scrubText(content);
    if (structuredContent === undefined) return { role, content: safeText };
    const safeStructured = scrubber.scrub(structuredContent);
    return { role, content: `${safeText}\n${JSON.stringify(safeStructured, null, 2)}` };
  });
}

const PLACEHOLDER_PREFIX = "__SCRUBBED_";
const COMPLETE_PLACEHOLDER = /^__SCRUBBED_[A-Za-z0-9-]+_\d+__/;

async function* redactDisplayOutput(output: AsyncIterable<string>): AsyncIterable<string> {
  let pending = "";
  for await (const chunk of output) {
    pending += chunk;
    while (pending) {
      const marker = pending.indexOf(PLACEHOLDER_PREFIX);
      if (marker < 0) {
        const safeLength = Math.max(0, pending.length - (PLACEHOLDER_PREFIX.length - 1));
        if (safeLength > 0) {
          yield pending.slice(0, safeLength);
          pending = pending.slice(safeLength);
        }
        break;
      }
      if (marker > 0) {
        yield pending.slice(0, marker);
        pending = pending.slice(marker);
      }
      const placeholder = pending.match(COMPLETE_PLACEHOLDER)?.[0];
      if (!placeholder) break;
      yield "[REDACTED]";
      pending = pending.slice(placeholder.length);
    }
  }

  if (pending.startsWith(PLACEHOLDER_PREFIX)) {
    yield pending.replace(/^__SCRUBBED_\S*/, "[REDACTED]");
  } else if (pending) {
    yield pending;
  }
}

class SafeAssistProvider implements AssistProvider {
  readonly [SAFE_PROVIDER] = true;

  constructor(private transport: AssistTransport) {}

  get isConfigured(): boolean {
    return this.transport.isConfigured;
  }

  exchange(messages: AssistMessage[], signal?: AbortSignal, options?: AssistExchangeOptions): AssistExchange {
    const scrubber = createSecretScrubber(undefined, { safeRunIds: options?.safeRunIds });
    const safeMessages = prepareMessages(messages, scrubber);
    const output = this.transport.stream(safeMessages, signal);
    return {
      output,
      displayOutput: redactDisplayOutput(output),
      hadSecrets: scrubber.placeholders.size > 0,
      restoreText: (text) => scrubber.restoreText(text),
    };
  }

  async *stream(messages: AssistMessage[], signal?: AbortSignal, options?: AssistExchangeOptions): AsyncIterable<string> {
    yield* this.exchange(messages, signal, options).displayOutput;
  }
}

export function createProvider(config: AssistConfig): AssistProvider {
  return new SafeAssistProvider(
    new ByokTransport({
      ...config,
      model: config.model || DEFAULT_MODEL,
      baseUrl: config.baseUrl || DEFAULT_BASE_URL,
    }),
  );
}
