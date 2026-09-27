// CPUどうしの自動対戦（開発用ツール、ゲーム画面には出ない）
//
// 使い方（プロジェクトのフォルダで）:
//   node tools/cpu_arena.mjs --a v1 --b rushAll --matches 100 --map both
//
//   --a / --b    戦わせる戦い方（index.htmlのCPU_STRATEGIESのキー）
//   --matches    試合数（先手・後手の有利不利が出ないよう、AとBの陣営は1試合ごとに入れ替える）
//   --map        classic / laneSplit / both（bothは試合ごとに交互）
//   --port       内部で使うポート（既定 8799）
//
// しくみ: index.htmlをその場で読み込み、モジュールの最後に計測用の関数（window.__arena）を差し込んで
// ローカル配信し、ヘッドレスChromeで開く。試合は実際のゲームの関数（simulateBattle・ラウンド進行・
// 勝敗判定）をそのまま使って進めるので、結果はゲーム本体と同じルールで決まる。index.html自体は変更しない。
// Chromeは C:/Program Files/Google/Chrome/Application/chrome.exe を使う（別の場所なら CHROME_PATH で指定）。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
let A = args.a || "v1", B = args.b || "rushAll";
// 例: --a-opts '{"defPerBase":[1,1,2,2],"nearWeight":120}' （defPerBaseはR1〜R4の配列）
const A_OPTS = args["a-opts"] ? JSON.parse(args["a-opts"]) : null;
const B_OPTS = args["b-opts"] ? JSON.parse(args["b-opts"]) : null;
const MATCHES = parseInt(args.matches || "50", 10);
const MAP = args.map || "both";
const PORT = parseInt(args.port || "8799", 10);
const CDP_PORT = PORT + 1;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

// ページのモジュールスコープに差し込む計測用コード。1試合を最後まで進めて結果を返す
const ARENA_HOOK = `
window.__arena = {
  strategies: Object.keys(CPU_STRATEGIES),
  // --a-opts/--b-opts: 攻守バランス型（cpuBalancedTurn）の設定を一部だけ変えた戦い方をその場で作る
  defineBalanced(name, opts) {
    CPU_STRATEGIES[name] = owner => cpuBalancedTurn(owner, { ...CPU_BALANCED_DEFAULT, ...opts });
    return Object.keys(CPU_STRATEGIES);
  },
  runMatch(stratA, stratB, mapId, aIsP1) {
    cpuArenaMode = true;
    setMap(mapId);
    resetGameState();
    const strat = { player1: aIsP1 ? stratA : stratB, player2: aIsP1 ? stratB : stratA };
    cpuInitSide("player1"); cpuInitSide("player2");
    let outcome = null;
    for (let guard = 0; guard < 8; guard++) {
      cpuTakeTurn("player1", strat.player1);
      cpuTakeTurn("player2", strat.player2);
      for (const owner of ["player1", "player2"]) for (const u of cpuSides[owner].pending) units.push(u);
      cpuClearPending();
      document.getElementById("seedInput").value = Math.floor(Math.random() * 2147483647);
      // 終わらない戦闘があった時に再現できるよう、開戦直前の状態を控えておく
      window.__arenaLast = JSON.parse(JSON.stringify({ map: mapId, round: currentRound, seed: document.getElementById("seedInput").value,
        units, bases, traps: persistentTraps, tempWalls: [...tempWalls] }));
      enterBattleMode();
      skipToEnd();
      outcome = roundOutcome;
      if (outcome.endReason !== "roundEnd" || currentRound >= 4) break;
      advanceToNextRound();
      cpuRegeneratePool("player1", currentRound); cpuRegeneratePool("player2", currentRound);
    }
    document.getElementById("matchResultScrim").classList.remove("open");
    const aRole = aIsP1 ? "player1" : "player2";
    const winner = outcome.winner === "draw" ? "draw" : (outcome.winner === aRole ? "A" : "B");
    const baseHp = owner => roundOutcome.bases.filter(b => b.owner === owner).reduce((s, b) => s + b.hp, 0);
    const res = { winner, round: currentRound, reason: outcome.endReason, map: mapId, aIsP1,
      aBaseHp: baseHp(aRole), bBaseHp: baseHp(aIsP1 ? "player2" : "player1") };
    exitBattleMode();
    cpuArenaMode = false;
    return res;
  },
};
`;

// --- 配信（index.htmlだけ差し込み済みの内容を返す） ---
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/" || p === "/arena.html") {
    let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const i = html.lastIndexOf("</script>");
    html = html.slice(0, i) + ARENA_HOOK + html.slice(i);
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    return res.end(html);
  }
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

// --- ヘッドレスChromeをCDPで操作 ---
// プロファイルは使い回す（毎回新しくすると、起動時のデッキ読み込みがFirebaseに新しい端末IDの
// デッキを毎回作ってしまうため）
const profile = path.join(process.env.TEMP || "/tmp", `afbe_arena_profile_${PORT}`); // 同時に複数動かせるようポートごとに分ける
fs.mkdirSync(profile, { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--mute-audio", "about:blank"]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tabs;
for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(tabs.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let seq = 0; const pending = new Map(); const pageErrors = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr, timeout) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, ...(timeout ? { timeout } : {}) });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "evaluate failed");
  return r.result.result.value;
};
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/arena.html` });
for (let i = 0; i < 40; i++) { await sleep(250); if (await evaluate("!!window.__arena").catch(() => false)) break; }
let known = await evaluate("window.__arena.strategies");
if (A_OPTS) { A = `${A}+${JSON.stringify(A_OPTS)}`; known = await evaluate(`window.__arena.defineBalanced(${JSON.stringify(A)}, ${JSON.stringify(A_OPTS)})`); }
if (B_OPTS) { B = `${B}+${JSON.stringify(B_OPTS)}`; known = await evaluate(`window.__arena.defineBalanced(${JSON.stringify(B)}, ${JSON.stringify(B_OPTS)})`); }
for (const s of [A, B]) if (!known.includes(s)) { console.error(`不明な戦い方: ${s}（使えるもの: ${known.join(", ")}）`); process.exit(1); }

// --- 対戦 ---
const results = [];
const t0 = Date.now();
for (let i = 0; i < MATCHES; i++) {
  const mapId = MAP === "both" ? (Math.floor(i / 2) % 2 === 0 ? "classic" : "laneSplit") : MAP;
  const aIsP1 = i % 2 === 0;
  try {
    // 1試合30秒で打ち切る（終わらない戦闘があってもツール全体が止まらないように）
    results.push(await evaluate(`window.__arena.runMatch(${JSON.stringify(A)}, ${JSON.stringify(B)}, ${JSON.stringify(mapId)}, ${aIsP1})`, 30000));
  } catch (err) {
    const last = await evaluate("JSON.stringify(window.__arenaLast)").catch(() => null);
    const dump = path.join(ROOT, "tools", `arena_timeout_${Date.now()}.json`);
    if (last) fs.writeFileSync(dump, last);
    console.log(`  ${i + 1}試合目が終わりませんでした（${String(err.message).split("\n")[0]}）。直前の戦闘の状態: ${last ? dump : "取得失敗"}`);
    results.push({ winner: "timeout", round: 0, reason: "timeout", map: mapId, aIsP1 });
  }
  if ((i + 1) % 10 === 0 || i + 1 === MATCHES) process.stdout.write(`  ${i + 1}/${MATCHES} 試合 (${((Date.now() - t0) / 1000).toFixed(0)}秒)\n`);
}

// --- 集計 ---
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
if (pageErrors.length) console.log(`\nページ内エラー ${pageErrors.length}件:\n` + [...new Set(pageErrors)].slice(0, 5).join("\n"));

ws.close(); chrome.kill(); server.close();
process.exit(0);
