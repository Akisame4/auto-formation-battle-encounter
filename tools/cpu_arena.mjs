// CPUどうしの自動対戦で2つの戦い方の勝率を比べる（開発用ツール、ゲーム画面には出ない）
//
// 使い方（プロジェクトのフォルダで）:
//   node tools/cpu_arena.mjs --a v2 --b rushAll --matches 400 --map both
//
//   --a / --b          戦わせる戦い方（index.htmlのCPU_STRATEGIESのキー）
//   --a-opts / --b-opts 攻守バランス型の設定の一部をJSONで上書き（例: '{"defPerBase":[0,1,1,2]}'、defPerBaseはR1〜R4の配列）
//   --matches          試合数（先手・後手の有利不利が出ないよう、AとBの陣営は1試合ごとに入れ替える）
//   --map              classic / laneSplit / both（bothは2試合ごとに交互）
//   --port             内部で使うポート（既定 8799。同時に複数動かす時は別の番号に）
//
// しくみは arena_lib.mjs を参照。

import { startArena } from "./arena_lib.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
let A = args.a || "v2", B = args.b || "rushAll";
const A_OPTS = args["a-opts"] ? JSON.parse(args["a-opts"]) : null;
const B_OPTS = args["b-opts"] ? JSON.parse(args["b-opts"]) : null;
const MATCHES = parseInt(args.matches || "50", 10);
const MAP = args.map || "both";
const PORT = parseInt(args.port || "8799", 10);

const arena = await startArena(PORT);
const known = await arena.strategies();
if (A_OPTS) { A = `${A}+${JSON.stringify(A_OPTS)}`; await arena.defineBalanced(A, A_OPTS); known.push(A); }
if (B_OPTS) { B = `${B}+${JSON.stringify(B_OPTS)}`; await arena.defineBalanced(B, B_OPTS); known.push(B); }
for (const s of [A, B]) if (!known.includes(s)) { console.error(`不明な戦い方: ${s}（使えるもの: ${known.join(", ")}）`); arena.close(); process.exit(1); }

const results = [];
const t0 = Date.now();
for (let i = 0; i < MATCHES; i++) {
  const mapId = MAP === "both" ? (Math.floor(i / 2) % 2 === 0 ? "classic" : "laneSplit") : MAP;
  results.push(await arena.runMatch(A, B, mapId, i % 2 === 0));
  if ((i + 1) % 10 === 0 || i + 1 === MATCHES) process.stdout.write(`  ${i + 1}/${MATCHES} 試合 (${((Date.now() - t0) / 1000).toFixed(0)}秒)\n`);
}

const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : "-";
function summarize(list, label) {
  const w = list.filter(r => r.winner === "A").length, l = list.filter(r => r.winner === "B").length, d = list.length - w - l;
  console.log(`${label.padEnd(18)} ${String(list.length).padStart(4)}試合  ${A}の勝ち ${pct(w, list.length).padStart(6)}  ${B}の勝ち ${pct(l, list.length).padStart(6)}  引分 ${pct(d, list.length).padStart(6)}`);
}
console.log(`\n=== ${A}（A） vs ${B}（B） ===`);
summarize(results, "全体");
for (const m of ["classic", "laneSplit"]) { const l = results.filter(r => r.map === m); if (l.length) summarize(l, `マップ ${m}`); }
summarize(results.filter(r => r.aIsP1), `${A}が1P側`);
summarize(results.filter(r => !r.aIsP1), `${A}が2P側`);
const reasons = {};
for (const r of results) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
const reasonLabel = { annihilation: "全滅", baseFall: "拠点陥落", roundEnd: "4R終了時の判定" };
console.log("決着の仕方: " + Object.entries(reasons).map(([k, v]) => `${reasonLabel[k] || k} ${v}`).join(" / "));
console.log(`平均決着ラウンド: ${(results.reduce((s, r) => s + r.round, 0) / results.length).toFixed(2)}`);
if (arena.pageErrors.length) console.log(`\nページ内エラー ${arena.pageErrors.length}件:\n` + [...new Set(arena.pageErrors)].slice(0, 5).join("\n"));
arena.close();
process.exit(0);
