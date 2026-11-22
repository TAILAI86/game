/* 金币工厂 —— 挑战可达性测量
 *
 * 目的：挑战里金币与升级全部清零，从零重建，目标值（1e12~1e18）到底够不够得着？
 * 方法：以「中期玩家」为起点（永久加成：声望 / 水晶 / 成就 / 里程碑 / 天赋 / 产业线），
 *       进入每个挑战，用理性策略跑 N 秒，测量实际能推进到多少。
 *       挑战目标应当落在「中期玩家可达成区间」内。
 *
 * 运行：node _dev/sim_challenge.js [秒数]
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
const SECONDS = Number(process.argv[2] || 3600);

/* 中期玩家画像：把永久加成开到「玩了两天」的水平 */
const PROFILE = {
  prestige: 120,      // 声望 → ×13
  crystals: 120,      // 水晶 → 1+0.5×√120 ≈ ×6.5
  ach: true,          // 成就全通 → ×1.42
  ms: 8,              // 里程碑解锁到 1e12
  perks: { pk_money: 10, pk_click: 8, pk_off: 8, pk_discount: 8, pk_crit: 8, pk_growth: 8, pk_offcap: 6, pk_quest: 6, pk_keep: 5, pk_start: 5 }
};

console.log('▶ 金币工厂 挑战可达性测量');
console.log(`  中期玩家：声望 ${PROFILE.prestige} / 水晶 ${PROFILE.crystals} / 成就全通 / 里程碑 ${PROFILE.ms} 档 / 天赋全满`);
console.log(`  点击 ${CPS} 次/秒 · 每个挑战跑 ${SECONDS} 秒\n`);

function runChallenge(chId) {
  const w = boot();
  const G = code => w.eval(code);

  // 搭建中期玩家的永久状态
  G(`state = Object.assign(defaultState(), {money:0,total:0,owned:{},ach:{},perks:{},perkPoints:0,`
    + `crystals:${PROFILE.crystals},prestige:${PROFILE.prestige},prestigePath:"balance",challenge:null,challengeMult:1,`
    + `market:null,src:{},srcDays:{},ms:{},quest:{date:"",ids:[],progress:{},claimed:{},bonusClaimed:false,pkStartGiven:0}});`);
  G(`state.perks = ${JSON.stringify(PROFILE.perks)};`);
  G('state.ach = {}; for (const a of ACHIEVEMENTS) state.ach[a.id] = true;');
  // 里程碑加成按档数给
  G(`for (let i = 0; i < ${PROFILE.ms}; i++) { const m = MILESTONES[i]; if (m) state.ms[m.id] = true; }`);
  G('state.challengeMult = 1;');
  const baseMult = G('globalMult()');

  // 进入挑战
  G(`enterChallenge(${JSON.stringify(chId)});`);
  const chTarget = G(`CH_BY_ID[${JSON.stringify(chId)}].target`);
  const chName = G(`CH_BY_ID[${JSON.stringify(chId)}].name`);
  const limits = G(`chLimitNames().join('、')`);

  // 挑战内重建（同样用理性策略）
  for (let sec = 1; sec <= SECONDS; sec++) {
    const clicks = Math.round(CPS * (0.9 + Math.random() * 0.2));
    for (let i = 0; i < clicks; i++) {
      const gain = G('clickPower()');
      G(`state.money += ${gain}; state.total += ${gain};`);
    }
    let guard = 0;
    for (;;) {
      if (++guard > 300) break;
      const pick = w.eval(`(() => {
        const cands = UPGRADES.filter(u => u.type === 'auto' || u.type === 'click' || u.type === 'mult')
          .filter(u => !upgradeBlocked(u))
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
  }

  const prog = G('state.total - state.chBaseTotal');
  const out = { chId, chName, limits, chTarget, baseMult, prog, ratio: prog / chTarget };
  w.close();
  return out;
}

const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
console.log('  挑战 | 限制 | 全局倍率 | 目标 | 实测可达 | 完成度');
const results = [];
for (const id of ids) {
  const r = runChallenge(id);
  results.push(r);
  console.log(`  ${r.chName.padEnd(6)} | ${r.limits.padEnd(12)} | ×${r.baseMult.toFixed(0).padStart(5)}` +
    ` | ${fmt(r.chTarget).padStart(8)} | ${fmt(r.prog).padStart(8)} | ${(r.ratio * 100).toFixed(1)}%`);
}

console.log('\n  判定：目标应取「实测可达」的 40%~70%，让玩家努力但不绝望');
for (const r of results) {
  const suggest = r.prog * 0.5;
  const cur = r.chTarget;
  const verdict = cur > suggest * 2.5 ? '❌ 目标高得离谱' : (cur < suggest * 0.15 ? '⚠️ 目标过低，没挑战性' : '✅ 量级合理');
  console.log(`  ${r.chName.padEnd(6)} 当前 ${fmt(cur).padStart(8)} → 建议 ${fmt(suggest).padStart(8)}  ${verdict}`);
}
