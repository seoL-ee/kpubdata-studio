/**
 * builderApi 재시도 정책 테스트 (#117).
 *
 * 비멱등 POST /build는 5xx에도 재시도하지 않아야 하며, 멱등 GET은 재시도한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { API_BASE } from "@/shared/config/env";
import { builderApi, setAuthErrorCallback, setAuthTokenProvider } from "./builderApi";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("builderApi retry policy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not retry POST /build on 5xx (#117)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(500, { error: "boom" }));

    await expect(builderApi.build("dataset_id: x")).rejects.toMatchObject({
      status: 500,
    });

    // 최초 1회만 호출되어야 한다 (재시도 없음).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries idempotent GET /version on 5xx", async () => {
    // 실제 백오프 대기(500ms)를 기다리지 않도록 fake timer로 시간을 직접 진행시킨다.
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse(500, { error: "temp" }))
        .mockResolvedValueOnce(
          jsonResponse(200, { service: "kpubdata-builder", api_version: "1.0.0" }),
        );

      const pending = builderApi.version();
      // 첫 번째 재시도 전 백오프(500ms)를 즉시 소리을 통과시킨다.
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;

      expect(result.api_version).toBe("1.0.0");
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("apiFetch auth header injection (#186)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setAuthTokenProvider(null);
  });

  afterEach(() => {
    setAuthTokenProvider(null);
    vi.restoreAllMocks();
  });

  function requestInitOf(fetchMock: ReturnType<typeof vi.spyOn>) {
    // fetch(url, init) — 두 번째 인자가 RequestInit.
    return fetchMock.mock.calls[0][1] as RequestInit;
  }

  it("does not send Authorization when no provider is set (회귀 없음)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { service: "kpubdata-builder", api_version: "1.0.0" }));

    await builderApi.version();

    const headers = requestInitOf(fetchMock).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    // 미로그인/mock 모드에서 빈 헤더가 나가지 않는다.
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends Authorization: Bearer <token> when provider returns a token", async () => {
    setAuthTokenProvider(() => "id-token-jwt");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { service: "kpubdata-builder", api_version: "1.0.0" }));

    await builderApi.version();

    const headers = requestInitOf(fetchMock).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer id-token-jwt");
  });

  it("does not send Authorization when provider returns null (미로그인)", async () => {
    setAuthTokenProvider(() => null);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { service: "kpubdata-builder", api_version: "1.0.0" }));

    await builderApi.version();

    const headers = requestInitOf(fetchMock).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("async auth token provider (OIDC refresh at request boundary)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setAuthTokenProvider(null);
  });

  afterEach(() => {
    setAuthTokenProvider(null);
    vi.restoreAllMocks();
  });

  function requestInitOf(fetchMock: ReturnType<typeof vi.spyOn>) {
    return fetchMock.mock.calls[0][1] as RequestInit;
  }

  it("awaits a Promise-returning provider and uses the resolved (refreshed) token", async () => {
    setAuthTokenProvider(async () => "refreshed-access-token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { service: "kpubdata-builder", api_version: "1.0.0" }));

    await builderApi.version();

    const headers = requestInitOf(fetchMock).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer refreshed-access-token");
  });

  it("sends no Authorization header when the async provider resolves null (refresh failed / mock mode)", async () => {
    setAuthTokenProvider(() => Promise.resolve(null));
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { service: "kpubdata-builder", api_version: "1.0.0" }));

    await builderApi.version();

    const headers = requestInitOf(fetchMock).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("auth error callback on 401 (#189, S4)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setAuthTokenProvider(null);
    setAuthErrorCallback(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setAuthTokenProvider(null);
    setAuthErrorCallback(null);
  });

  it("calls auth error callback on 401", async () => {
    const cb = vi.fn();
    setAuthErrorCallback(cb);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));

    await expect(builderApi.version()).rejects.toMatchObject({ status: 401 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not call auth error callback on 403", async () => {
    const cb = vi.fn();
    setAuthErrorCallback(cb);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(403, { error: "forbidden" }));

    await expect(builderApi.version()).rejects.toMatchObject({ status: 403 });
    expect(cb).not.toHaveBeenCalled();
  });

  it("retries the request once with the refreshed token when the callback recovers (#189)", async () => {
    // 토큰이 요청 도중 만료된 상황: 첫 시도는 401, 재인증 후 두 번째 시도는 성공.
    let token = "expired-token";
    setAuthTokenProvider(() => token);
    setAuthErrorCallback(() => {
      token = "fresh-token";
      return true;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { service: "kpubdata-builder", api_version: "1.0.0" }),
      );

    const result = await builderApi.version();

    expect(result.api_version).toBe("1.0.0");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe("Bearer fresh-token");
  });

  it("retries a recovered 401 only once and then surfaces the error", async () => {
    setAuthTokenProvider(() => "token");
    setAuthErrorCallback(() => true);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));

    await expect(builderApi.version()).rejects.toMatchObject({ status: 401 });
    // 재인증이 계속 "성공"을 보고해도 재시도는 1회로 제한된다(루프 방지).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the callback does not report a recovered session", async () => {
    setAuthTokenProvider(() => "token");
    // 기존 계약(void 반환)을 그대로 쓰는 콜백은 재시도를 유발하지 않는다.
    const cb = vi.fn();
    setAuthErrorCallback(cb);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));

    await expect(builderApi.version()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("keeps the 401 when the recovery callback itself throws", async () => {
    setAuthTokenProvider(() => "token");
    setAuthErrorCallback(() => {
      throw new Error("refresh crashed");
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));

    await expect(builderApi.version()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 401 upload once — Builder rejects before the upload is stored (#189)", async () => {
    let token = "expired-token";
    setAuthTokenProvider(() => token);
    setAuthErrorCallback(() => {
      token = "fresh-token";
      return true;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          upload_id: `upl_${"a".repeat(32)}`,
          format: "csv",
          encoding: "utf-8",
          size_bytes: 3,
          original_filename: "a.csv",
          created_at: "2026-01-01T00:00:00Z",
        }),
      );

    const result = await builderApi.uploadFile(new Blob(["a,b"]), { format: "csv" });

    expect(result.upload_id).toBe(`upl_${"a".repeat(32)}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe("Bearer fresh-token");
  });
});

describe("provider status / credential CRUD contract (#S02)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  function callOf(fetchMock: ReturnType<typeof vi.spyOn>) {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init };
  }

  it("getProviderStatus → GET /providers/{provider}/status", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        provider: "datago",
        status: "connected",
        configured: true,
        latency_ms: 12,
        checked_at: "2026-08-31T00:00:00.000Z",
      }),
    );

    await builderApi.getProviderStatus("datago");

    const { url, init } = callOf(fetchMock);
    expect(url).toBe(`${API_BASE}/providers/datago/status`);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("putProviderCredential → PUT /providers/{provider}/credential with { credential } body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, {}));

    await builderApi.putProviderCredential("datago", "raw-secret");

    const { url, init } = callOf(fetchMock);
    expect(url).toBe(`${API_BASE}/providers/datago/credential`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ credential: "raw-secret" });
  });

  it("deleteProviderCredential → DELETE /providers/{provider}/credential with no body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, {}));

    await builderApi.deleteProviderCredential("datago");

    const { url, init } = callOf(fetchMock);
    expect(url).toBe(`${API_BASE}/providers/datago/credential`);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});

describe("async build cancellation contract (#S03)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("cancelBuildJob → POST /builds/{run_id}/cancel", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        run_id: "weather-1",
        status: "cancelling",
        created_at: "2026-08-31T00:00:00.000Z",
        updated_at: "2026-08-31T00:00:01.000Z",
      }),
    );

    const job = await builderApi.cancelBuildJob("weather-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/builds/weather-1/cancel`);
    expect(init.method).toBe("POST");
    expect(job.status).toBe("cancelling");
  });

  it("does not retry cancelBuildJob on 5xx (비멱등 side effect)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(500, { error: "boom" }));

    await expect(builderApi.cancelBuildJob("weather-1")).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
