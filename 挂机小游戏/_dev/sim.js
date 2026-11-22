/* 金币工厂 —— 经济模拟器（含完整核心循环）
 *
 * 目的：量化「手动点击 vs 被动收入」的占比，并验证财富曲线能否指数化增长。
 * 方法：模拟一个理性玩家 —— 每秒把钱投给「回本时间最短且买得起」的升级，
 *       财富达到重生门槛就重生（换声望/水晶），持续推进。
 *
 * 性能：不走游戏自带的 buy()（它每次都存档 + 全量重渲染 DOM），
 *       而是直接改写 owned/money，复刻同一套 cost/payback 口径。
 *
 * 运行：node _dev/sim.js [秒数]
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', '金币工厂.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

function makeCtx2d() {
  const grad = { addColorStop() {} };
  const noop = () => {};
  return new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (p === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return () => grad;
      return noop;
    },
    set() { return true; }
  });
}

function boot() {
  const vc = new VirtualConsole();
  vc.on('error', () => {});
  vc.on('warn', () => {});
  vc.on('jsdomError', () => {});
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://local.test/game',
    virtualConsole: vc,
    beforeParse(window) {
      class FakeParam { constructor() { this.value = 0; } setValueAtTime() {} exponentialRampToValueAtTime() {} linearRampToValueAtTime() {} }
      class FakeNode { constructor() { this.frequency = new FakeParam(); this.gain = new FakeParam(); this.type = 'sine'; } connect() { return this; } disconnect() {} start() {} stop() {} }
      class FakeCtx { constructor() { this.currentTime = 0; this.destination = new FakeNode(); this.state = 'running'; } createOscillator() { return new FakeNode(); } createGain() { return new FakeNode(); } createBiquadFilter() { return new FakeNode(); } resume() {} suspend() {} }
      window.AudioContext = FakeCtx;
      window.webkitAudioContext = FakeCtx;
      window.HTMLCanvasElement.prototype.getContext = function () { return makeCtx2d(); };
      window.Element.prototype.scrollIntoView = function () {};
      window.confirm = function () { return true; };
      window.alert = function () {};
    }
  });
  return dom.window;
}

function fmt(n) {
  if (!isFinite(n)) return '∞';
  const units = [[1e15, '千万亿'], [1e12, '兆'], [1e8, '亿'], [1e4, '万']];
  for (const [v, u] of units) if (n >= v) return (n / v).toFixed(2) + u;
  return Math.round(n).toString();
}

const CPS = 8;
const SECONDS = Number(process.argv[2] || 7200);
const MARKS = [60, 300, 900, 1800, 3600, 7200, 14400].filter(m => m <= SECONDS);
if (!MARKS.includes(SECONDS)) MARKS.push(SECONDS);

console.log('▶ 金币工厂 经济模拟（含重生循环）');
console.log(`  点击频率 ${CPS} 次/秒 · 模拟 ${SECONDS} 秒 · 策略：回本最短优先 + 达标即重生\n`);

const w = boot();
const G = code => w.eval(code);

G(`state = Object.assign(defaultState(), {money:0,total:0,owned:{},ach:{},perks:{},perkPoints:0,`
  + `crystals:0,prestige:0,prestigePath:"balance",challenge:null,challengeMult:1,market:null,src:{},srcDays:{},`
  + `ms:{},quest:{date:"",ids:[],progress:{},claimed:{},bonusClaimed:false,pkStartGiven:0}});`);

const rows = [];
let mi = 0;
let prestiges = 0;

for (let sec = 1; sec <= SECONDS; sec++) {
  // —— 点击 ——
  const clicks = Math.round(CPS * (0.9 + Math.random() * 0.2));
  for (let i = 0; i < clicks; i++) {
    const gain = G('clickPower()');
    G(`state.money += ${gain}; state.total += ${gain};`);
  }

  // —— 理性购买：回本最短优先，买到买不动为止 ——
  let guard = 0;
  for (;;) {
    if (++guard > 300) break;
    const pick = w.eval(`(() => {
      const cands = UPGRADES.filter(u => u.type === 'auto' || u.type === 'click' || u.type === 'mult')
        .map(u => ({ id: u.id, pb: paybackOf(u), c: cost(u) }))
        .filter(x => x.c <= state.money)
        .sort((a, b) => a.pb - b.pb);
      return cands.length ? cands[0] : null;
    })()`);
    if (!pick) break;
    const ok = w.eval(`(() => {
      const u = UPGRADES.find(x => x.id === "${pick.id}");
      const c = cost(u);
      if (state.money < c) return false;
      state.money -= c; state.owned[u.id] = (state.owned[u.id] || 0) + 1;
      return true;
    })()`);
    if (!ok) break;
  }

  // —— 重生：总财富够且有可领声望就转生（复刻 doPrestige 的核心账目） ——
  // 策略：攒到「至少 3 点声望」再转生，避免每次只换 1 点却清零重建
  const pg = w.eval('prestigeAvailable()');
  if (w.eval('canPrestige()') && pg >= 3) {
    const path = w.eval('prestigePath()');
    const repGain = Math.round(pg * path.rep);
    const crysGain = Math.round(pg * path.crys);
    G(`state.prestige += ${repGain}; state.crystals = (state.crystals||0) + ${crysGain};`);
    G('state.money = 0; state.owned = {}; state.clicks = 0;');
    // 天赋「细水长流」保留部分累计财富作为启动资金
    const keep = w.eval('perkKeepRatio()');
    if (keep > 0) G(`state.money = state.total * ${keep};`);
    prestiges++;
  }

  if (mi < MARKS.length && sec === MARKS[mi]) {
    mi++;
    const st = G('({total: state.total, prestige: state.prestige, crystals: state.crystals, autoLv: staffTotal(), clickLv: UPGRADES.filter(u=>u.type==="click").reduce((a,u)=>a+(state.owned[u.id]||0),0), multLv: UPGRADES.filter(u=>u.type==="mult").reduce((a,u)=>a+(state.owned[u.id]||0),0)})');
    rows.push({
      t: sec,
      total: st.total,
      ips: G('incomePerSec()'),
      clickPower: G('clickPower()'),
      autoLv: st.autoLv,
      clickLv: st.clickLv,
      multLv: st.multLv,
      prestige: st.prestige,
      crystals: st.crystals,
      mult: G('multBonus()')
    });
  }
}

console.log('  时间 | 累计财富 | 每秒收入 | 声望 | 水晶 | 产业级 | 员工级 | 点击级 | 被动/主动');
for (const r of rows) {
  const active = r.clickPower * CPS;
  const ratio = active > 0 ? r.ips / active : Infinity;
  console.log(
    `  ${String(r.t).padStart(4)}s | ¥${fmt(r.total).padStart(11)} | ¥${fmt(r.ips).padStart(9)}` +
    ` | ${String(r.prestige).padStart(4)} | ${String(r.crystals).padStart(4)}` +
    ` | ${String(r.multLv).padStart(6)} | ${String(r.autoLv).padStart(6)} | ${String(r.clickLv).padStart(6)}` +
    ` | ${(ratio * 100).toFixed(0)}%`
  );
}

const last = rows[rows.length - 1];
const active = last.clickPower * CPS;
const ratio = last.ips / active;

console.log('\n  体检');
console.log(`  重生次数 ${prestiges} ｜ 声望 ${last.prestige} ｜ 水晶 ${last.crystals} ｜ 产业倍率 ×${last.mult.toFixed(2)}`);
console.log(`  被动产出 ¥${fmt(last.ips)}/秒  vs  手动点击产出 ¥${fmt(active)}/秒  → 比值 ${(ratio * 100).toFixed(0)}%`);
console.log(`  末段累计财富 ¥${fmt(last.total)}`);

/* 曲线是否指数化：看后半段每分钟的财富倍率 */
if (rows.length >= 2) {
  const a = rows[Math.floor(rows.length / 2)], b = rows[rows.length - 1];
  const dt = (b.t - a.t) / 3600;
  const mult = b.total / Math.max(1, a.total);
  console.log(`  后半段 ${dt.toFixed(1)} 小时内财富 ×${fmt(mult)}（每 ${(dt / Math.max(1e-9, Math.log(mult) / Math.log(2))).toFixed(1)} 小时翻倍）`);
}

const ok = ratio >= 1;
console.log(ok
  ? '  ✅ 被动收入 ≥ 手动点击产出 —— 核心循环成立'
  : '  ❌ 手动点击产出更高 —— 核心循环被架空');

w.close();
process.exit(ok ? 0 : 1);
