/**
 * 시크릿 스크러빙 — LLM 전송 전 마스킹 (#206, ST-A3, #226).
 *
 * sourceParams에 공공데이터포털 서비스 키 등이 들어갈 수 있다.
 * 이걸 그대로 LLM에 보내면 사용자 시크릿이 외부 사업자에게 전송된다.
 *
 * 호출 경로의 공통 계층에 두어 프록시 모드로 바뀌어도 우회되지 않게 한다.
 */

const SECRET_KEY_PATTERNS = [
  /^servicekey$/i,
  /^api[_-]?key$/i,
  /^.*[_-]?key$/i,
  /^.*[_-]?token$/i,
  /^.*[_-]?secret$/i,
];

// Shannon 엔트로피 임계 (bits/char). base64(≈6.0)/hex(=4.0) 키를 잡고
// 일반 텍스트는 놓친다. 이전 (unique/length)*100 휴리스틱은 길수록 고유 문자
// 비율이 떨어져 200자 base64 키를 32%로 계산해 놓쳤다 (#226 결함 d).
const SHANNON_ENTROPY_THRESHOLD = 4.0;
const MIN_LENGTH_FOR_ENTROPY = 24;

/**
 * generic 엔트로피 오탐에서만 면제할 "출처가 검증된 exact 값" 집합의 기본값(빈 집합).
 *
 * 이 인자를 넘기지 않는 기존 consumer(paramsRedaction/urlRedaction/savedSpecs/일반
 * assistant)는 main과 완전히 동일한 스크럽 동작을 유지한다. Kubi 경로만 실제 Builder/
 * evidence에서 만든 run id 집합을 넘겨, canonical run id가 `[REDACTED]`되는 것을 막는다.
 *
 * 중요: 이 면제는 "형태가 run id 같다"가 아니라 "이 실행에서 실제 resource identity로
 * 확인된 exact 문자열"에만 적용된다. secret-named field masking(isSecretKey)과 명시적
 * credential 대입 스크럽은 이 면제보다 항상 먼저 적용된다.
 */
const NO_SAFE_VALUES: ReadonlySet<string> = new Set();

/** 정규식 리터럴로 안전하게 끼워 넣기 위해 메타문자를 escape 한다. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import { i18n } from "@/shared/i18n";

export function isSecretKey(keyName: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(keyName));
}

/**
 * Shannon 엔트로피(문자당 bits) 계산. 문자 빈도 분포를 반영해
 * 긴 고엔트로피 문자열(base64/hex 키)을 정확히 잡는다 (#226 결함 d).
 */
function shannonEntropy(value: string): number {
  const freq = new Map<string, number>();
  for (const ch of value) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let h = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * 값이 API key/token 같은 고엔트로피 시크릿처럼 보이는지 Shannon 엔트로피로 판정한다.
 *
 * @param value - 검사 대상 문자열.
 * @param safeValues - 이 실행에서 실제 resource identity로 확인된 exact 값 집합. 여기에
 *   정확히(대소문자·전체 문자열까지) 일치하는 값만 엔트로피 휴리스틱에서 면제한다.
 *   부분 일치/형태 매칭은 하지 않는다 — crafted `<words>-<timestamp>` 시크릿은 exact
 *   match가 아니므로 그대로 아래 엔트로피 검사에 걸린다.
 */
export function looksLikeSecret(
  value: string,
  safeValues: ReadonlySet<string> = NO_SAFE_VALUES,
): boolean {
  if (value.length < MIN_LENGTH_FOR_ENTROPY) return false;
  if (safeValues.has(value)) return false;
  return shannonEntropy(value) >= SHANNON_ENTROPY_THRESHOLD;
}

const SCRUBBED_PREFIX = "__SCRUBBED_";
const SCRUBBED_PATTERN = /__SCRUBBED_[A-Za-z0-9-]+_\d+__/g;
const SCRUBBED_TEST_PATTERN = /__SCRUBBED_[A-Za-z0-9-]+_\d+__/;

/**
 * `redactSecrets()`가 시크릿 값을 최종적으로 치환하는 종결 마커. 왕복 복원이 불가능한
 * 값이므로(placeholder→원문 map이 없음), 복원된 spec/draft에서 이 문자열이 보이면
 * "시크릿이 이미 제거됨 → 재입력 필요"로 취급해야 한다(#206, S07 리뷰 §1).
 */
export const REDACTED_SECRET_MARKER = "[REDACTED]";

export interface ScrubResult {
  scrubbed: unknown;
  placeholders: Map<string, string>;
}

export interface SecretScrubber {
  scrub(data: unknown): unknown;
  scrubText(text: string): string;
  restore(data: unknown): unknown;
  restoreText(text: string): string;
  readonly placeholders: ReadonlyMap<string, string>;
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export interface SecretScrubberOptions {
  /**
   * 이 스크러버 인스턴스가 generic 엔트로피 검사에서만 면제할 exact 값 집합.
   * secret-named field / 명시적 credential 대입 스크럽에는 영향을 주지 않는다.
   * 넘기지 않으면 빈 집합 — main과 동일 동작.
   */
  safeRunIds?: ReadonlySet<string>;
}

export function createSecretScrubber(
  id = requestId(),
  options: SecretScrubberOptions = {},
): SecretScrubber {
  const placeholders = new Map<string, string>();
  const safeRunIds = options.safeRunIds ?? NO_SAFE_VALUES;
  let counter = 0;

  function replace(value: string): string {
    const placeholder = `${SCRUBBED_PREFIX}${id}_${counter++}__`;
    placeholders.set(placeholder, value);
    return placeholder;
  }

  function scrubValue(key: string, value: unknown): unknown {
    // 우선순위: (1) secret-named field는 값이 known safe run id여도 무조건 스크럽,
    // (2) 그 외에는 safeRunIds exact match일 때만 엔트로피 오탐에서 면제.
    if (typeof value === "string" && (isSecretKey(key) || looksLikeSecret(value, safeRunIds))) {
      return replace(value);
    }
    // 배열도 순회한다 (#226 결함 a). BuildSpec.sources 가 배열이라
    // !Array.isArray(value) 분기가 재귀를 끊어 sources[].params.serviceKey 에
    // 도달하지 못했다.
    if (Array.isArray(value)) {
      return value.map((v, i) => scrubValue(`${key}[${i}]`, v));
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = scrubValue(k, v);
      }
      return result;
    }
    return value;
  }

  /**
   * safe run id 에 인접한 조각을 마스킹할지 판정한다. safe id 자체는 절대 여기 오지 않는다 —
   * `nonSafeLooksSecret`은 "이 토큰에서 safe id 를 전부 제거한 나머지"가 시크릿처럼 보이는지로,
   * 조각을 따로 떼면 24자 미만이 되어 엔트로피 검사를 빠져나가는 경우(`<secret>/<safeId>`)를 막는다.
   */
  function maskAdjacentFragment(fragment: string, nonSafeLooksSecret: boolean): string {
    if (!fragment || fragment.startsWith(SCRUBBED_PREFIX)) return fragment;
    if (nonSafeLooksSecret || looksLikeSecret(fragment, safeRunIds)) return replace(fragment);
    return fragment;
  }

  function scrubText(text: string): string {
    const assignmentPattern = /\b([\w-]*(?:servicekey|api[_-]?key|token|secret))([ \t]*[:=][ \t]*)([^\s,}\]]+)/gi;
    const assigned = text.replace(assignmentPattern, (_match, key: string, separator: string, value: string) => {
      const quote = value.startsWith("\"") || value.startsWith("'") ? value[0] : "";
      const raw = quote ? value.slice(1, value.endsWith(quote) ? -1 : undefined) : value;
      return `${key}${separator}${quote}${replace(raw)}${quote}`;
    });

    const scanForSecrets = (segment: string): string =>
      segment.replace(/\S{24,}/g, (token) => {
        if (token.startsWith(SCRUBBED_PREFIX) || !looksLikeSecret(token, safeRunIds)) return token;
        return replace(token);
      });

    const alternation = [...safeRunIds]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp);
    if (alternation.length === 0) return scanForSecrets(assigned);

    // 검증된 safe run id 는 "앞뒤가 영숫자가 아닌" 경계로 등장할 때만 그대로 보존한다
    // (`runId=<id>`, `/builds/<id>`, `<id>의`, 따옴표/콤마/슬래시 경계). `SECRET<id>`처럼
    // 영숫자로 직접 이어붙은 형태는 경계 검사에 걸리지 않아 토큰 전체가 스크럽된다.
    const boundary = `(?<![A-Za-z0-9])(?:${alternation.join("|")})(?![A-Za-z0-9])`;
    const safeIdTest = new RegExp(boundary);
    const safeIdSplit = new RegExp(boundary, "g");

    // 공백으로 나뉘는 토큰 단위로 처리한다. safe id 를 포함하지 않는 토큰은 기존 엔트로피
    // 검사를 그대로 받고, safe id 가 붙어 있는 토큰은 safe id 부분만 보존한 채 그 앞뒤(및
    // 사이) 비-safe 조각을 검사한다. 조각을 단순히 면제하지 않고, "safe id 를 제거한 나머지
    // 전체"가 시크릿처럼 보이면 모든 비-safe 조각을 마스킹한다 — `<secret>/<safeId>` 처럼
    // 짧게 쪼개진 시크릿 조각이 엔트로피 검사를 빠져나가지 못하게 한다.
    return assigned.replace(/\S+/g, (token) => {
      if (token.startsWith(SCRUBBED_PREFIX)) return token;
      if (!safeIdTest.test(token)) {
        return looksLikeSecret(token, safeRunIds) ? replace(token) : token;
      }
      safeIdSplit.lastIndex = 0;
      const nonSafeLooksSecret = looksLikeSecret(token.replace(safeIdSplit, ""), safeRunIds);
      safeIdSplit.lastIndex = 0;
      let out = "";
      let cursor = 0;
      for (const match of token.matchAll(safeIdSplit)) {
        const index = match.index ?? 0;
        out += maskAdjacentFragment(token.slice(cursor, index), nonSafeLooksSecret) + match[0];
        cursor = index + match[0].length;
      }
      return out + maskAdjacentFragment(token.slice(cursor), nonSafeLooksSecret);
    });
  }

  function restore(data: unknown): unknown {
    if (typeof data === "string" && data.startsWith(SCRUBBED_PREFIX)) {
      const value = placeholders.get(data);
      if (value === undefined) throw new Error(i18n.t("assistant.scrub.unknownPlaceholder"));
      return value;
    }
    if (Array.isArray(data)) return data.map(restore);
    if (data && typeof data === "object") {
      return Object.fromEntries(
        Object.entries(data as Record<string, unknown>).map(([key, value]) => [key, restore(value)]),
      );
    }
    return data;
  }

  function restoreText(text: string): string {
    return text.replace(SCRUBBED_PATTERN, (placeholder) => {
      const value = placeholders.get(placeholder);
      if (value === undefined) throw new Error(i18n.t("assistant.scrub.unknownPlaceholder"));
      return value;
    });
  }

  return { scrub: (data) => scrubValue("root", data), scrubText, restore, restoreText, placeholders };
}

export function scrubSecrets(data: unknown): ScrubResult {
  const scrubber = createSecretScrubber();
  return { scrubbed: scrubber.scrub(data), placeholders: new Map(scrubber.placeholders) };
}

export function restoreSecrets(data: unknown, placeholders: Map<string, string>): unknown {
  if (typeof data === "string" && data.startsWith(SCRUBBED_PREFIX)) {
    const value = placeholders.get(data);
    if (value === undefined) throw new Error(i18n.t("assistant.scrub.unknownPlaceholder"));
    return value;
  }
  // 배열 왕복 복원 (#226 결함 c). scrub 가 배열을 순회하므로 restore 도 같이.
  if (Array.isArray(data)) {
    return data.map((v) => restoreSecrets(v, placeholders));
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = restoreSecrets(v, placeholders);
    }
    return result;
  }
  return data;
}

export function hasSecretPlaceholder(data: unknown): boolean {
  if (typeof data === "string") {
    return SCRUBBED_TEST_PATTERN.test(data) || data.includes(REDACTED_SECRET_MARKER);
  }
  if (Array.isArray(data)) return data.some(hasSecretPlaceholder);
  if (data && typeof data === "object") {
    return Object.values(data as Record<string, unknown>).some(hasSecretPlaceholder);
  }
  return false;
}

export function redactSecrets(
  data: unknown,
  safeRunIds: ReadonlySet<string> = NO_SAFE_VALUES,
): unknown {
  const scrubber = createSecretScrubber(undefined, { safeRunIds });
  const scrubbed = scrubber.scrub(data);

  function redact(value: unknown): unknown {
    if (typeof value === "string" && hasSecretPlaceholder(value)) return REDACTED_SECRET_MARKER;
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redact(item)]),
      );
    }
    return value;
  }

  return redact(scrubbed);
}
