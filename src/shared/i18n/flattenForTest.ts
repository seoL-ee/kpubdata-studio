/** 테스트용 로케일 JSON 평탄화 — 키 집합 비교에 쓴다. */
export function flattenForTest(resource: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const walk = (node: unknown, prefix: string) => {
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        walk(value, prefix ? `${prefix}.${key}` : key);
      }
    } else {
      keys.add(prefix);
    }
  };
  walk(resource, "");
  return keys;
}
