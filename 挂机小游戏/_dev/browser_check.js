/* 真实浏览器控制台检查：用 Edge 无头模式加载游戏，捕获 console.error / window.onerror /
 * 未处理 Promise 异常，并在真实环境里跑一遍主流程。
 *
 * 用法：node _dev/browser_check.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];
const EDGE = EDGE_CANDIDATES.find(p => fs.existsSync(p));
if (!EDGE) { console.error('找不到浏览器'); process.exit(2); }

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, '金币工厂.html'), 'utf8');

/* 注入错误捕获 + 主流程驱动 */
const HARNESS = `
<script>
(function(){
  window.__errs = [];
  // 真实浏览器里 confirm()/alert() 会弹模态框并阻塞整个渲染进程，无头模式下必须 mock 掉
  window.confirm = function(){ return true; };
  window.alert = function(){};
  var oe = console.error;
  console.error = function(){ window.__errs.push('console.error: ' + Array.prototype.map.call(arguments, String).join(' ')); oe.apply(console, arguments); };
  window.addEventListener('error', function(e){ window.__errs.push('window.onerror: ' + (e.message||'') + ' @' + (e.filename||'') + ':' + (e.lineno||'')); });
  window.addEventListener('unhandledrejection', function(e){ window.__errs.push('unhandledrejection: ' + e.reason); });

  function step(fn, label){
    try { fn(); } catch(e){ window.__errs.push('STEP[' + label + ']: ' + (e && e.stack || e)); }
  }
  window.addEventListener('load', function(){
    setTimeout(function(){
      // —— 主流程 ——
      step(function(){ for(var i=0;i<40;i++) document.getElementById('coinBtn').click(); }, 'click');
      step(function(){ state.money = 1e12; refresh(); }, 'refresh');
      step(function(){ UPGRADES.forEach(function(u){ buy(u); }); }, 'buyAll');
      step(function(){ buyMax(UPGRADES.find(function(u){return u.id==='auto1';})); }, 'buyMax');
      step(function(){ sellOne(UPGRADES.find(function(u){return u.id==='auto1';})); }, 'sell');
      step(function(){ document.querySelectorAll('.tab').forEach(function(t){ switchTab(t.dataset.tab); }); }, 'tabs');
      step(function(){ document.getElementById('checkinBtn').click(); }, 'checkin');
      step(function(){ state.clickQuest = 9999; renderQuests(); }, 'quest');
      step(function(){ state.money = 1e12; renderMarket(); document.querySelector('#marketBox button[data-buy]') && document.querySelector('#marketBox button[data-buy]').click(); }, 'market');
      step(function(){ state.perkPoints = 30; renderPerks(); document.querySelector('#perkBox button.pb') && document.querySelector('#perkBox button.pb').click(); }, 'perk');
      step(function(){ enterChallenge('c2'); }, 'enterCh');
      step(function(){ exitChallenge(false); }, 'exitCh');
      step(function(){ state.total = 1e9; state.challenge = null; doPrestige(); }, 'prestige');
      step(function(){ save(true); document.getElementById('exportBtn').click(); document.getElementById('importGo').click(); }, 'saveImport');
      step(function(){ state.theme='dark'; applyTheme(); state.theme='light'; applyTheme(); renderSettings(); }, 'theme');
      step(function(){ state.total = 1e35; checkAch(); }, 'ach');
      step(function(){ renderStats(); renderPrestige(); renderIncomeSources && renderIncomeSources(); }, 'renderAll');
      // —— 让主循环自己跑 25 秒 ——
      setTimeout(function(){
        step(function(){ renderStats(); renderMarket(); renderChallenges(); }, 'lateRender');
        var el = document.createElement('pre');
        el.id = 'errOut';
        el.textContent = 'ERRS::' + JSON.stringify(window.__errs);
        document.body.appendChild(el);
      }, 8000);
    }, 600);
  });
})();
</script>`;

const file = path.join(__dirname, 'shots', '_browser_check.html');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, HTML.replace('</body>', HARNESS + '</body>'), 'utf8');

const url = 'file:///' + encodeURI(file.replace(/\\/g, '/'));
console.log('▶ 浏览器控制台检查（Edge 无头，主循环实跑 8 秒）');

let dom = '';
try {
  dom = execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=12000',
    '--window-size=1280,900', '--dump-dom', url
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.error('  浏览器执行失败: ' + e.message);
  process.exit(2);
}
fs.unlinkSync(file);

const m = dom.match(/ERRS::(\[[\s\S]*?\])<\/pre>/);
if (!m) {
  console.error('  ❌ 未取到错误捕获结果（页面可能在加载阶段就崩了）');
  process.exit(1);
}
const errs = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
if (!errs.length) {
  console.log('  ✅ 真实浏览器中全程无 console.error / window.onerror / 未处理异常');
  process.exit(0);
}
console.log('  ❌ 捕获到 ' + errs.length + ' 条错误：');
errs.slice(0, 15).forEach(e => console.log('     · ' + e));
process.exit(1);
