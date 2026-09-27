// CPUの設定（攻守バランス型 cpuBalancedTurn の opts）を自動対戦で探索する（開発用ツール）
//
// 使い方（プロジェクトのフォルダで）:
//   node tools/cpu_evolve.mjs --gens 10 --pop 12 --matches 16 --workers 3
//
//   --gens     世代数
//   --pop      1世代の候補数
//   --elite    次の世代へそのまま残す上位の数（既定 4。残った候補も毎世代あらためて評価し直す）
//   --matches  候補1つが「相手1種類」と戦う試合数（陣営・マップは交互）
//   --workers  同時に動かすヘッドレスChromeの数
//
// やっていること（進化的な探索）:
//   1. 候補（設定の組み合わせ）を用意する。最初の世代は今のv2の設定＋ランダムに変えたもの
//   2. 各候補を「比較相手の一覧」（全員突撃・v1・v2・片側攻め×2・前の世代の優勝者）と戦わせ、勝率を出す
//   3. 勝率の高い候補を残し、それを少し変えたもの（突然変異）・2つを混ぜたもの（交叉）で残りを埋める
//   4. 2〜3を繰り返す。各世代の結果は tools/evolve_result.json に保存（途中で止めても残る）
//
// 勝率は「CPUどうし」でのものなので、人間相手の強さは別途確かめる必要がある。

import fs from "node:fs";
import path from "node:path";
import { startArena, ROOT } from "./arena_lib.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
const GENS = parseInt(args.gens || "10", 10);
const POP = parseInt(args.pop || "12", 10);
const ELITE = parseInt(args.elite || "4", 10);
const MATCHES = parseInt(args.matches || "16", 10);
const WORKERS = parseInt(args.workers || "3", 10);
const OUT = path.join(ROOT, "tools", "evolve_result.json");

// --- 探索する設定の範囲 ---
const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const pick = list => list[Math.floor(Math.random() * list.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SPACE = {
  defPerBase: { rand: () => [rint(0, 2), rint(0, 2), rint(0, 2), rint(0, 2)], mutate: v => v.map(x => Math.random() < 0.35 ? clamp(x + pick([-1, 1]), 0, 2) : x) },
  guardRadius: { rand: () => rint(1, 3), mutate: v => clamp(v + pick([-1, 1]), 1, 3) },
  nearWeight: { rand: () => Math.round(rnd(0, 250)), mutate: v => Math.round(clamp(v + rnd(-60, 60), 0, 250)) },
  targetNoise: { rand: () => Math.round(rnd(0, 120)), mutate: v => Math.round(clamp(v + rnd(-40, 40), 0, 120)) },
  atkRangedRatio: { rand: () => +rnd(0, 0.5).toFixed(2), mutate: v => +clamp(v + rnd(-0.15, 0.15), 0, 0.5).toFixed(2) },
  atkPick: { rand: () => pick(["random", "strong", "efficient"]), mutate: () => pick(["random", "strong", "efficient"]) },
  atkGoal: { rand: () => pick(["adjacent", "rush"]), mutate: v => (v === "adjacent" ? "rush" : "adjacent") },
  supportDist: { rand: () => rint(1, 3), mutate: v => clamp(v + pick([-1, 1]), 1, 3) },
};
// 今のv2の設定（index.htmlのCPU_BALANCED_DEFAULTと同じ値）。最初の世代にそのまま入れて基準にする
const V2 = { defPerBase: [0, 1, 1, 1], guardRadius: 2, nearWeight: 80, targetNoise: 40, atkRangedRatio: 0, atkPick: "strong", atkGoal: "adjacent", supportDist: 2 };
const randomGenome = () => Object.fromEntries(Object.entries(SPACE).map(([k, s]) => [k, s.rand()]));
function mutate(g) {
  const child = JSON.parse(JSON.stringify(g));
  const keys = Object.keys(SPACE);
  const n = rint(1, 3); // 1〜3項目を変える
  for (let i = 0; i < n; i++) { const k = pick(keys); child[k] = SPACE[k].mutate(child[k]); }
  return child;
}
const crossover = (a, b) => Object.fromEntries(Object.keys(SPACE).map(k => [k, JSON.parse(JSON.stringify(Math.random() < 0.5 ? a[k] : b[k]))]));
const nameOf = g => "evo" + JSON.stringify(g);

// --- 並列実行 ---
const arenas = [];
for (let w = 0; w < WORKERS; w++) arenas.push(await startArena(8900 + w * 10));
async function runJobs(jobs) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(arenas.map(async arena => {
    while (next < jobs.length) {
      const idx = next++;
      const j = jobs[idx];
      for (const [name, opts] of [[j.a, j.aOpts], [j.b, j.bOpts]]) if (opts) await arena.defineBalanced(name, opts);
      results[idx] = await arena.runMatch(j.a, j.b, j.map, j.aIsP1);
    }
  }));
  return results;
}

const BASE_OPPONENTS = ["rushAll", "v1", "v2", "habitLeft", "habitRight"];
let population = [V2, ...Array.from({ length: POP - 1 }, (_, i) => (i < POP / 2 ? mutate(V2) : randomGenome()))];
let champion = null; // 前の世代の優勝者（強い相手としても使う）
const history = [];
const t0 = Date.now();

for (let gen = 1; gen <= GENS; gen++) {
  const opponents = BASE_OPPONENTS.map(n => ({ name: n, opts: null }));
  if (champion) opponents.push({ name: "champ" + nameOf(champion), opts: champion });
  const jobs = [];
  population.forEach((g, gi) => {
    for (const opp of opponents) {
      for (let m = 0; m < MATCHES; m++) {
        jobs.push({ gi, opp: opp.name, a: nameOf(g), aOpts: g, b: opp.name, bOpts: opp.opts,
          map: Math.floor(m / 2) % 2 === 0 ? "classic" : "laneSplit", aIsP1: m % 2 === 0 });
      }
    }
  });
  const res = await runJobs(jobs);
  const stats = population.map(g => ({ genome: g, games: 0, points: 0, byOpp: {} }));
  res.forEach((r, i) => {
    const j = jobs[i], st = stats[j.gi];
    const pt = r.winner === "A" ? 1 : r.winner === "draw" ? 0.5 : 0;
    st.games++; st.points += pt;
    st.byOpp[j.opp.startsWith("champ") ? "champ" : j.opp] = (st.byOpp[j.opp.startsWith("champ") ? "champ" : j.opp] || 0) + pt / MATCHES;
  });
  stats.forEach(s => { s.winRate = s.points / s.games; });
  stats.sort((a, b) => b.winRate - a.winRate);
  champion = stats[0].genome;
  history.push({ gen, top: stats.slice(0, 5).map(s => ({ winRate: +s.winRate.toFixed(3), byOpp: Object.fromEntries(Object.entries(s.byOpp).map(([k, v]) => [k, +v.toFixed(2)])), genome: s.genome })) });
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), settings: { GENS, POP, ELITE, MATCHES }, best: stats[0].genome, history }, null, 1));
  const fmt = s => `${(100 * s.winRate).toFixed(1)}% ${Object.entries(s.byOpp).map(([k, v]) => `${k}:${Math.round(v * 100)}`).join(" ")}`;
  console.log(`第${gen}世代 (${((Date.now() - t0) / 60000).toFixed(1)}分) 1位 ${fmt(stats[0])}\n  設定 ${JSON.stringify(stats[0].genome)}\n  2位 ${fmt(stats[1])}  3位 ${fmt(stats[2])}`);

  // 次の世代: 上位ELITEをそのまま残し、残りは上位からの突然変異・交叉
  const elites = stats.slice(0, ELITE).map(s => s.genome);
  const children = [];
  while (children.length < POP - ELITE) {
    children.push(Math.random() < 0.3 ? mutate(crossover(pick(elites), pick(elites))) : mutate(pick(elites)));
  }
  population = [...elites, ...children];
}

const errors = arenas.flatMap(a => a.pageErrors);
if (errors.length) console.log(`ページ内エラー ${errors.length}件:\n` + [...new Set(errors)].slice(0, 5).join("\n"));
console.log(`\n最良の設定: ${JSON.stringify(champion)}\n結果: ${OUT}`);
arenas.forEach(a => a.close());
process.exit(0);
