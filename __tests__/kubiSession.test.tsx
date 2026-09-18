/**
 * useKubiSession 통합 테스트 (#256).
 *
 * evidence 조회는 기존 mock 데이터 경로(features/datasets/api, isRealBuilderEnabled=false)를
 * 그대로 타게 하고, LLM 호출만 `createProvider`를 모킹해 응답을 통제한다.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistConfig } from "@/features/assistant/config";
import { createProvider } from "@/features/assistant/provider";
import { saveBuildSpec } from "@/features/build-spec/specStore";
import type { BuildSpec } from "@/shared/lib/types";
import { useKubiSession, useKubiStore } from "@/features/kubi/useKubiSession";

vi.mock("@/features/assistant/provider", () => ({
  createProvider: vi.fn(),
}));

function jsonText(payload: unknown): AsyncIterable<string> {
  return (async function* () {
    yield "```json\n" + JSON.stringify(payload) + "\n```";
  })();
}

function textOf(text: string): AsyncIterable<string> {
  return (async function* () {
    yield text;
  })();
}

function throwingStream(message: string): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          return Promise.reject(new Error(message));
        },
      };
    },
  };
}

function abortableStream(signal?: AbortSignal): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          return new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        },
      };
    },
  };
}

function mockStream(stream: (messages: unknown, signal?: AbortSignal) => AsyncIterable<string>) {
  vi.mocked(createProvider).mockReturnValue({
    isConfigured: true,
    stream,
  } as unknown as ReturnType<typeof createProvider>);
}

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

function configureKey() {
  act(() => {
    useAssistConfig.getState().setConfig({ apiKey: "sk-test-key", model: "gpt-4o-mini", baseUrl: "" });
  });
}

let navigateRef: ((to: string) => void) | null = null;

function Capture({ children }: { children: ReactNode }) {
  navigateRef = useNavigate();
  return <>{children}</>;
}

function makeWrapper(initialPath: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        <Capture>{children}</Capture>
      </MemoryRouter>
    );
  };
}

beforeEach(() => {
  vi.stubEnv("VITE_USE_REAL_BUILDER", "false");
  useKubiStore.setState({ turns: [], onboarded: false, pendingSeed: null });
  useAssistConfig.getState().clear();
  navigateRef = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("useKubiSession — key/base URL/LLM error states (#256)", () => {
  it("shows a no_key error and never calls the provider without an API key", async () => {
    const { result } = renderHook(() => useKubiSession(), { wrapper: makeWrapper("/") });
    await act(async () => {
      await result.current.ask("질문");
    });
    expect(result.current.turns[0].error).toEqual({ kind: "no_key" });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("shows a bad_base_url error and never calls the provider for a non-HTTPS base URL", async () => {
    act(() => {
      useAssistConfig.getState().setConfig({ apiKey: "sk-test", baseUrl: "http://insecure.example.com" });
    });
    const { result } = renderHook(() => useKubiSession(), { wrapper: makeWrapper("/") });
    await act(async () => {
      await result.current.ask("질문");
    });
    expect(result.current.turns[0].error?.kind).toBe("bad_base_url");
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("surfaces a structured llm_error when the provider throws", async () => {
    configureKey();
    mockStream(() => throwingStream("rate limited"));
    const { result } = renderHook(() => useKubiSession(), { wrapper: makeWrapper("/") });
    await act(async () => {
      await result.current.ask("질문");
    });
    expect(result.current.turns[0].status).toBe("error");
    expect(result.current.turns[0].error).toEqual({ kind: "llm_error", message: "rate limited" });
  });

  it("marks a cancelled request distinctly from a real error", async () => {
    configureKey();
    mockStream((_messages, signal) => abortableStream(signal));

    const { result } = renderHook(() => useKubiSession(), { wrapper: makeWrapper("/") });
    let askPromise!: Promise<void>;
    act(() => {
      askPromise = result.current.ask("질문");
    });
    await waitFor(() => expect(result.current.turns).toHaveLength(1));
    const turnId = result.current.turns[0].id;
    act(() => result.current.cancel(turnId));
    await act(async () => {
      await askPromise;
    });
    expect(result.current.turns[0].error).toEqual({ kind: "cancelled" });
  });

  it("rejects malformed structured output (including an unknown suggested-action type) as a safe error state", async () => {
    configureKey();
    mockStream(() => textOf("이건 그냥 자유 텍스트입니다, JSON이 아니에요."));
    const { result } = renderHook(() => useKubiSession(), { wrapper: makeWrapper("/") });
    await act(async () => {
      await result.current.ask("질문");
    });
    expect(result.current.turns[0].status).toBe("error");
    expect(result.current.turns[0].error?.kind).toBe("malformed_output");
    expect(result.current.turns[0].rawOutput).toBeTruthy();
  });

  it("rejects an unknown suggestedAction type as malformed output (allowlist enforced end-to-end)", async () => {
    configureKey();
    mockStream(() =>
      jsonText({
        answer: "빌드를 다시 실행할게요.",
        evidenceRefs: [],
        generatedSql: null,
        suggestedActions: [{ type: "RUN_BUILD", reason: "자동으로 재실행합니다" }],
      }),
    );
    const { result } = renderHook(() => useKubiSession(), { wrapper: makeWrapper("/") });
    await act(async () => {
      await result.current.ask("빌드를 재실행해줘");
    });
    expect(result.current.turns[0].status).toBe("error");
    expect(result.current.turns[0].error?.kind).toBe("malformed_output");
  });
});

describe("useKubiSession — evidence grounding & hallucination gate (#256)", () => {
  it("drops a hallucinated dataset ref but keeps the rest of the answer, and flags the turn", async () => {
    configureKey();
    mockStream(() =>
      jsonText({
        answer: "요청하신 내용을 확인했습니다.",
        evidenceRefs: [{ kind: "dataset", id: "존재하지-않는-데이터셋", label: "가짜" }],
        generatedSql: null,
        suggestedActions: [],
      }),
    );
    const { result } = renderHook(() => useKubiSession(), { wrapper: makeWrapper("/") });
    await act(async () => {
      await result.current.ask("질문");
    });
    const turn = result.current.turns[0];
    expect(turn.status).toBe("ok");
    expect(turn.response?.answer).toBe("요청하신 내용을 확인했습니다.");
    expect(turn.response?.evidenceRefs).toHaveLength(0);
    expect(turn.error?.kind).toBe("hallucinated_refs");
  });

  it("drops Generated SQL when the context is Bronze, even if the LLM proposes one (structural Bronze block)", async () => {
    configureKey();
    mockStream(() =>
      jsonText({
        answer: "Bronze 원본을 조회하는 쿼리를 만들었습니다.",
        evidenceRefs: [],
        generatedSql: { sql: "SELECT * FROM dataset", stage: "silver" },
        suggestedActions: [],
      }),
    );
    const { result } = renderHook(() => useKubiSession(), {
      wrapper: makeWrapper("/datasets/air-quality?run=air-2026-08-14&stage=bronze"),
    });
    await act(async () => {
      await result.current.ask("이 원본 데이터를 SQL로 보여줘");
    });
    const turn = result.current.turns[0];
    expect(turn.response?.generatedSql).toBeNull();
    expect(turn.error?.kind).toBe("hallucinated_refs");
  });

  it("keeps evidence-grounded refs and actions that do exist", async () => {
    configureKey();
    mockStream(() =>
      jsonText({
        answer: "현재 데이터셋 상태를 요약했습니다.",
        evidenceRefs: [{ kind: "dataset", id: "air-quality", label: "대기질 통합 데이터" }],
        generatedSql: null,
        suggestedActions: [{ type: "OPEN_BUILD", runId: "air-2026-08-14", reason: "실패 원인을 확인하세요" }],
      }),
    );
    const { result } = renderHook(() => useKubiSession(), {
      wrapper: makeWrapper("/datasets/air-quality?run=air-2026-08-14"),
    });
    await act(async () => {
      await result.current.ask("이 데이터셋 상태 알려줘");
    });
    const turn = result.current.turns[0];
    expect(turn.status).toBe("ok");
    expect(turn.error).toBeUndefined();
    expect(turn.response?.evidenceRefs).toHaveLength(1);
    expect(turn.response?.suggestedActions).toHaveLength(1);
  });
});

describe("useKubiSession — stale context guard (#256 리뷰 §6)", () => {
  it("flags a turn as stale once the route context changes, and blocks query/action execution", async () => {
    configureKey();
    mockStream(() =>
      jsonText({
        answer: "Silver 데이터를 조회하는 쿼리입니다.",
        evidenceRefs: [],
        generatedSql: { sql: "SELECT * FROM dataset", stage: "silver" },
        suggestedActions: [{ type: "OPEN_BUILD", runId: "air-2026-08-14", reason: "확인해보세요" }],
      }),
    );
    const { result } = renderHook(() => useKubiSession(), {
      wrapper: makeWrapper("/datasets/air-quality?run=air-2026-08-14&stage=silver"),
    });
    await act(async () => {
      await result.current.ask("SQL 만들어줘");
    });
    const turnId = result.current.turns[0].id;
    expect(result.current.isStale(result.current.turns[0])).toBe(false);

    act(() => navigateRef?.("/datasets/population?run=population-2026-08-13&stage=silver"));
    await waitFor(() => expect(result.current.isStale(result.current.turns[0])).toBe(true));

    await act(async () => {
      await result.current.executeQuery(turnId);
    });
    expect(result.current.turns[0].query).toMatchObject({ status: "error", code: "invalid_context" });

    await act(async () => {
      await result.current.approveAction(turnId, 0);
    });
    expect(result.current.turns[0].actionStates[0]).toMatchObject({ status: "error" });
  });
});

describe("useKubiSession — Generated SQL execution via Builder /query (#256, builder #504)", () => {
  function fetchStub(queryResponder: () => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/query")) return queryResponder();
        return mockResponse(404, { error: "not mocked in this test" });
      }),
    );
  }

  async function askForSilverSql() {
    configureKey();
    // ask()는 real 모드에서 evidence 조회로 Builder를 부른다. 스텁을 나중에 깔면 그
    // 호출들이 진짜 fetch로 나가 실패하고, builderApi의 지수 백오프(500ms+1000ms)를
    // 요청마다 통째로 기다린다 — 이 파일이 느렸던 이유다(#376). 먼저 깔아 결과를
    // 결정적으로 만든다. 여전히 실패 응답이므로 grounding 결과는 달라지지 않는다.
    fetchStub(() => mockResponse(404, { error: "not mocked in this test" }));
    mockStream(() =>
      jsonText({
        answer: "Silver 데이터를 조회하는 쿼리입니다.",
        evidenceRefs: [],
        generatedSql: { sql: "SELECT * FROM dataset", stage: "silver" },
        suggestedActions: [],
      }),
    );
    const { result } = renderHook(() => useKubiSession(), {
      wrapper: makeWrapper("/datasets/air-quality?run=air-2026-08-14&stage=silver"),
    });
    await act(async () => {
      await result.current.ask("SQL 만들어줘");
    });
    return result;
  }

  it("calls Builder /query and shows columns/rows/truncated/execution_ms on success", async () => {
    vi.stubEnv("VITE_USE_REAL_BUILDER", "true");
    const result = await askForSilverSql();
    fetchStub(() => mockResponse(200, { columns: ["region"], rows: [{ region: "서울" }], truncated: false, execution_ms: 8 }));

    await act(async () => {
      await result.current.executeQuery(result.current.turns[0].id);
    });

    expect(result.current.turns[0].query).toEqual({
      status: "success",
      result: { columns: ["region"], rows: [{ region: "서울" }], truncated: false, execution_ms: 8 },
    });
  });

  it("marks truncated results clearly", async () => {
    vi.stubEnv("VITE_USE_REAL_BUILDER", "true");
    const result = await askForSilverSql();
    fetchStub(() => mockResponse(200, { columns: ["region"], rows: [{ region: "서울" }], truncated: true, execution_ms: 3 }));

    await act(async () => {
      await result.current.executeQuery(result.current.turns[0].id);
    });

    expect(result.current.turns[0].query).toMatchObject({ status: "success", result: { truncated: true } });
  });

  it("keeps the answer/evidence when the query fails", async () => {
    vi.stubEnv("VITE_USE_REAL_BUILDER", "true");
    const result = await askForSilverSql();
    const answerBefore = result.current.turns[0].response?.answer;
    fetchStub(() => mockResponse(400, { error: "syntax error", code: "unsafe_query" }));

    await act(async () => {
      await result.current.executeQuery(result.current.turns[0].id);
    });

    expect(result.current.turns[0].query).toMatchObject({ status: "error", code: "unsafe_query" });
    expect(result.current.turns[0].response?.answer).toBe(answerBefore);
  });
});

describe("useKubiSession — askDemo (#256 review, mock mode Kubi 데모)", () => {
  it("works without any API key configured and never calls the LLM provider", async () => {
    vi.mocked(createProvider).mockClear();
    const { result } = renderHook(() => useKubiSession(), {
      wrapper: makeWrapper("/datasets/air-quality?run=air-2026-08-14&source=datago__air&stage=silver"),
    });
    expect(result.current.isConfigured).toBe(false);
    expect(result.current.isDemoAvailable).toBe(true);

    await act(async () => {
      await result.current.askDemo("이 데이터셋 품질 어때?");
    });

    expect(createProvider).not.toHaveBeenCalled();
    expect(result.current.turns[0]).toMatchObject({ status: "ok", isDemo: true });
    expect(result.current.turns[0].response?.answer).toContain("[DEMO]");
    // 실제 mock evidence(features/datasets/api)를 그대로 근거로 쓴다 — 별도로 지어내지 않는다.
    expect(result.current.turns[0].evidence?.dataset?.datasetId).toBe("air-quality");
  });

  it("is unavailable in real mode — askDemo becomes a no-op so real mode always requires BYOK", async () => {
    vi.stubEnv("VITE_USE_REAL_BUILDER", "true");
    const { result } = renderHook(() => useKubiSession(), { wrapper: makeWrapper("/datasets/air-quality") });
    expect(result.current.isDemoAvailable).toBe(false);

    await act(async () => {
      await result.current.askDemo("이 데이터셋 품질 어때?");
    });

    expect(result.current.turns).toHaveLength(0);
  });

  it("executing a demo turn's Generated SQL returns a fixed mock result without calling Builder /query", async () => {
    // evidence 조회(catalog 등)는 그대로 mock 경로를 타지만, 데모는 절대 실제 /query를 호출하지 않는다.
    const fetchMock = vi.fn(async (_input: unknown) => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useKubiSession(), {
      wrapper: makeWrapper("/datasets/air-quality?run=air-2026-08-14&source=datago__air&stage=silver"),
    });
    await act(async () => {
      await result.current.askDemo("지역별 분포 보여줘");
    });
    expect(result.current.turns[0].response?.generatedSql).not.toBeNull();

    await act(async () => {
      await result.current.executeQuery(result.current.turns[0].id);
    });

    expect(result.current.turns[0].query).toMatchObject({ status: "success" });
    const queryCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/query"));
    expect(queryCalls).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe("useKubiSession — Suggested Actions require approval (#256)", () => {
  it("does not navigate until approveAction is called (approval required)", async () => {
    configureKey();
    mockStream(() =>
      jsonText({
        answer: "Build 상세를 열어드릴게요.",
        evidenceRefs: [],
        generatedSql: null,
        suggestedActions: [{ type: "OPEN_BUILD", runId: "air-2026-08-14", reason: "확인" }],
      }),
    );
    const { result } = renderHook(() => useKubiSession(), {
      wrapper: makeWrapper("/datasets/air-quality?run=air-2026-08-14"),
    });
    await act(async () => {
      await result.current.ask("빌드 상세 열어줘");
    });
    expect(result.current.turns[0].actionStates[0]).toEqual({ status: "pending_approval" });

    const turnId = result.current.turns[0].id;
    await act(async () => {
      await result.current.approveAction(turnId, 0);
    });
    expect(result.current.turns[0].actionStates[0].status).toBe("applied");
  });

  it("rejectAction leaves the action unapplied", async () => {
    configureKey();
    mockStream(() =>
      jsonText({
        answer: "요청하신 대로 준비했습니다.",
        evidenceRefs: [],
        generatedSql: null,
        suggestedActions: [{ type: "OPEN_BUILD", runId: "air-2026-08-14", reason: "확인" }],
      }),
    );
    const { result } = renderHook(() => useKubiSession(), {
      wrapper: makeWrapper("/datasets/air-quality?run=air-2026-08-14"),
    });
    await act(async () => {
      await result.current.ask("빌드 상세 열어줘");
    });
    const turnId = result.current.turns[0].id;
    act(() => result.current.rejectAction(turnId, 0));
    expect(result.current.turns[0].actionStates[0].status).toBe("rejected");
  });
});

describe("useKubiSession — PATCH_BUILDSPEC diff + validate path (#256 리뷰 §10)", () => {
  const SPEC: BuildSpec = {
    datasetId: "air-quality",
    title: "대기질",
    description: "설명",
    sources: [{ provider: "data.go.kr", dataset: "air", params: { region: "서울" } }],
    exports: [{ format: "jsonl" }],
    metadata: { note: "orig" },
  };

  it("requires a two-step approve → confirm before writing/validating the patch", async () => {
    saveBuildSpec("air-2026-08-14", SPEC);
    configureKey();
    mockStream(() =>
      jsonText({
        answer: "metadata에 참고 노트를 추가하는 patch를 제안합니다.",
        evidenceRefs: [],
        generatedSql: null,
        suggestedActions: [
          {
            type: "PATCH_BUILDSPEC",
            runId: "air-2026-08-14",
            patch: [{ op: "replace", path: "/metadata/note", value: "kubi-updated" }],
            reason: "Kubi 분석 참고",
          },
        ],
      }),
    );
    const { result } = renderHook(() => useKubiSession(), {
      wrapper: makeWrapper("/datasets/air-quality?run=air-2026-08-14"),
    });
    await act(async () => {
      await result.current.ask("metadata에 노트 추가해줘");
    });

    const turnId = result.current.turns[0].id;
    expect(result.current.turns[0].response?.suggestedActions).toHaveLength(1);
    expect(result.current.turns[0].actionStates[0].status).toBe("pending_approval");

    await act(async () => {
      await result.current.approveAction(turnId, 0);
    });
    expect(result.current.turns[0].actionStates[0].status).toBe("approved");

    const preview = result.current.previewPatch(turnId, 0);
    expect(preview?.ok).toBe(true);
    if (preview?.ok) expect(preview.after.metadata.note).toBe("kubi-updated");

    await act(async () => {
      await result.current.confirmApprovedAction(turnId, 0);
    });
    expect(result.current.turns[0].actionStates[0].status).toBe("applied");
    if (result.current.turns[0].actionStates[0].status === "applied") {
      expect(result.current.turns[0].actionStates[0].message).toContain("validate");
    }
  });

  it("safely rejects PATCH_BUILDSPEC when the run's original spec isn't available locally (downstream-unavailable handling)", async () => {
    // 이 run에는 저장된 spec이 없다 — Builder가 spec을 영속화하지 않으므로 발생할 수 있는 정상 상황.
    configureKey();
    mockStream(() =>
      jsonText({
        answer: "patch를 제안합니다.",
        evidenceRefs: [],
        generatedSql: null,
        suggestedActions: [
          {
            type: "PATCH_BUILDSPEC",
            runId: "air-2026-08-14",
            patch: [{ op: "replace", path: "/metadata/note", value: "x" }],
            reason: "테스트",
          },
        ],
      }),
    );
    const { result } = renderHook(() => useKubiSession(), {
      wrapper: makeWrapper("/datasets/air-quality?run=air-2026-08-14"),
    });
    await act(async () => {
      await result.current.ask("patch 제안해줘");
    });

    expect(result.current.turns[0].response?.suggestedActions).toHaveLength(0);
    expect(result.current.turns[0].error?.kind).toBe("hallucinated_refs");
    expect(result.current.turns[0].error && "rejectedActions" in result.current.turns[0].error
      ? result.current.turns[0].error.rejectedActions.join(" ")
      : "",
    ).toContain("PATCH_BUILDSPEC");
  });
});
