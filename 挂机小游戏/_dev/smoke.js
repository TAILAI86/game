/* 金币工厂 —— 无头端到端回归测试
 *
 * 目的：用 jsdom 真实加载单文件游戏，像玩家一样把主流程走一遍，
 * 断言全程无运行时异常、无 console.error，并校验若干玩法不变量。
 *
 * 关键：装一个「虚拟时钟」接管 setTimeout / setInterval / Date.now，
 * 否则 jsdom 的真实定时器在同步测试里永远不会触发，主循环等于没跑。
 *
 * 运行：node _dev/smoke.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', '金币工厂.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

const failures = [];
const notes = [];

function check(name, cond, detail) {
  if (cond) { notes.push('  ✓ ' + name); return true; }
  failures.push('  ✗ ' + name + (detail ? '  →  ' + detail : ''));
  return false;
}

/* ---------- jsdom 环境补丁 ---------- */
function makeCtx2d() {
  const grad = { addColorStop() {} };
  const noop = () => {};
  return new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (p === 'createImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern') return () => grad;
      if (p === 'canvas') return { width: 0, height: 0 };
      return noop;
    },
    set() { return true; }
  });
}

/* ---------- 虚拟时钟 ---------- */
function makeClock(window) {
  const timers = [];
  let now = 1700000000000;       // 固定基准时间，避免依赖真实日期
  let seq = 0;

  window.Date.now = () => now;
  const RealDate = window.Date;
  function VirtualDate(...args) {
    if (!(this instanceof VirtualDate)) return new RealDate(now).toString();
    return args.length ? new RealDate(...args) : new RealDate(now);
  }
  VirtualDate.now = () => now;
  VirtualDate.prototype = RealDate.prototype;
  VirtualDate.parse = RealDate.parse;
  VirtualDate.UTC = RealDate.UTC;
  window.Date = VirtualDate;

  window.setTimeout = function (fn, ms) {
    const id = ++seq;
    timers.push({ id, type: 'timeout', fn, at: now + (ms || 0), every: null });
    return id;
  };
  window.clearTimeout = function (id) {
    const i = timers.findIndex(t => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  window.setInterval = function (fn, ms) {
    const id = ++seq;
    timers.push({ id, type: 'interval', fn, at: now + (ms || 0), every: Math.max(1, ms || 1) });
    return id;
  };
  window.clearInterval = function (id) {
    const i = timers.findIndex(t => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };

  /* 推进虚拟时间 ms 毫秒，触发所有到期回调 */
  function advance(ms) {
    const target = now + ms;
    let guard = 0;
    for (;;) {
      if (++guard > 200000) throw new Error('虚拟时钟推进陷入死循环');
      const due = timers.filter(t => t.at <= target);
      if (!due.length) break;
      due.sort((a, b) => a.at - b.at || a.id - b.id);
      const t = due[0];
      now = Math.max(now, t.at);
      if (t.type === 'timeout') timers.splice(timers.indexOf(t), 1);
      else t.at = now + t.every;
      t.fn();
    }
    now = target;
  }

  return { advance, now: () => now, timers };
}

/* ---------- 页面 ---------- */
function newPage() {
  const consoleErrors = [];
  const vc = new VirtualConsole();
  vc.on('error', (...a) => consoleErrors.push('console.error: ' + a.map(String).join(' ')));
  vc.on('warn', () => {});
  vc.on('jsdomError', (e) => consoleErrors.push('jsdomError: ' + (e && (e.stack || e.message) || e)));

  let clock = null;

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://local.test/game',
    virtualConsole: vc,
    beforeParse(window) {
      class FakeParam {
        constructor() { this.value = 0; }
        setValueAtTime() {} exponentialRampToValueAtTime() {} linearRampToValueAtTime() {}
      }
      class FakeNode {
        constructor() { this.frequency = new FakeParam(); this.gain = new FakeParam(); this.type = 'sine'; }
        connect() { return this; } disconnect() {} start() {} stop() {}
      }
      class FakeCtx {
        constructor() { this.currentTime = 0; this.destination = new FakeNode(); this.state = 'running'; }
        createOscillator() { return new FakeNode(); }
        createGain() { return new FakeNode(); }
        createBiquadFilter() { return new FakeNode(); }
        resume() {} suspend() {}
      }
      window.AudioContext = FakeCtx;
      window.webkitAudioContext = FakeCtx;
      window.HTMLCanvasElement.prototype.getContext = function () { return makeCtx2d(); };
      window.Element.prototype.scrollIntoView = function () {};
      window.URL.createObjectURL = function () { return 'blob:mock'; };
      window.URL.revokeObjectURL = function () {};
      window.confirm = function () { return true; };
      window.alert = function () {};
      clock = makeClock(window);
    }
  });

  return { dom, window: dom.window, consoleErrors, clock };
}

/* ---------- 主流程 ---------- */
function run() {
  const { dom, window, consoleErrors, clock } = newPage();
  const doc = window.document;
  const $ = id => doc.getElementById(id);

  // 顶层 let 声明不会挂到 window 上，只能经全局 eval 取活绑定
  const S = () => window.eval('state');
  const G = code => window.eval(code);
  const advance = ms => clock.advance(ms);

  // —— 1. 开局加载 ——
  check('页面标题正确', doc.title.includes('金币工厂'), doc.title);
  check('金币按钮存在', !!$('coinBtn'));
  check('金币显示为 0 起始', $('money').textContent.replace(/[^\d]/g, '') === '0', $('money').textContent);

  // —— 2. 点击赚钱 ——
  for (let i = 0; i < 30; i++) $('coinBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const moneyText = $('money').textContent;
  check('点击后金币增加', parseFloat(moneyText.replace(/[^\d.]/g, '')) > 0, moneyText);

  // —— 3. 买升级 ——
  const shopBtns = doc.querySelectorAll('#shopList .buy-btn');
  check('商店渲染出升级', shopBtns.length >= 10, '按钮数=' + shopBtns.length);
  G('state.money = 1e9; state.owned.auto1 = 5; state.owned.click1 = 2;');
  window.refresh();
  const ownedBefore = Object.values(S().owned).reduce((a, b) => a + b, 0);
  doc.querySelector('#shopList .buy-btn').click();
  const ownedAfter = Object.values(S().owned).reduce((a, b) => a + b, 0);
  check('购买后升级总数增加', ownedAfter === ownedBefore + 1, ownedBefore + ' -> ' + ownedAfter);

  // —— 4. 推进游戏时钟 40 秒，观察被动收入 ——
  const totalBefore = S().total;
  advance(40 * 1000);
  check('被动收入推进累计财富', S().total > totalBefore, totalBefore + ' -> ' + S().total);

  // —— 5. 关键不变量：员工被动收入必须计入「收入来源拆解」 ——
  const src = S().src || {};
  check('员工收入计入收入来源 src.auto', (src.auto || 0) > 0, 'src=' + JSON.stringify(src));

  // —— 5b. 成就「八线全开」必须可达（需要全部 7 条收入线都有进账） ——
  G('state.src.click = 1; state.src.auto = 1; state.src.offline = 1; state.src.event = 1;'
    + ' state.src.quest = 1; state.src.checkin = 1; state.src.market = 1;');
  G('state.ach = {}; checkAch();');
  check('成就「八线全开」(a34) 可解锁', !!S().ach['a34'],
    '已解锁成就数=' + Object.keys(S().ach).length);

  // —— 6. 遍历所有页签，确保每个 render 函数都不炸 ——
  const tabs = [...doc.querySelectorAll('.tab')].map(t => t.dataset.tab);
  check('页签数量 = 10', tabs.length === 10, 'tabs=' + tabs.join(','));
  for (const t of tabs) {
    try { window.switchTab(t); } catch (e) { consoleErrors.push('switchTab(' + t + '): ' + (e && e.stack || e)); }
  }

  // —— 7. 签到 ——
  try {
    window.switchTab('checkin');
    const cb = $('checkinBtn');
    if (cb) cb.click();
  } catch (e) { consoleErrors.push('checkin: ' + (e && e.stack || e)); }
  check('签到成功并记录连续天数', (S().checkin && S().checkin.streak) >= 1, JSON.stringify(S().checkin));

  // —— 8. 任务 ——
  try {
    window.switchTab('quest');
    G('state.clickQuest = 9999;');
    window.renderQuests();
  } catch (e) { consoleErrors.push('quest: ' + (e && e.stack || e)); }

  // —— 9. 行情：买入 / 卖出 ——
  try {
    window.switchTab('market');
    G('state.money = 1e12;');
    window.renderMarket();
    const buy = doc.querySelector('#marketBox button[data-buy]');
    if (buy) buy.click();
    const held = Object.values(S().market.holds).reduce((a, b) => a + b, 0);
    check('买入后持股数 > 0', held > 0, 'held=' + held);
    const sell = doc.querySelector('#marketBox button[data-sell]');
    if (sell) sell.click();
  } catch (e) { consoleErrors.push('market: ' + (e && e.stack || e)); }

  // —— 10. 天赋 ——
  try {
    G('state.perkPoints = 20;');
    window.switchTab('perk');
    window.renderPerks();
    const pb = doc.querySelector('#perkBox button.pb');
    if (pb) pb.click();
    check('天赋可加点', Object.values(S().perks).reduce((a, b) => a + b, 0) > 0, JSON.stringify(S().perks));
  } catch (e) { consoleErrors.push('perk: ' + (e && e.stack || e)); }

  // —— 11. 挑战：进入 c2（手动时代）再退出 ——
  try {
    window.switchTab('challenge');
    window.enterChallenge('c2');
    check('进入挑战后金币清零', S().money === 0, 'money=' + S().money);
    // 挑战限制下，自动化升级必须被标注为禁用（防止玩家把钱砸进黑洞）
    const autoRow = doc.querySelector('#shopList .shop-item.blocked');
    check('挑战内被禁用的升级有红色标注', !!autoRow);
    const blockTag = doc.querySelector('#shopList .shop-item.blocked .block-tag');
    check('禁用提示文案非空', !!blockTag && blockTag.textContent.includes('禁用'));
    const blockedBtn = doc.querySelector('#shopList .shop-item.blocked .buy-btn');
    check('被禁用升级的购买按钮不可点', blockedBtn && blockedBtn.disabled === true);
    // 买了也不会生效
    const before = S().owned.auto1 || 0;
    G('state.money = 1e9;');
    window.updateShopState();
    const blockedBuy = doc.querySelector('#shopList .shop-item.blocked .buy-btn');
    if (blockedBuy) blockedBuy.click();
    check('被禁用升级无法被购买', (S().owned.auto1 || 0) === before, 'auto1=' + (S().owned.auto1 || 0));
    window.exitChallenge(false);
    check('退出挑战后经济恢复', S().owned && Object.keys(S().owned).length > 0);
  } catch (e) { consoleErrors.push('challenge: ' + (e && e.stack || e)); }

  // —— 11b. 产业线（倍率型升级）必须真的放大全局倍率 ——
  try {
    G('state.owned.mult1 = 0; state.owned.mult2 = 0; state.owned.mult3 = 0; state.owned.mult4 = 0;');
    const m0 = G('globalMult()');
    G('state.owned.mult1 = 4;');
    const m1 = G('globalMult()');
    check('产业线等级提升全局倍率', m1 > m0, m0 + ' -> ' + m1);
    check('产业线倍率与设计值一致', Math.abs((m1 / m0) - 1.48) < 1e-6, 'ratio=' + (m1 / m0));
    G('state.owned.mult1 = 0;');
  } catch (e) { consoleErrors.push('mult: ' + (e && e.stack || e)); }

  // —— 11c. 卖出返还必须与实际投入口径一致（含天赋「通货膨胀」） ——
  try {
    // 卖出返还是「最后一个买的那一级的投入 × 60%」，不是「下一级的价格 × 60%」
    // 用 3 级来测：第 3 个的买入价 = baseCost × growth²，成长率变化才会体现出来
    G('state.owned.auto1 = 3; state.perks.pk_growth = 0;');
    const lastPaid = G('Math.floor(100 * Math.pow(1.25, 2))');   // 第 3 个的买入价
    const refund0 = G('sellRefund(UPGRADES.find(u => u.id === "auto1"))');
    check('返还 = 最后一级投入 × 60%', refund0 === Math.floor(lastPaid * 0.6),
      'refund=' + refund0 + ' expect=' + Math.floor(lastPaid * 0.6));
    // 加上「通货膨胀」天赋后，成长率变小，返还必须同步变低
    G('state.perks.pk_growth = 8;');
    const refund1 = G('sellRefund(UPGRADES.find(u => u.id === "auto1"))');
    const nextCost = G('cost(UPGRADES.find(u => u.id === "auto1"))');
    check('天赋影响成长率时返还同步变化', refund1 < refund0,
      'refund ' + refund0 + '->' + refund1 + ', nextCost=' + nextCost);
    check('返还不超过下一级价格（不可能靠倒卖获利）', refund1 <= nextCost,
      'refund=' + refund1 + ' nextCost=' + nextCost);
    G('state.perks.pk_growth = 0;');
  } catch (e) { consoleErrors.push('sellRefund: ' + (e && e.stack || e)); }

  // —— 11d. 挑战目标必须落在可达区间（否则挑战永远打不通） ——
  try {
    const targets = G('CHALLENGES.map(c => ({ id: c.id, t: c.target }))');
    const maxT = Math.max(...targets.map(x => x.t));
    check('挑战目标均不超过 1e12（中期玩家 1 小时内可达）', maxT <= 1e12, 'max=' + maxT);
    const uniq = new Set(targets.map(x => x.t));
    check('挑战目标有梯度差异', uniq.size >= 4, '不同目标数=' + uniq.size);
  } catch (e) { consoleErrors.push('challengeTargets: ' + (e && e.stack || e)); }

  // —— 11e. 声望曲线：首次重生门槛处应能拿到 3 点以上声望（否则重生是亏本买卖） ——
  try {
    G('state.prestige = 0; state.total = 1e6; state.challenge = null;');
    const avail = G('prestigeAvailable()');
    check('累计 100 万可换到 ≥3 点声望', avail >= 3, 'avail=' + avail);
    check('累计 100 万达到重生门槛', G('canPrestige()') === true);
  } catch (e) { consoleErrors.push('prestigeCurve: ' + (e && e.stack || e)); }

  // —— 12. 重生 ——
  try {
    G('state.total = 1e8; state.challenge = null;');
    const prestigeBefore = S().prestige;
    window.doPrestige();
    check('重生后获得声望', S().prestige > prestigeBefore, prestigeBefore + ' -> ' + S().prestige);
  } catch (e) { consoleErrors.push('prestige: ' + (e && e.stack || e)); }

  // —— 13. 存档 / 读档往返 ——
  try {
    window.save(true);
    const raw = window.localStorage.getItem('coin_factory_slot_1');
    check('存档写入 localStorage', !!raw && raw.length > 10, 'len=' + (raw || '').length);
    const snapshot = JSON.parse(raw);
    check('存档含关键字段', snapshot && typeof snapshot.money === 'number' && typeof snapshot.total === 'number');
  } catch (e) { consoleErrors.push('save: ' + (e && e.stack || e)); }

  // —— 14. 导出 / 导入 ——
  try {
    $('exportBtn').click();
    const exported = $('exportText').value;
    check('导出存档有内容', exported.length > 10, 'len=' + exported.length);
    $('importText').value = exported;
    $('importGo').click();
  } catch (e) { consoleErrors.push('export/import: ' + (e && e.stack || e)); }

  // —— 15. 设置：主题切换 ——
  try {
    window.switchTab('settings');
    window.renderSettings();
    G('state.theme = "dark";');
    window.applyTheme();
    G('state.theme = "light";');
    window.applyTheme();
  } catch (e) { consoleErrors.push('settings: ' + (e && e.stack || e)); }

  // —— 16. 成就可达成性：注入状态后 checkAch 不应崩 ——
  try {
    G('state.total = 1e35;');
    window.checkAch();
  } catch (e) { consoleErrors.push('checkAch: ' + (e && e.stack || e)); }

  // —— 17. 脏存档容错：缺字段 / 非法字段 ——
  try {
    const bad = { money: 'abc', owned: null, src: [], perks: 'x', market: 'bad', quest: 5, total: -1 };
    const fixed = window.ensureFields(bad);
    check('脏存档被修复为合法状态',
      fixed.money === 0 && typeof fixed.owned === 'object' && !Array.isArray(fixed.owned) &&
      fixed.total === 0 && typeof fixed.perks === 'object');
  } catch (e) { consoleErrors.push('ensureFields: ' + (e && e.stack || e)); }

  // —— 18. 长跑：连续推进 10 分钟主循环，不应报错、不应出现 NaN ——
  try {
    G('state.money = 1e12; state.owned.auto3 = 20;');
    advance(10 * 60 * 1000);
    const st = S();
    check('长跑后金额非 NaN', isFinite(st.money) && isFinite(st.total), 'money=' + st.money + ' total=' + st.total);
    check('长跑后收入来源无 NaN', Object.values(st.src || {}).every(v => isFinite(v)), JSON.stringify(st.src));
  } catch (e) { consoleErrors.push('longrun: ' + (e && e.stack || e)); }

  // —— 19. 无控制台报错 ——
  check('全程无 console.error / 未捕获异常', consoleErrors.length === 0,
    consoleErrors.slice(0, 6).join(' || '));

  dom.window.close();
}

console.log('▶ 金币工厂 无头回归测试');
try {
  run();
} catch (e) {
  failures.push('  ✗ 测试运行器抛出异常: ' + (e && e.stack || e));
}

console.log(notes.join('\n'));
if (failures.length) {
  console.log('\n❌ 失败项：');
  console.log(failures.join('\n'));
  console.log('\n结果：' + failures.length + ' 项失败');
  process.exit(1);
} else {
  console.log('\n✅ 全部通过（' + notes.length + ' 项断言）');
  process.exit(0);
}
