/**
 * i18n 추출 커버리지 리포트 — 한국어 코드포인트를 포함한 줄 수를 파일별로 집계한다.
 *
 * 사용법: npm run i18n:coverage [-- --top N]
 * 출력: 총계 + 파일별 내림차순. 게이트가 아니라 진행 지표다(점진적 전환 추적).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KOREAN = /[\u{AC00}-\u{D7AF}]/u;
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);
const SKIP_SUFFIX = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts"];
const ROOT = new URL("../src", import.meta.url).pathname;

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name)) entries.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(name) && !SKIP_SUFFIX.some((s) => name.endsWith(s))) {
      entries.push(full);
    }
  }
  return entries;
}

const topN = Number(process.argv[process.argv.indexOf("--top") + 1] ?? 15);
const rows = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  const count = lines.filter((line) => KOREAN.test(line)).length;
  if (count > 0) rows.push({ file: file.replace(ROOT + "/", ""), count });
}
rows.sort((a, b) => b.count - a.count);
const total = rows.reduce((sum, row) => sum + row.count, 0);
console.log(`i18n 커버리지: 미추출 한국어 라인 총 ${total}줄 / 파일 ${rows.length}개`);
console.log("(측정 기준: 한국어 코드포인트 포함 줄, 테스트 파일 제외 — 진행 지표이지 게이트가 아님)");
for (const row of rows.slice(0, topN)) {
  console.log(`${String(row.count).padStart(5)}  ${row.file}`);
}
