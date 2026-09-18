/**
 * 비동기 build job 폴링 회귀 테스트 (#245).
 *
 * Builder async 표면(POST /builds + GET /builds/{run_id}, builder #480/#482)을
 * MSW 모의 시퀀스(queued → running → terminal)로 검증한다 — 실연동
 * executeBuild가 잡을 제출·폴링해 terminal 상태를 BuildRun으로 매핑하고,
 * useBuildJob이 Builder 잡의 wire 상태를 노출하며, 취소(로컬 abort)가
 * polling을 즉시 종료하는지 확인한다.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeBuild,
  listBuilds,
  POLL_INTERVAL_MS,
  specHasFileSource,
  type BuilderJobStatus,
} from "@/features/runs/api";
import { useBuildJob } from "@/features/runs/useBuildJob";
import { builderApi } from "@/shared/lib/builderApi";
import type { BuildSpec } from "@/shared/lib/types";

function specOf(datasetId: string): BuildSpec {
  return {
    datasetId,
    title: datasetId,
    description: "test spec",
    sources: [{ provider: "datago", dataset: "air_quality" }],
    exports: [],
  } as unknown as BuildSpec;
}

function urlSpec(datasetId: string): BuildSpec {
  return {
    datasetId,
    title: datasetId,
    description: "test spec",
    sources: [{ kind: "url", endpoint: "https://example.com/data.json", format: "json" }],
    exports: [],
  } as unknown as BuildSpec;
}

function fileSpec(datasetId: string): BuildSpec {
  return {
    datasetId,
    title: datasetId,
    description: "test spec",
    sources: [{ kind: "file", uploadId: `upl_${"0".repeat(32)}`, format: "csv", params: {} }],
    exports: [],
  } as unknown as BuildSpec;
}

function mixedSpec(datasetId: string): BuildSpec {
  return {
    datasetId,
    title: datasetId,
    description: "test spec",
    sources: [
      { provider: "datago", dataset: "air_quality", params: {} },
      { kind: "file", uploadId: `upl_${"0".repeat(32)}`, format: "csv", params: {} },
    ],
    exports: [],
  } as unknown as BuildSpec;
}

/**
 * polling loop 은 terminal 에 닿을 때까지 `POLL_INTERVAL_MS`(800ms)를 실제로 기다렸다 —
 * 케이스당 1.6~2.4초라 이 파일이 스위트에서 가장 느렸다(#376). 가짜 타이머로 그 대기만
 * 건너뛴다: 폴링 횟수·순서·상태 전이는 그대로라 무엇을 검증하는지는 달라지지 않는다.
 *
 * terminal 까지 필요한 폴링 수보다 넉넉히 밀어준다(멈춘 loop 은 어차피 아래 await 에서
 * 드러난다).
 */
const POLL_BUDGET_MS = POLL_INTERVAL_MS * 8;

/**
 * pending 상태 전이를 flush 한다 — RTL `waitFor` 의 대체재다.
 *
 * `waitFor` 는 자체 폴링에 실제 타이머를 쓰는데, vitest 의 가짜 타이머는 RTL 이
 * 인식하지 못해(jest 전역이 없다) 둘을 같이 쓰면 영원히 기다린다. 여기서는 시계를
 * 직접 밀어 같은 일을 한다.
 */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 폴링을 기다리는 promise 를 가짜 시계로 끝까지 밀어 결과를 받는다. */
async function runPolled<T>(start: () => Promise<T>): Promise<T> {
  const promise = start();
  await vi.advanceTimersByTimeAsync(POLL_BUDGET_MS);
  return promise;
}

beforeEach(() => {
  vi.stubEnv("VITE_USE_REAL_BUILDER", "true");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("async build job polling (#245)", () => {
  it("submits, polls through queued/running, and maps terminal success", async () => {
    const observed: BuilderJobStatus[] = [];

    const run = await runPolled(() =>
      executeBuild(specOf("success"), undefined, (status) => observed.push(status)),
    );

    expect(run.status).toBe("succeeded");
    expect(run.id.startsWith("success-")).toBe(true);
    expect(observed[0]).toBe("queued");
    expect(observed).toContain("running");
    expect(observed[observed.length - 1]).toBe("succeeded");
  });

  it("maps a failed terminal job to a failed run with the job error", async () => {
    const run = await runPolled(() => executeBuild(specOf("fail_source")));

    expect(run.status).toBe("failed");
    expect(run.error).toBe("upstream API timeout");
  });

  it("cancel() calls Builder POST /builds/{run_id}/cancel and observes the cancelled terminal (#S03)", async () => {
    const cancelSpy = vi.spyOn(builderApi, "cancelBuildJob");
    const { result } = renderHook(() => useBuildJob());

    let promise: Promise<void> = Promise.resolve();
    act(() => {
      promise = result.current.start(specOf("success"));
    });
    await settle();
    expect(result.current.status).toBe("running");
    expect(result.current.builderStatus).toBe("queued");

    act(() => {
      result.current.cancel();
    });

    // 실제 Builder 취소 endpoint를 호출한다 — polling만 끊고 "취소된 척"하지 않는다.
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy.mock.calls[0][0]).toMatch(/^success-\d+$/);

    // Builder가 cancelling → cancelled로 전이하는 것을 polling으로 관찰해 종결한다.
    await settle(POLL_BUDGET_MS);
    await act(async () => {
      await promise.catch(() => undefined);
    });
    expect(result.current.builderStatus).toBe("cancelled");
    expect(result.current.status).toBe("cancelled");
    expect(result.current.run?.status).toBe("cancelled");
    cancelSpy.mockRestore();
  });

  it("a FAILED cancel request never becomes a local cancelled — polling stays authoritative (MINOR A)", async () => {
    // POST /builds/{run_id}/cancel이 실패(네트워크/5xx)해도 Studio는 이를 취소로
    // 확정하지 않는다. MSW cancel 핸들러가 실행되지 않으므로 job은 서버 timeline대로
    // succeeded terminal에 도달하고, 그 값이 authoritative하다.
    const cancelSpy = vi
      .spyOn(builderApi, "cancelBuildJob")
      .mockRejectedValue(new Error("cancel request failed"));
    const { result } = renderHook(() => useBuildJob());

    let promise: Promise<void> = Promise.resolve();
    act(() => {
      promise = result.current.start(specOf("success"));
    });
    await settle();
    expect(result.current.builderStatus).toBe("queued");

    act(() => {
      result.current.cancel();
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    await settle(POLL_BUDGET_MS);
    await act(async () => {
      await promise.catch(() => undefined);
    });
    // 취소 요청 실패를 로컬 cancelled로 바꾸지 않는다 — polling terminal이 정답이다.
    expect(result.current.status).toBe("succeeded");
    expect(result.current.run?.status).toBe("succeeded");
    expect(result.current.interrupted).toBe(false);
    cancelSpy.mockRestore();
  });

  it("sync /build abort is a client-side interruption, not a confirmed cancellation (MAJOR / MINOR B)", async () => {
    const cancelSpy = vi.spyOn(builderApi, "cancelBuildJob");
    // sync build 요청을 abort될 때까지 붙잡아, abort 타이밍을 테스트가 제어한다.
    const buildSpy = vi.spyOn(builderApi, "build").mockImplementation(
      (_spec, _runId, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const { result } = renderHook(() => useBuildJob());

    let promise: Promise<void> = Promise.resolve();
    act(() => {
      promise = result.current.start(fileSpec("f"));
    });
    await settle();
    expect(result.current.status).toBe("running");

    act(() => {
      result.current.cancel();
    });
    await settle(POLL_BUDGET_MS);
    await act(async () => {
      await promise.catch(() => undefined);
    });

    // async 협조적 취소 endpoint는 sync build에서 절대 호출되지 않는다.
    expect(cancelSpy).not.toHaveBeenCalled();
    // canonical BuildRun/status를 cancelled(또는 succeeded/failed)로 확정하지 않는다.
    expect(result.current.status).toBe("idle");
    expect(result.current.status).not.toBe("cancelled");
    expect(result.current.run).toBeUndefined();
    // 오직 client-side "요청 중단" 의미만 노출한다.
    expect(result.current.interrupted).toBe(true);
    buildSpy.mockRestore();
    cancelSpy.mockRestore();
  });
});

describe("async pre-submit cancellation race (F03)", () => {
  it("deferred submit: Cancel before submit resolves does not hit cancel endpoint, then hits it exactly once with the authoritative run_id", async () => {
    // POST /builds 응답을 테스트가 직접 제어한다.
    let resolveSubmit: (v: {
      run_id: string;
      status: BuilderJobStatus;
      created_at: string;
      updated_at: string;
    }) => void = () => {};
    const submitSpy = vi
      .spyOn(builderApi, "submitBuild")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSubmit = resolve;
          }),
      );

    // 서버가 준 authoritative run_id는 client가 생성한 값과 다르다.
    const AUTHORITATIVE = "authoritative-run-xyz";
    const pollStates: BuilderJobStatus[] = ["cancelling", "cancelled"];
    let pollIndex = 0;
    const getJobSpy = vi.spyOn(builderApi, "getBuildJob").mockImplementation(async () => ({
      run_id: AUTHORITATIVE,
      status: pollStates[Math.min(pollIndex++, pollStates.length - 1)],
      created_at: "2026-08-16T09:00:00+00:00",
      updated_at: "2026-08-16T09:00:05+00:00",
    }));
    const cancelSpy = vi
      .spyOn(builderApi, "cancelBuildJob")
      .mockResolvedValue({
        run_id: AUTHORITATIVE,
        status: "cancelling",
        created_at: "2026-08-16T09:00:00+00:00",
        updated_at: "2026-08-16T09:00:05+00:00",
      });

    const { result } = renderHook(() => useBuildJob());

    let promise: Promise<void> = Promise.resolve();
    act(() => {
      promise = result.current.start(specOf("pub"));
    });
    await settle();
    expect(result.current.status).toBe("running");

    // submit이 아직 보류 중일 때 Cancel을 여러 번 누른다.
    act(() => {
      result.current.cancel();
      result.current.cancel();
      result.current.cancel();
    });

    // 이 시점에는 cancel endpoint가 호출되지 않았고, local 상태도 취소/중단이 아니다.
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe("running");
    expect(result.current.interrupted).toBe(false);
    // 사용자 Cancel 때문에 submit 요청 자체를 abort하지 않는다.
    expect(submitSpy).toHaveBeenCalledTimes(1);

    // submit 성공 → authoritative run_id 확보.
    await act(async () => {
      resolveSubmit({
        run_id: AUTHORITATIVE,
        status: "queued",
        created_at: "2026-08-16T09:00:00+00:00",
        updated_at: "2026-08-16T09:00:00+00:00",
      });
      // 시계를 먼저 굴려두고 await 한다 — 반대 순서면 polling sleep 이 깨어나지 못해 멈춘다.
      const advancing = vi.advanceTimersByTimeAsync(POLL_BUDGET_MS);
      await promise.catch(() => undefined);
      await advancing;
    });

    // pending intent가 authoritative run_id로 정확히 1회 협조적 취소를 건다.
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith(AUTHORITATIVE);
    expect(getJobSpy).toHaveBeenCalled();
    expect(getJobSpy.mock.calls.every(([runId]) => runId === AUTHORITATIVE)).toBe(true);

    // cancelling → cancelled polling을 관찰해 최종 상태를 확정한다.
    expect(result.current.builderStatus).toBe("cancelled");
    expect(result.current.status).toBe("cancelled");
    expect(result.current.run?.status).toBe("cancelled");
    expect(result.current.run?.id).toBe(AUTHORITATIVE);

    submitSpy.mockRestore();
    getJobSpy.mockRestore();
    cancelSpy.mockRestore();
  });

  it("repeated early Cancel coalesces to a single cancel endpoint call", async () => {
    let resolveSubmit: (v: {
      run_id: string;
      status: BuilderJobStatus;
      created_at: string;
      updated_at: string;
    }) => void = () => {};
    vi.spyOn(builderApi, "submitBuild").mockImplementation(
      () => new Promise((resolve) => { resolveSubmit = resolve; }),
    );
    let pollIndex = 0;
    const pollStates: BuilderJobStatus[] = ["cancelling", "cancelled"];
    vi.spyOn(builderApi, "getBuildJob").mockImplementation(async () => ({
      run_id: "r1",
      status: pollStates[Math.min(pollIndex++, pollStates.length - 1)],
      created_at: "2026-08-16T09:00:00+00:00",
      updated_at: "2026-08-16T09:00:05+00:00",
    }));
    const cancelSpy = vi.spyOn(builderApi, "cancelBuildJob").mockResolvedValue({
      run_id: "r1",
      status: "cancelling",
      created_at: "2026-08-16T09:00:00+00:00",
      updated_at: "2026-08-16T09:00:05+00:00",
    });

    const { result } = renderHook(() => useBuildJob());
    let promise: Promise<void> = Promise.resolve();
    act(() => {
      promise = result.current.start(specOf("pub"));
    });
    await settle();
    expect(result.current.status).toBe("running");

    act(() => {
      result.current.cancel();
      result.current.cancel();
    });

    await act(async () => {
      resolveSubmit({
        run_id: "r1",
        status: "queued",
        created_at: "2026-08-16T09:00:00+00:00",
        updated_at: "2026-08-16T09:00:00+00:00",
      });
      // 시계를 먼저 굴려두고 await 한다 — 반대 순서면 polling sleep 이 깨어나지 못해 멈춘다.
      const advancing = vi.advanceTimersByTimeAsync(POLL_BUDGET_MS);
      await promise.catch(() => undefined);
      await advancing;
    });

    // handle이 온 뒤 한 번 더 눌러도 여전히 1회.
    act(() => {
      result.current.cancel();
    });

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("cancelled");
  });
});

describe("Add Data source dispatch: sync /build vs async /builds (#X01, ADR 0014)", () => {
  it("routes a public_api-only spec to async POST /builds", async () => {
    const submitSpy = vi.spyOn(builderApi, "submitBuild");
    const buildSpy = vi.spyOn(builderApi, "build");
    await runPolled(() => executeBuild(specOf("pub")));
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
    buildSpy.mockRestore();
  });

  it("routes a url-only spec to async POST /builds", async () => {
    const submitSpy = vi.spyOn(builderApi, "submitBuild");
    const buildSpy = vi.spyOn(builderApi, "build");
    await runPolled(() => executeBuild(urlSpec("u")));
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
    buildSpy.mockRestore();
  });

  it("routes a file spec to sync POST /build and never calls POST /builds", async () => {
    const submitSpy = vi.spyOn(builderApi, "submitBuild");
    const buildSpy = vi.spyOn(builderApi, "build");
    const run = await executeBuild(fileSpec("f"));
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(run.status).toBe("succeeded");
    submitSpy.mockRestore();
    buildSpy.mockRestore();
  });

  it("routes a mixed spec (file + public_api) to sync POST /build — BuildSpec-wide, not first-source-only", async () => {
    const submitSpy = vi.spyOn(builderApi, "submitBuild");
    const buildSpy = vi.spyOn(builderApi, "build");
    await executeBuild(mixedSpec("m"));
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).not.toHaveBeenCalled();
    submitSpy.mockRestore();
    buildSpy.mockRestore();
  });

  it("specHasFileSource inspects the whole spec", () => {
    expect(specHasFileSource(mixedSpec("m"))).toBe(true);
    expect(specHasFileSource(fileSpec("f"))).toBe(true);
    expect(specHasFileSource(specOf("p"))).toBe(false);
    expect(specHasFileSource(urlSpec("u"))).toBe(false);
  });
});

describe("listBuilds status mapping preserves cancelled (#S04)", () => {
  it("maps Builder BuildSummary ok/failed/cancelled without collapsing cancelled to failed", async () => {
    const spy = vi.spyOn(builderApi, "listBuilds").mockResolvedValue({
      builds: [
        { run_id: "a", status: "ok", started_at: null, finished_at: null },
        { run_id: "b", status: "failed", started_at: null, finished_at: null },
        { run_id: "c", status: "cancelled", started_at: null, finished_at: null },
      ],
    });
    const items = await listBuilds();
    expect(items.map((i) => [i.id, i.status])).toEqual([
      ["a", "succeeded"],
      ["b", "failed"],
      ["c", "cancelled"],
    ]);
    spy.mockRestore();
  });
});
