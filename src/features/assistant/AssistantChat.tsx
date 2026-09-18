/**
 * BuildSpec 어시스턴트 채팅 UI (#207, ST-A4).
 *
 * 스트리밍 응답 표시, 취소 버튼, 대화 초기화.
 * shared/ui 컴포넌트 재사용, 라이트/다크 테마 대응.
 */
import { useCallback, useRef, useState } from "react";
import { Button, Card, Textarea } from "@/shared/ui";
import { useAssistConfig } from "./config";
import { createProvider, type AssistMessage } from "./provider";
import { useTranslation } from "react-i18next";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function AssistantChat({ contextSpec }: { contextSpec?: unknown }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { apiKey, model, baseUrl } = useAssistConfig();

  const handleSend = useCallback(async () => {
    if (!input.trim() || !apiKey) return;
    setError(null);

    const userMsg: ChatMessage = { role: "user", content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);

    const systemPrompt = `당신은 한국 공공데이터 빌드 스펙(BuildSpec) 전문가입니다.
사용자의 질문에 한국어로 답변하세요.
${contextSpec ? "현재 스펙은 첨부된 구조화 컨텍스트를 참고하세요.\n" : ""}
오류가 있으면 수정 제안을 하세요.`;

    const apiMessages: AssistMessage[] = [
      { role: "system", content: systemPrompt, structuredContent: contextSpec },
      ...[...messages, userMsg].map((m) => ({ role: m.role, content: m.content }) as AssistMessage),
    ];

    try {
      const provider = createProvider({ apiKey, model, baseUrl });
      const controller = new AbortController();
      abortRef.current = controller;

      let assistantContent = "";
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      for await (const chunk of provider.stream(apiMessages, controller.signal)) {
        assistantContent += chunk;
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: assistantContent };
          return next;
        });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : t("assistantChat.llmFailed"));
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [input, apiKey, model, baseUrl, contextSpec, messages]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  const handleClear = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  if (!apiKey) {
    return (
      <Card variant="dashed">
        <p className="text-sm text-muted-foreground">
          {t("assistantChat.needsKey")}
        </p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t("assistantChat.title")}</h3>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={handleClear}>
            {t("assistantChat.reset")}
          </Button>
        )}
      </div>

      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("assistantChat.hint")}
        </p>
      ) : (
        <div className="max-h-96 space-y-3 overflow-y-auto">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`rounded-lg px-3 py-2 text-sm ${
                msg.role === "user"
                  ? "ml-8 bg-primary/10 text-foreground"
                  : "mr-8 bg-muted text-muted-foreground"
              }`}
            >
              <p className="whitespace-pre-wrap break-words">{msg.content || "…"}</p>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("assistantChat.placeholder")}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        {isStreaming ? (
          <Button variant="secondary" onClick={handleCancel}>
            {t("assistantChat.cancel")}
          </Button>
        ) : (
          <Button onClick={handleSend} disabled={!input.trim()}>
            {t("assistantChat.send")}
          </Button>
        )}
      </div>
    </Card>
  );
}
