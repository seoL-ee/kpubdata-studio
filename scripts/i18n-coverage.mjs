/**
 * i18n 추출 커버리지 리포트 — 아직 로케일로 빠지지 않은 **사용자 대상 문자열**을 센다.
 *
 * 사용법:
 *   npm run i18n:coverage            # 리포트만
 *   npm run i18n:coverage -- --top N # 상위 N개 파일
 *   npm run i18n:coverage -- --check # 기준선 초과 시 exit 1 (CI 게이트)
 *
 * 왜 줄 단위 grep 을 버렸는가: 이 저장소는 주석을 한국어로 쓴다(의도된 정책).
 * "한국어를 포함한 줄"을 세면 지표가 주석에 파묻혀, 2026-09-19 측정에서 3,504줄
 * 중 3,348줄이 주석이었다 — 남은 추출 작업을 실제의 20배로 부풀린 셈이다. 그래서
 * TypeScript 스캐너로 파싱해 **문자열 리터럴과 JSX 텍스트만** 센다. 주석과 정규식
 * 리터럴(`[가-힣]` 같은 문자 클래스)은 애초에 후보에 오르지 않는다.
 *
 * 개별 예외: 번역 대상이 아닌 한국어 문자열에는 바로 위(또는 같은) 줄에
 * `i18n-ignore: <이유>` 주석을 단다. 파일 통째로 빼는 CONTENT_NOT_UI 보다 좁아서,
 * 같은 파일에 UI 문구와 LLM 프롬프트가 섞여 있어도 게이트가 계속 작동한다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const KOREAN = /[\u{AC00}-\u{D7AF}]/u;
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);
const SKIP_SUFFIX = [".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", ".d.ts"];
const ROOT = new URL("../src", import.meta.url).pathname;

/**
 * 한국어가 UI 문구가 아니라 콘텐츠 그 자체라서 추출 대상이 아닌 파일들.
 * - mock/demo 데이터: "아파트 실거래가"는 번역할 문구가 아니라 실제 데이터셋 이름이다.
 * - LLM 프롬프트: 어시스턴트의 출력 언어·품질을 바꾸는 건 별개 결정이다(#350).
 * - 로케일 파일과 언어 이름("한국어")은 원어로 남는 게 맞다.
 */
const CONTENT_NOT_UI = [
  /\/api\/mockData\.ts$/,
  /^shared\/lib\/demoDatasets\.ts$/,
  /^features\/add-data\/api\.ts$/,
  /^features\/discover\/api\.ts$/,
  /^features\/preview\/api\/index\.ts$/,
  /^features\/kubi\/(demo|prompt)\.ts$/,
  /^features\/assistant\/(columnMeaning|AssistantChat)\.tsx?$/,
  /^features\/build-spec\/templates\.ts$/,
  /^pages\/ProviderPage\.tsx$/,
  /^shared\/i18n\//,
];

/** 남은 미추출 문자열의 허용 상한. 0으로 유지하고 올리지 않는다. */
const BASELINE = 0;

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

const IGNORE_MARKER = /i18n-ignore/;

/** 해당 줄 또는 바로 위 비어있지 않은 줄에 `i18n-ignore` 주석이 있는지 본다. */
function isIgnored(textLines, line) {
  if (IGNORE_MARKER.test(textLines[line - 1] ?? "")) return true;
  for (let i = line - 2; i >= 0; i--) {
    const above = (textLines[i] ?? "").trim();
    if (above === "") continue;
    return IGNORE_MARKER.test(above);
  }
  return false;
}

/**
 * 파일에서 한국어를 담은 문자열 리터럴·템플릿·JSX 텍스트의 줄 번호를 모은다.
 * 여러 줄 템플릿은 조각마다가 아니라 템플릿이 시작하는 줄 하나로 센다 — 그래야
 * 프롬프트 한 덩어리에 `i18n-ignore` 주석 하나로 예외를 달 수 있다.
 */
function koreanStringLines(file, source, textLines) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = new Set();
  const record = (node, text) => {
    if (!KOREAN.test(text)) return;
    let anchor = node;
    // TemplateMiddle/Tail 의 부모는 TemplateSpan 이라 시작 위치가 `${}` 자리다 —
    // 템플릿 전체가 시작하는 줄까지 올라가야 한 덩어리로 모인다.
    while (anchor.parent && !ts.isTemplateExpression(anchor) && ts.isTemplateLiteralToken(anchor)) {
      anchor = anchor.parent;
      while (anchor.parent && !ts.isTemplateExpression(anchor)) anchor = anchor.parent;
    }
    const line = sourceFile.getLineAndCharacterOfPosition(anchor.getStart(sourceFile)).line + 1;
    if (isIgnored(textLines, line)) return;
    lines.add(line);
  };
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
      case ts.SyntaxKind.JsxText:
        record(node, node.text);
        break;
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

const argv = process.argv.slice(2);
const topIndex = argv.indexOf("--top");
const parsedTop = topIndex === -1 ? NaN : Number(argv[topIndex + 1]);
const topN = Number.isFinite(parsedTop) ? parsedTop : 15;
const check = argv.includes("--check");
const verbose = argv.includes("--list");

const rows = [];
let total = 0;
let contentTotal = 0;

for (const file of walk(ROOT)) {
  const rel = file.replace(ROOT + "/", "");
  const source = readFileSync(file, "utf8");
  const textLines = source.split("\n");
  const lines = koreanStringLines(rel, source, textLines);
  if (lines.size === 0) continue;
  if (CONTENT_NOT_UI.some((pattern) => pattern.test(rel))) {
    contentTotal += lines.size;
    continue;
  }
  total += lines.size;
  rows.push({ file: rel, count: lines.size, lines: [...lines].sort((a, b) => a - b), textLines });
}

rows.sort((a, b) => b.count - a.count);
console.log(`i18n 커버리지: 미추출 사용자 문자열 ${total}줄 / 파일 ${rows.length}개 (기준선 ${BASELINE})`);
console.log(`제외: 한국어 콘텐츠·LLM 프롬프트 ${contentTotal}줄 — CONTENT_NOT_UI 참조. 주석은 세지 않는다.`);
for (const row of rows.slice(0, topN)) {
  console.log(`${String(row.count).padStart(5)}  ${row.file}`);
  if (!verbose) continue;
  for (const line of row.lines) console.log(`        ${line}: ${row.textLines[line - 1].trim().slice(0, 120)}`);
}

if (check && total > BASELINE) {
  console.error(
    `\n실패: 미추출 사용자 문자열이 ${total}줄로 기준선 ${BASELINE}을 넘었습니다.\n` +
      `새 문자열은 src/shared/i18n/locales/{ko,en}.json 으로 빼고 t()로 참조하세요.\n` +
      `번역 대상이 아니라면 그 줄 위에 \`// i18n-ignore: <이유>\` 주석을 달거나,\n` +
      `파일 전체가 콘텐츠라면 scripts/i18n-coverage.mjs 의 CONTENT_NOT_UI 에 근거와 함께 추가하세요.`,
  );
  process.exit(1);
}
