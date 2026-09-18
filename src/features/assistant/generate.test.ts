/**
 * generateBuildSpec 4중 게이트 테스트 (#396, ST-A7 #210).
 *
 * 이 함수는 어시스턴트의 환각 차단 장치다 — LLM 이 지어낸 provider/dataset 이
 * 실제 빌드로 새어나가지 않는다는 보장이 전부 여기 들어 있다. 그래서 테스트는
 * "YAML 을 잘 뽑는가"가 아니라 **막아야 할 것을 막는가**를 본다.
 *
 * 메시지 문구는 단언하지 않는다(로케일로 빠져 있고 언제든 바뀐다) — 대신
 * status·spec·호출 횟수처럼 계약에 해당하는 것만 본다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateBuildSpec } from "./generate";
import type { AssistExchange, AssistMessage, AssistProvider } from "./provider";
import type { CatalogResponse, ValidateResponse } from "@/shared/lib/builderApi";

function dataset(name: string): CatalogResponse["providers"][number]["datasets"][number] {
  return {
    name,
    title: name,
    description: null,
    tags: [],
    source_url: null,
    representation: "api_json",
    operations: ["list"],
    query_support: null,
    requires_service_key: false,
  };
}

const CATALOG: CatalogResponse = {
  providers: [{ name: "datago", datasets: [dataset("air_quality"), dataset("apt_trade")] }],
};

const VALID_SPEC = [
  "dataset_id: datago.air_quality",
  "title: 대기오염",
  "description: 시간자료",
  "sources:",
  "  - provider: datago",
  "    dataset: air_quality",
].join("\n");

interface FakeProvider {
  provider: AssistProvider;
  /** 호출마다 LLM 에 실제로 보낸 메시지 목록. */
  calls: AssistMessage[][];
}

/**
 * 큐에 담긴 출력을 한 번에 하나씩 돌려주는 가짜 provider.
 * 큐가 바닥나면 마지막 값을 계속 돌려준다 — 재시도 상한을 검증할 때
 * "출력이 모자라서" 멈춘 것과 "상한에 걸려서" 멈춘 것을 구분하기 위해서다.
 */
function fakeProvider(outputs: string[], restoreText?: (text: string) => string): FakeProvider {
  const calls: AssistMessage[][] = [];
  const provider = {
    isConfigured: true,
    exchange(messages: AssistMessage[]): AssistExchange {
      calls.push(messages);
      const raw = outputs[Math.min(calls.length - 1, outputs.length - 1)] ?? "";
      return {
        output: (async function* () {
          yield raw;
        })(),
        displayOutput: (async function* () {
          yield raw;
        })(),
        hadSecrets: false,
        restoreText: restoreText ?? ((text: string) => text),
      };
    },
    stream: () => (async function* () {})(),
  } as unknown as AssistProvider;
  return { provider, calls };
}

const valid: ValidateResponse = { status: "valid", dataset_id: "datago.air_quality", api_version: "1.21.0" };
const invalid = (problems: string[]): ValidateResponse => ({ status: "invalid", problems });

function realBuilder(): void {
  vi.stubEnv("VITE_USE_REAL_BUILDER", "true");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("generateBuildSpec — LLM 을 부르기 전에 막는 경우", () => {
  it("mock 모드에서는 생성이 아예 막히고 LLM 을 부르지 않는다", async () => {
    const { provider, calls } = fakeProvider([VALID_SPEC]);
    const validateFn = vi.fn();

    const result = await generateBuildSpec(provider, "대기오염 데이터 줘", {
      catalog: CATALOG,
      validateFn,
    });

    expect(result).toMatchObject({ spec: null, status: "error", attempts: 0 });
    expect(calls).toHaveLength(0);
    expect(validateFn).not.toHaveBeenCalled();
  });

  it("validateFn 이 없으면 LLM 을 부르지 않는다 — 검증 없이 생성하지 않는다", async () => {
    realBuilder();
    const { provider, calls } = fakeProvider([VALID_SPEC]);

    const result = await generateBuildSpec(provider, "아무거나", {
      catalog: CATALOG,
    } as unknown as Parameters<typeof generateBuildSpec>[2]);

    expect(result).toMatchObject({ spec: null, status: "error", attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  it("카탈로그가 비어 있으면 LLM 을 부르지 않는다 — 대조할 기준이 없다", async () => {
    realBuilder();
    const { provider, calls } = fakeProvider([VALID_SPEC]);

    const result = await generateBuildSpec(provider, "아무거나", {
      catalog: { providers: [{ name: "datago", datasets: [] }] },
      validateFn: vi.fn(),
    });

    expect(result).toMatchObject({ spec: null, status: "error", attempts: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("generateBuildSpec — 정상 경로", () => {
  it("네 게이트를 모두 통과하면 복원된 스펙을 돌려준다", async () => {
    realBuilder();
    const { provider, calls } = fakeProvider([VALID_SPEC]);
    const validateFn = vi.fn<(spec: string) => Promise<ValidateResponse>>().mockResolvedValue(valid);

    const result = await generateBuildSpec(provider, "대기오염 데이터", {
      catalog: CATALOG,
      validateFn,
    });

    expect(result).toEqual({
      spec: VALID_SPEC,
      status: "ok",
      attempts: 1,
      remaining_problems: [],
    });
    expect(calls).toHaveLength(1);
  });

  it("```yaml 펜스로 감싼 출력에서도 스펙만 뽑아낸다", async () => {
    realBuilder();
    const { provider } = fakeProvider([`설명입니다.\n\`\`\`yaml\n${VALID_SPEC}\n\`\`\`\n끝.`]);

    const result = await generateBuildSpec(provider, "대기오염", {
      catalog: CATALOG,
      validateFn: vi.fn().mockResolvedValue(valid),
    });

    expect(result.status).toBe("ok");
    expect(result.spec).toBe(VALID_SPEC);
  });

  it("스크러빙된 placeholder 가 아니라 restoreText 를 거친 스펙을 돌려준다", async () => {
    realBuilder();
    const scrubbed = VALID_SPEC + "\nservice_key: __SECRET_0__";
    const restored = VALID_SPEC + "\nservice_key: real-key";
    const { provider } = fakeProvider([scrubbed], (text) => text.replace("__SECRET_0__", "real-key"));
    const validateFn = vi.fn<(spec: string) => Promise<ValidateResponse>>().mockResolvedValue(valid);

    const result = await generateBuildSpec(provider, "대기오염", { catalog: CATALOG, validateFn });

    expect(result.spec).toBe(restored);
    // Builder 에도 복원된 스펙이 가야 한다 — placeholder 를 검증해봐야 의미가 없다.
    expect(validateFn).toHaveBeenCalledWith(restored, undefined);
  });
});

describe("generateBuildSpec — ① zod 파싱 게이트", () => {
  it("파싱할 수 없는 출력은 통과시키지 않고 상한까지 재시도한다", async () => {
    realBuilder();
    const { provider, calls } = fakeProvider(["이건 YAML 이 아닙니다: [불완전"]);
    const validateFn = vi.fn();

    const result = await generateBuildSpec(provider, "아무거나", { catalog: CATALOG, validateFn });

    expect(result.spec).toBeNull();
    expect(result.status).toBe("partial");
    expect(result.attempts).toBe(3); // 최초 1회 + MAX_REPAIR_ATTEMPTS(2)
    expect(calls).toHaveLength(3);
    expect(validateFn).not.toHaveBeenCalled(); // 파싱을 못 넘었으므로 Builder 까지 가지 않는다
  });

  it("sources 가 없는 스펙은 구조 검증에서 막힌다", async () => {
    realBuilder();
    const { provider } = fakeProvider(["dataset_id: x\ntitle: t\ndescription: d\n"]);

    const result = await generateBuildSpec(provider, "아무거나", {
      catalog: CATALOG,
      validateFn: vi.fn(),
    });

    expect(result.spec).toBeNull();
    expect(result.remaining_problems.length).toBeGreaterThan(0);
  });

  it("빈 출력이면 재시도하고, 끝내 스펙을 만들지 않는다", async () => {
    realBuilder();
    const { provider, calls } = fakeProvider([""]);

    const result = await generateBuildSpec(provider, "아무거나", {
      catalog: CATALOG,
      validateFn: vi.fn(),
    });

    expect(result.spec).toBeNull();
    expect(calls).toHaveLength(3);
  });
});

describe("generateBuildSpec — ② 카탈로그 대조 게이트 (환각 차단의 핵심)", () => {
  it("카탈로그에 없는 provider 는 끝까지 통과하지 못한다", async () => {
    realBuilder();
    const hallucinated = VALID_SPEC.replace("provider: datago", "provider: 존재하지않는포털");
    const { provider } = fakeProvider([hallucinated]);
    const validateFn = vi.fn();

    const result = await generateBuildSpec(provider, "아무거나", { catalog: CATALOG, validateFn });

    expect(result.spec).toBeNull();
    expect(result.status).toBe("partial");
    // Builder 에 한 번도 보내지 않는다 — 지어낸 이름을 검증 요청으로 흘리지 않는다.
    expect(validateFn).not.toHaveBeenCalled();
    expect(result.remaining_problems.join(" ")).toContain("존재하지않는포털");
  });

  it("provider 는 맞지만 없는 dataset 도 막는다", async () => {
    realBuilder();
    const hallucinated = VALID_SPEC.replace("dataset: air_quality", "dataset: 없는데이터셋");
    const { provider } = fakeProvider([hallucinated]);
    const validateFn = vi.fn();

    const result = await generateBuildSpec(provider, "아무거나", { catalog: CATALOG, validateFn });

    expect(result.spec).toBeNull();
    expect(validateFn).not.toHaveBeenCalled();
    expect(result.remaining_problems.join(" ")).toContain("없는데이터셋");
  });

  it("재시도해서 카탈로그 안의 이름으로 고쳐오면 통과시킨다", async () => {
    realBuilder();
    const hallucinated = VALID_SPEC.replace("provider: datago", "provider: 없는포털");
    const { provider, calls } = fakeProvider([hallucinated, VALID_SPEC]);

    const result = await generateBuildSpec(provider, "아무거나", {
      catalog: CATALOG,
      validateFn: vi.fn().mockResolvedValue(valid),
    });

    expect(result).toMatchObject({ spec: VALID_SPEC, status: "ok", attempts: 2 });
    // 두 번째 요청에는 직전 문제 목록이 실려 나간다 — 같은 실수를 반복하지 않도록.
    const second = calls[1].map((message) => message.content).join("\n");
    expect(second).toContain("없는포털");
  });
});

describe("generateBuildSpec — ③ Builder /validate 게이트", () => {
  it("invalid 면 재시도하고, 끝내 invalid 면 스펙을 돌려주지 않는다", async () => {
    realBuilder();
    const { provider, calls } = fakeProvider([VALID_SPEC]);
    const validateFn = vi
      .fn<(spec: string) => Promise<ValidateResponse>>()
      .mockResolvedValue(invalid(["sources[0]: 필수 파라미터 누락"]));

    const result = await generateBuildSpec(provider, "아무거나", { catalog: CATALOG, validateFn });

    expect(result.spec).toBeNull();
    expect(result.status).toBe("partial");
    expect(calls).toHaveLength(3);
    expect(result.remaining_problems).toEqual(["sources[0]: 필수 파라미터 누락"]);
  });

  it("problems 가 비어 있어도 invalid 면 통과시키지 않는다", async () => {
    realBuilder();
    const { provider } = fakeProvider([VALID_SPEC]);
    const validateFn = vi
      .fn<(spec: string) => Promise<ValidateResponse>>()
      .mockResolvedValue(invalid([]));

    const result = await generateBuildSpec(provider, "아무거나", { catalog: CATALOG, validateFn });

    expect(result.spec).toBeNull();
    expect(result.remaining_problems).toHaveLength(1); // 빈 목록을 "문제 없음"으로 읽지 않는다
  });

  it("status:error 면 재시도하지 않고 즉시 중단한다", async () => {
    realBuilder();
    const { provider, calls } = fakeProvider([VALID_SPEC]);
    const validateFn = vi
      .fn<(spec: string) => Promise<ValidateResponse>>()
      .mockResolvedValue({ status: "error", error: "spec 로딩 실패" });

    const result = await generateBuildSpec(provider, "아무거나", { catalog: CATALOG, validateFn });

    expect(result).toMatchObject({ spec: null, status: "error", attempts: 1 });
    expect(result.remaining_problems).toEqual(["spec 로딩 실패"]);
    expect(calls).toHaveLength(1);
  });

  it("검증 요청 자체가 실패하면 error 로 끝난다 — 검증을 건너뛰지 않는다", async () => {
    realBuilder();
    const { provider } = fakeProvider([VALID_SPEC]);
    const validateFn = vi.fn().mockRejectedValue(new Error("네트워크 끊김"));

    const result = await generateBuildSpec(provider, "아무거나", { catalog: CATALOG, validateFn });

    expect(result).toMatchObject({ spec: null, status: "error" });
    expect(result.remaining_problems).toEqual(["네트워크 끊김"]);
  });

  it("Error 가 아닌 값으로 거부돼도 error 로 끝나고 문제 하나를 남긴다", async () => {
    realBuilder();
    const { provider } = fakeProvider([VALID_SPEC]);
    // 사용자가 지정한 임의 서버가 문자열/객체를 던질 수 있다 — message 를 읽으려다
    // undefined 를 사용자에게 보여주지 않는지 본다.
    const validateFn = vi.fn().mockRejectedValue("문자열 거부");

    const result = await generateBuildSpec(provider, "아무거나", { catalog: CATALOG, validateFn });

    expect(result).toMatchObject({ spec: null, status: "error" });
    expect(result.remaining_problems).toHaveLength(1);
    expect(result.remaining_problems[0]).toBeTruthy();
  });

  it("취소된 요청의 예외는 삼키지 않고 그대로 던진다", async () => {
    realBuilder();
    const controller = new AbortController();
    controller.abort();
    const { provider } = fakeProvider([VALID_SPEC]);
    const abortError = new Error("aborted");
    const validateFn = vi.fn().mockRejectedValue(abortError);

    await expect(
      generateBuildSpec(provider, "아무거나", {
        catalog: CATALOG,
        validateFn,
        signal: controller.signal,
      }),
    ).rejects.toBe(abortError);
  });
});

describe("generateBuildSpec — 시크릿 복원 실패", () => {
  it("restoreText 가 던지면 빌드로 넘어가지 않고 error 로 끝난다", async () => {
    realBuilder();
    const { provider } = fakeProvider([VALID_SPEC], () => {
      throw new Error("placeholder 를 복원할 수 없습니다");
    });
    const validateFn = vi.fn();

    const result = await generateBuildSpec(provider, "아무거나", { catalog: CATALOG, validateFn });

    expect(result).toMatchObject({ spec: null, status: "error", attempts: 1 });
    expect(validateFn).not.toHaveBeenCalled();
  });

  it("restoreText 가 Error 가 아닌 값을 던져도 문제 하나를 남기고 끝난다", async () => {
    realBuilder();
    const { provider } = fakeProvider([VALID_SPEC], () => {
      throw "복원 실패";
    });

    const result = await generateBuildSpec(provider, "아무거나", {
      catalog: CATALOG,
      validateFn: vi.fn(),
    });

    expect(result).toMatchObject({ spec: null, status: "error" });
    expect(result.remaining_problems).toHaveLength(1);
    expect(result.remaining_problems[0]).toBeTruthy();
  });
});
