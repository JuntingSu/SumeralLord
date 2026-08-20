// GUI 联调完整流程：建房(map_duo_plain) → 开始 → A 切阶段+长按加点 → A 结束回合 → B 回合 →
// A 回合移动 → A 投降 → 双端结算弹窗（VICTORY 共识确认）
import { chromium } from 'playwright-core';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: EDGE, headless: true });

async function registerAndLogin(page, username) {
  await page.goto(`${BASE}/register`);
  await page.fill('#username', username);
  await page.fill('#password', 'secret1');
  await page.fill('#confirm', 'secret1');
  await page.getByRole('button', { name: /注册/ }).click();
  await page.waitForURL('**/login', { timeout: 8000 }).catch(() => undefined);
  await page.fill('#username', username).catch(() => undefined);
  await page.fill('#password', 'secret1').catch(() => undefined);
  await page.getByRole('button', { name: /登录/ }).click().catch(() => undefined);
  await page.waitForURL('**/lobby', { timeout: 10000 });
}

/** 棋盘 tile → 页面像素坐标（map_duo_plain: 7 行 10 列） */
async function tilePos(page, tile) {
  const box = await page.locator('canvas').first().boundingBox();
  const rows = 7, columns = 10;
  const SQRT3 = Math.sqrt(3);
  const pad = 8;
  const totalWUnits = SQRT3 * (columns + 0.5);
  const totalHUnits = 2 + 1.5 * (rows - 1);
  const size = Math.min((box.width - pad * 2) / totalWUnits, (box.height - pad * 2) / totalHUnits);
  const hexW = SQRT3 * size;
  const totalW = totalWUnits * size;
  const totalH = totalHUnits * size;
  const offX = (box.width - totalW) / 2;
  const offY = (box.height - totalH) / 2;
  const r = Math.floor(tile / columns);
  const col = tile % columns;
  const cx = offX + hexW / 2 + col * hexW + (r % 2 === 1 ? hexW / 2 : 0);
  const cy = offY + totalH - (size + r * 1.5 * size);
  return { x: box.x + cx, y: box.y + cy };
}

async function clickTile(page, tile) {
  const { x, y } = await tilePos(page, tile);
  await page.mouse.click(x, y);
}

const uniq = Date.now().toString(36);
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// B 端全文档注入 WS 消息抓包（addInitScript 在页面脚本执行前生效）
await ctxB.addInitScript(() => {
  const seen = [];
  window.__wsSeen2 = seen;
  const orig = window.WebSocket;
  window.WebSocket = class extends orig {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type) seen.push(`${m.type}:${m.eventId ?? ''}`);
        } catch { /* noop */ }
      });
    }
  };
});
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
pageB.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('[B console]', m.type(), m.text().slice(0, 300));
});
pageB.on('pageerror', (e) => console.log('[B pageerror]', String(e.message).slice(0, 300)));
await registerAndLogin(pageA, `aa_${uniq}`);
await registerAndLogin(pageB, `bb_${uniq}`);

// A 建房（map_duo_plain）
await pageA.goto(`${BASE}/create-room`);
await pageA.waitForLoadState('networkidle');
await pageA.locator('#map-select').fill('平原双雄');
await pageA.waitForTimeout(600);
await pageA.getByText('平原双雄', { exact: false }).last().click({ timeout: 5000 }).catch(() => undefined);
await pageA.waitForTimeout(600);
await pageA.locator('input').nth(0).fill('完整局');
await pageA.getByRole('button').filter({ hasText: '创建' }).first().click();
await pageA.waitForURL('**/room/**', { timeout: 8000 });
const roomUrl = pageA.url();

// B 加入
await pageB.evaluate(async (u) => {
  const roomId = u.split('/room/')[1];
  const token = localStorage.getItem('dl_token');
  await fetch(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
}, roomUrl);
await pageB.goto(roomUrl);
await pageB.waitForTimeout(1500);

async function prep(page) {
  const rc = await page.getByRole('button', { name: /准备/ }).count();
  if (rc > 0) await page.getByRole('button', { name: /准备/ }).first().click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const sc = await page.getByRole('button', { name: '选择' }).count();
  if (sc > 0) await page.getByRole('button', { name: '选择' }).first().click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}
await prep(pageA);
await prep(pageB);
await pageA.getByRole('button', { name: /开始游戏/ }).click({ timeout: 5000 }).catch(() => undefined);
await pageA.waitForURL('**/game/**', { timeout: 8000 });
await pageB.waitForURL('**/game/**', { timeout: 8000 });
await pageA.waitForTimeout(2000);
await pageB.waitForTimeout(2000);
console.log('== 对局开始 ==');

// 1. A 结束行动阶段
await pageA.getByRole('button', { name: /结束行动阶段/ }).click({ timeout: 5000 }).catch(() => undefined);
await pageA.waitForTimeout(1200);
let tA = (await pageA.locator('body').innerText()).replace(/\n+/g, ' | ');
console.log('1. A 进入加点阶段:', tA.includes('长按己方连兵加点'));

// 2. A 长按据点 11 加点（1.2 秒）
const p11 = await tilePos(pageA, 11);
await pageA.mouse.move(p11.x, p11.y);
await pageA.mouse.down();
await pageA.waitForTimeout(1200);
await pageA.mouse.up();
await pageA.waitForTimeout(1500);
tA = (await pageA.locator('body').innerText()).replace(/\n+/g, ' | ');
console.log('2. A 加点后点数:', tA.match(/点数：(\d+)/)?.[1] ?? '?', '（初始 1，应减少）');

// 3. A 结束加点 → B 回合
await pageA.getByRole('button', { name: /结束加点阶段/ }).click({ timeout: 5000 }).catch(() => undefined);
await pageA.waitForTimeout(1800);
const tB1 = (await pageB.locator('body').innerText()).replace(/\n+/g, ' | ');
console.log('3. B 轮到:', tB1.includes('结束行动阶段') ? '是' : '否');
console.log('   B WS 抓包:', JSON.stringify(await pageB.evaluate(() => window.__wsSeen2)));
const bStore = await pageB.evaluate(() => {
  const g = window.__useGame?.getState?.();
  if (!g) return 'no-store';
  return JSON.stringify({ board: !!g.board, appliedEventId: g.appliedEventId, eventQueue: g.eventQueue.length, currentSeat: g.board?.currentSeat, phase: g.board?.phase, mySeat: g.mySeat, conn: g.connection, transport: !!g.transport });
});
console.log('   B store:', bStore);
console.log('   B 文本:', tB1.slice(0, 220));
const tA3 = (await pageA.locator('body').innerText()).replace(/\n+/g, ' | ');
console.log('   A 文本:', tA3.slice(0, 220));

// 4. B 回合：结束行动 + 结束加点
await pageB.getByRole('button', { name: /结束行动阶段/ }).click({ timeout: 5000 }).catch(() => undefined);
await pageB.waitForTimeout(800);
await pageB.getByRole('button', { name: /结束加点阶段/ }).click({ timeout: 5000 }).catch(() => undefined);
await pageB.waitForTimeout(1800);
const tA2 = (await pageA.locator('body').innerText()).replace(/\n+/g, ' | ');
console.log('4. 回到 A 回合:', tA2.includes('点击己方有移动力的兵'));

// 5. A 移动：据点 11 → 空地 10（红方第二回合，据点兵 str≥2 有移动力）
await clickTile(pageA, 11);
await pageA.waitForTimeout(600);
await clickTile(pageA, 10);
await pageA.waitForTimeout(1800);
tA = (await pageA.locator('body').innerText()).replace(/\n+/g, ' | ');
const tB5 = (await pageB.locator('body').innerText()).replace(/\n+/g, ' | ');
console.log('5. A 移动完成；双端回合一致:', tA.match(/第 (\d+) 回合/)?.[0] === tB5.match(/第 (\d+) 回合/)?.[0]);

// 6. A 投降 → 共识 → 结算
pageA.on('dialog', (d) => d.accept());
await pageA.getByRole('button', { name: /投降/ }).click({ timeout: 5000 }).catch(() => undefined);
await pageA.waitForTimeout(800);
await pageA.waitForTimeout(3000);
await pageB.waitForTimeout(3000);
const tA6 = (await pageA.locator('body').innerText()).replace(/\n+/g, ' | ');
const tB6 = (await pageB.locator('body').innerText()).replace(/\n+/g, ' | ');
console.log('6. A 结算弹窗:', tA6.includes('对局结束') || tA6.includes('胜利'));
console.log('   B 结算弹窗:', tB6.includes('对局结束') || tB6.includes('胜利'));
await pageA.screenshot({ path: 'gui-test-screenshots/m4-final-a.png' });
await pageB.screenshot({ path: 'gui-test-screenshots/m4-final-b.png' });
console.log('DONE');
await browser.close();
