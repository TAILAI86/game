/* 生成用于人工检查的截图变体（临时文件，不入库）
 * 每个变体 = 完整游戏 HTML + 一段注入脚本（设置状态 / 切页签）
 * 用法：node _dev/make_shots.js  → 产出 _dev/shots/*.html 与截图命令
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, '金币工厂.html'), 'utf8');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

/* 造一个"玩了两天"的中期存档，页面加载后自动灌进去 */
const SEED = `
<script>
(function(){
  function seed(){
    state.money = 8.8e6; state.total = 5.2e7; state.clicks = 3200; state.crits = 190;
    state.owned = { click1: 42, click5: 18, auto1: 35, auto2: 30, auto3: 22, auto4: 12,
                    auto5: 6, mult1: 4, mult2: 2, crit1: 3, crit2: 1, off1: 2, off2: 1 };
    state.prestige = 21; state.crystals = 21; state.perkPoints = 3;
    state.perks = { pk_money: 4, pk_click: 2, pk_discount: 2 };
    state.market = { prices: { ma1: 118, ma2: 63, ma3: 252, ma4: 905 },
                     holds:  { ma1: 220, ma2: 400, ma3: 90, ma4: 40 },
                     cost:   { ma1: 24000, ma2: 24600, ma3: 22000, ma4: 33000 },
                     hist:   { ma1: [], ma2: [], ma3: [], ma4: [] },
                     trades: 14, wins: 6, profit: 42000, dividends: 8800, held: 750 };
    state.src = { click: 1.2e5, auto: 4.6e6, offline: 8e4, event: 2.1e4, quest: 6e3, checkin: 9e3, market: 1.1e5 };
    state.srcDays = {};
    var today = new Date();
    for (var i = 0; i < 6; i++) {
      var d = new Date(today.getTime() - i * 86400000);
      var k = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      state.srcDays[k] = { click: 1e4*(i+1), auto: 3e5*(i+1), market: 2e4*(i+1), offline: 1e4*(i+1) };
    }
    state.chart = [];
    for (var j = 0; j < 120; j++) state.chart.push({ t: Date.now() - j*1000, v: 2000 + Math.random()*9000 });
    state.checkin = { last: '', streak: 3, day: 4 };
    state.ms = { m1: true, m2: true, m3: true };
    state.ach = {}; checkAch();
    renderMoney(); updateShopState(); renderAchievementsSafe(); renderAll();
  }
  function renderAchievementsSafe(){ try { renderAch(); } catch(e){} }
  function renderAll(){
    try { renderMarket(); } catch(e){}
    try { renderStats(); } catch(e){}
    try { renderChallenges(); } catch(e){}
    try { renderQuests(); } catch(e){}
    try { renderPerks(); } catch(e){}
    try { renderPrestige(); } catch(e){}
    try { renderGoal(); } catch(e){}
  }
  if (document.readyState === 'complete') setTimeout(seed, 30);
  else window.addEventListener('load', function(){ setTimeout(seed, 30); });
})();
<\/script>
`;

function variant(name, tab, extra) {
  let html = HTML.replace('</body>', SEED + '</body>');
  const script = `<script>
  window.addEventListener('load', function(){
    setTimeout(function(){
      try { switchTab(${JSON.stringify(tab)}); } catch(e){}
      ${extra || ''}
    }, 120);
  });
  <\/script>`;
  html = html.replace('</body>', script + '</body>');
  const p = path.join(OUT, name + '.html');
  fs.writeFileSync(p, html, 'utf8');
  console.log(p);
}

variant('shop', 'shop');
variant('market', 'market');
variant('stats', 'stats');
variant('challenge', 'challenge');
variant('challenge-active', 'challenge', "try{ enterChallenge('c2'); }catch(e){}");
variant('perk', 'perk');
variant('dark', 'shop', "try{ state.theme='dark'; applyTheme(); renderSettings(); }catch(e){}");
