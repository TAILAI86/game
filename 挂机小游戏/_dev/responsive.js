/* 响应式体检：多档宽度下检查横向溢出与关键元素越界
 *
 * 技巧：Edge 无头模式视口有 489px 下限，测不了真窄屏。
 * 这里用 iframe 承载游戏 —— iframe 内部的媒体查询按 iframe 自身宽度生效，
 * 于是可以真正验证 320 / 360 / 390 等手机宽度。
 *
 * 用法：node _dev/responsive.js
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
const GAME_URL = 'file:///' + encodeURI(path.join(ROOT, '金币工厂.html').replace(/\\/g, '/'));

/* iframe 宿主页：固定宽度，跨域 file:// 同源，父页面可读取 iframe 内的 DOM */
const HOST = (w, h) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff}
iframe{width:${w}px;height:${h}px;border:0;display:block}
</style></head><body>
<iframe id="f" src="${GAME_URL}"></iframe>
<script>
window.addEventListener('load', function(){
  setTimeout(function(){
    var de = document.documentElement;
    var w = document.getElementById('f').contentWindow;
    var d = w.document;
    var de2 = d.documentElement;
    var m = { cw: de2.clientWidth, sw: de2.scrollWidth };
    function box(sel){ var e=d.querySelector(sel); if(!e) return null; var r=e.getBoundingClientRect(); return {w:Math.round(r.width),h:Math.round(r.height),t:Math.round(r.top)}; }
    m.coin = box('#coinBtn'); m.tabs = box('.tabs'); m.layout = box('.layout');
    m.right = box('.right'); m.left = box('.left'); m.sub = box('.subtitle');
    m.shopRow = box('#shopList .shop-item'); m.shopBtns = box('#shopList .btns');
    m.tabOverflow = (function(){ var t=d.querySelector('.tabs'); return t ? t.scrollWidth > t.clientWidth + 1 : false; })();
    m.tabsVisible = (function(){ var t=d.querySelector('.tabs'); return t ? Math.round(t.getBoundingClientRect().width) : 0; })();
    var wide=[];
    d.querySelectorAll('.panel,.shop-item,.metric,.tabs,.goal-bar,.toolbar,.hint,.block-tag,.stat').forEach(function(el){
      var r = el.getBoundingClientRect();
      if (r.right > de2.clientWidth + 1.5 || r.left < -1.5)
        wide.push((el.tagName+'.'+String(el.className||'')).slice(0,40)+'|l='+Math.round(r.left)+',r='+Math.round(r.right));
    });
    m.wide = wide;
    m.errors = (w.__errs||[]).length;
    document.title = 'PROBE::' + JSON.stringify(m);
  }, 700);
});
<\/script></body></html>`;

const WIDTHS = [320, 360, 390, 414, 480, 600, 768, 1024, 1440];
let fail = 0;

console.log('▶ 响应式体检（iframe 精确视口）');
for (const w of WIDTHS) {
  const file = path.join(__dirname, 'shots', `_resp_${w}.html`);
  fs.writeFileSync(file, HOST(w, 900), 'utf8');
  const url = 'file:///' + encodeURI(file.replace(/\\/g, '/'));
  let dom = '';
  try {
    dom = execFileSync(EDGE, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
      '--virtual-time-budget=4000', '--window-size=1500,1000', '--dump-dom', url
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { console.log(`  ${w}px  测量失败: ${e.message}`); fail++; continue; }
  const m = dom.match(/PROBE::(\{[\s\S]*?\})<\/title>/);
  fs.unlinkSync(file);
  if (!m) { console.log(`  ${w}px  未取到测量值`); fail++; continue; }
  let r; try { r = JSON.parse(m[1].replace(/&quot;/g, '"')); } catch (e) { console.log(`  ${w}px  解析失败`); fail++; continue; }
  const overflow = r.sw > r.cw + 1;
  const wide = r.wide || [];
  const bad = overflow || wide.length > 0;
  if (bad) fail++;
  console.log(
    `  ${String(w).padStart(4)}px | 溢出 ${overflow ? '❌ ' + r.sw + '>' + r.cw : '✅ 无'}` +
    ` | 越界 ${wide.length ? '❌ ' + wide.slice(0, 2).join(' ') : '✅ 0'}` +
    ` | 金币钮 ${r.coin ? r.coin.w + 'px' : '?'}` +
    ` | 商店行 ${r.shopRow ? r.shopRow.w + 'px' : '?'}` +
    ` | 按钮区 ${r.shopBtns ? r.shopBtns.w + 'px' : '?'}` +
    ` | 标签横滑 ${r.tabOverflow ? '是' : '否'}`
  );
}
console.log(fail ? `\n❌ ${fail} 档存在布局问题` : '\n✅ 全部宽度均无横向溢出与元素越界');
process.exit(fail ? 1 : 0);
