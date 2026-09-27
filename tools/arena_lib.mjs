// CPUどうしの自動対戦の共通部品（開発用）。cpu_arena.mjs・cpu_evolve.mjs から使う。
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

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

// ページのモジュールスコープに差し込む計測用コード。1試合を最後まで進めて結果を返す
const ARENA_HOOK = `
window.__arena = {
  strategies: Object.keys(CPU_STRATEGIES),
  // 攻守バランス型（cpuBalancedTurn）の設定を一部だけ変えた戦い方をその場で作る
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

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".css": "text/css" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1つのヘッドレスChrome＋配信サーバを立ち上げる。portごとに独立しているので複数同時に動かせる
export async function startArena(port) {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
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
  await new Promise(r => server.listen(port, "127.0.0.1", r));

  // プロファイルはポートごとに使い回す（毎回新しくすると、起動時のデッキ読み込みがFirebaseに新しい端末IDの
  // デッキを毎回作ってしまう。同じプロファイルを同時に2つのChromeで使うと起動できず止まって見える）
  const cdpPort = port + 1;
  const profile = path.join(process.env.TEMP || "/tmp", `afbe_arena_profile_${port}`);
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--mute-audio", "about:blank"]);
  let tabs;
  for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(250); } }
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
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/arena.html` });
  for (let i = 0; i < 40; i++) { await sleep(250); if (await evaluate("!!window.__arena").catch(() => false)) break; }

  const defined = new Set();
  return {
    pageErrors,
    strategies: () => evaluate("window.__arena.strategies"),
    // 攻守バランス型の設定違いを登録（同じ名前は1回だけ）
    async defineBalanced(name, opts) {
      if (defined.has(name)) return;
      await evaluate(`window.__arena.defineBalanced(${JSON.stringify(name)}, ${JSON.stringify(opts)})`);
      defined.add(name);
    },
    // 1試合。30秒で終わらなければ打ち切り、開戦直前の状態を tools/arena_timeout_*.json に保存して timeout を返す
    async runMatch(a, b, mapId, aIsP1) {
      try {
        return await evaluate(`window.__arena.runMatch(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(mapId)}, ${aIsP1})`, 30000);
      } catch (err) {
        const last = await evaluate("JSON.stringify(window.__arenaLast)").catch(() => null);
        const dump = path.join(ROOT, "tools", `arena_timeout_${Date.now()}.json`);
        if (last) fs.writeFileSync(dump, last);
        console.log(`  試合が終わりませんでした（${String(err.message).split("\n")[0]}）。直前の戦闘の状態: ${last ? dump : "取得失敗"}`);
        return { winner: "timeout", round: 0, reason: "timeout", map: mapId, aIsP1 };
      }
    },
    close() { try { ws.close(); } catch {} chrome.kill(); server.close(); },
  };
}
