// Plays the game with a simulated controller and nothing else: types a callsign on the on-screen
// keyboard, searches for a friend, deploys, names and founds a crew, shops, opens the bag, and
// accepts a trade request. It also checks that the highlight survives screens redrawing themselves.
//
// It needs Playwright with Chromium (not a dependency of the game) and a running game with dev
// commands allowed and no saved world, for example:
//   PORT=8811 WORLD_PORT_BASE=9300 ALLOW_DEV=1 BOTS=0 DATA_FILE=/tmp/dz-check/world.json node server/hub.js
//   node tools/controller-check.mjs [folder for screenshots]
// HUB and WORLD_WS say where the game is, if not on those ports.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HUB = process.env.HUB || 'http://localhost:8811';
const WORLD_WS = process.env.WORLD_WS || 'ws://localhost:9301';
const out = process.argv[2] || null;
const shot = (page, name) => (out ? page.screenshot({ path: `${out}/${name}.png` }) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
// Graphics on Fast: this checks controller navigation, and software rendering on a big view makes frames slow.
await p.addInitScript(() => { try { localStorage.setItem('dz_gfx', 'fast'); } catch { /* no storage */ } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.addInitScript(() => {
  const pad = { id: 'Fake Pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), timestamp: 0 };
  window.__pad = pad;
  navigator.getGamepads = () => [pad];
});
const press = async (b, hold = 90) => { await p.evaluate(([i]) => { window.__pad.buttons[i] = { pressed: true, value: 1 }; }, [b]); await sleep(hold); await p.evaluate(([i]) => { window.__pad.buttons[i] = { pressed: false, value: 0 }; }, [b]); await sleep(110); };
const focused = () => p.evaluate(() => { const e = document.activeElement; return e && e !== document.body ? `${e.tagName}#${e.id}.${e.classList.contains('padfocus') ? 'HL' : 'no-hl'}:${(e.textContent || e.placeholder || '').trim().slice(0, 28)}` : 'NOTHING'; });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };
const typeKeys = async (text) => { for (const ch of text) { await p.evaluate((c) => { const k = [...document.querySelectorAll('#oskKeys .oskkey')].find((b) => b.textContent === c); k.focus(); }, ch); await press(BTN.A); } };

await p.goto(`${HUB}/?debug`);
await p.waitForSelector('#lbName:not([hidden])');
await sleep(800);
await press(BTN.DOWN);
check('the first press only wakes the controller: highlight on the first button', /BUTTON#register\.HL/.test(await focused()), await focused());
for (let k = 0; k < 4 && !(await focused()).startsWith('INPUT#name'); k++) await press(BTN.UP);
await sleep(300);
check('callsign box highlighted, phone keyboard held down', await p.evaluate(() => document.activeElement.id === 'name' && document.activeElement.getAttribute('inputmode') === 'none'));
await press(BTN.A);
check('keyboard opens on the letter row', /BUTTON#\.HL:Q/.test(await focused()), await focused());
const name = 'PAD' + String(Date.now()).slice(-5);
await typeKeys(name);
await press(BTN.MENU);
// "Create callsign" sits beside the callsign box (the device-link boxes are below it).
for (let k = 0; k < 4 && !(await focused()).includes('register'); k++) await press(k < 2 ? BTN.RIGHT : BTN.DOWN);
await press(BTN.A);
await p.waitForSelector('#lbMain:not([hidden])', { timeout: 15000 });
await sleep(700);
check('lobby: something is highlighted without pressing anything', /\.HL:/.test(await focused()), await focused());
for (let k = 0; k < 6 && !/Play/.test(await focused()); k++) await press(BTN.DOWN);
const f0 = await focused();
await sleep(3800);   // the lobby redraws itself every 3 seconds
check('lobby: highlight still on Play after the list refreshed', (await focused()) === f0, `${f0} -> ${await focused()}`);
// Friend search with the on-screen keyboard: the text survives the 3-second refresh.
for (let k = 0; k < 8 && !/Find agents/.test(await focused()); k++) await press(BTN.DOWN);
check('lobby: friend search box reachable', /Find agents/.test(await focused()), await focused());
await press(BTN.A);
await typeKeys('ZZ');
await sleep(3500);
await press(BTN.MENU);
check('lobby: typed search text lands in the box', await p.evaluate(() => document.activeElement.value === 'Zz' && document.activeElement.isConnected), await p.evaluate(() => document.activeElement.value));
await press(BTN.RIGHT);
const fs = await focused();
await sleep(3600);
check('lobby: search text kept after a refresh', await p.evaluate(() => [...document.querySelectorAll('#lbFriends input')][0].value === 'Zz') && (await focused()) === fs, `${fs} -> ${await focused()}`);
for (let k = 0; k < 10 && !/Play/.test(await focused()); k++) await press(BTN.UP);
await press(BTN.A);
await p.waitForSelector('#mapscreen:not([hidden])', { timeout: 120000 });
await sleep(1200);
check('deploy screen: first choice highlighted on arrival', /\.HL:/.test(await focused()), await focused());
for (let k = 0; k < 3 && !/Bristol/.test(await focused()); k++) await press(BTN.DOWN);
await press(BTN.A);
await sleep(3000);
check('in the world', await p.evaluate(() => !!window.__dz.state.me && document.getElementById('mapscreen').hidden));

// Crew panel: name a crew with the on-screen keyboard and found it.
await press(BTN.MENU, 700);
await sleep(400);
check('crew panel open with a highlight', await p.evaluate(() => !document.getElementById('squadpanel').hidden) && /\.HL:/.test(await focused()), await focused());
for (let k = 0; k < 40 && !(await focused()).startsWith('INPUT#crewNameIn'); k++) await press(BTN.DOWN, 60);
if (!(await focused()).startsWith('INPUT#crewNameIn')) for (let k = 0; k < 40 && !(await focused()).startsWith('INPUT#crewNameIn'); k++) await press(BTN.UP, 60);
check('crew name box reachable', (await focused()).startsWith('INPUT#crewNameIn'), await focused());
await press(BTN.A);
const crew = 'SW' + String(Date.now()).slice(-4);
const crewShown = 'Sw' + crew.slice(2);
await typeKeys(crew);
await sleep(1400);
await press(BTN.MENU);
check('crew name typed', await p.evaluate(() => document.getElementById('crewNameIn')?.value) === crewShown);
await press(BTN.RIGHT);
check('Found crew highlighted', /Found crew/.test(await focused()), await focused());
await sleep(1500);   // the crew panel redraws itself every second
check('name and highlight kept through the panel refresh', await p.evaluate(() => document.getElementById('crewNameIn')?.value) === crewShown && /HL:Found crew/.test(await focused()), `${await p.evaluate(() => document.getElementById('crewNameIn')?.value)} | ${await focused()}`);
await press(BTN.A);
await sleep(900);
check('crew founded', new RegExp(crewShown).test(await p.evaluate(() => document.getElementById('sqTitle').textContent)), await p.evaluate(() => document.getElementById('sqTitle').textContent));
await shot(p, 'controller-crew');
check('highlight still in the panel after founding', /\.HL:/.test(await focused()), await focused());
await press(BTN.B);
await sleep(300);
check('B closes the crew panel', await p.evaluate(() => document.getElementById('squadpanel').hidden));

// A shop: walk the list, let the server redraw it, buy something.
await p.evaluate(() => { const c = window.__dz.state.map.contacts[0]; window.__dz.send({ t: 'dev', x: c.x + 1.5, z: c.z }); });
await sleep(1500);
for (let k = 0; k < 6 && await p.evaluate(() => document.getElementById('contactpanel').hidden); k++) { await press(BTN.A); await sleep(500); }
check('shop opens with A and has a highlight', await p.evaluate(() => !document.getElementById('contactpanel').hidden) && /\.HL:/.test(await focused()), await focused());
for (let k = 0; k < 5; k++) await press(BTN.DOWN, 60);
const where = () => p.evaluate(() => { const e = document.activeElement; const panel = document.getElementById('contactpanel'); const list = [...panel.querySelectorAll('button:not([disabled]):not(.nopad), input, select')].filter((x) => x.offsetParent !== null); return `${list.indexOf(e)}:${e.textContent.trim().slice(0, 20)}:${e.classList.contains('padfocus')}`; });
const w0 = await where();
// Anything that changes the player makes the server send fresh state, which redraws the shop.
await p.evaluate(() => { const s = window.__dz.state; window.__dz.send({ t: 'dev', x: s.x, z: s.z }); });
await sleep(900);
check('shop: highlight stays put when the list is redrawn', (await where()) === w0, `${w0} -> ${await where()}`);
await shot(p, 'controller-shop');
// Find a Buy button and use it.
const cash0 = await p.evaluate(() => window.__dz.state.me.cash);
let onBuy = false;
for (let k = 0; k < 60 && !onBuy; k++) { onBuy = await p.evaluate(() => /^(Buy|\$)/.test(document.activeElement.textContent.trim()) || /Buy/.test(document.activeElement.textContent)); if (!onBuy) await press(BTN.DOWN, 60); }
const wb = await where();
await press(BTN.A);
await sleep(900);
const cash1 = await p.evaluate(() => window.__dz.state.me.cash);
console.log('   buy button:', wb, '| cash', cash0, '->', cash1, '| now on', await where());
check('shop: highlight still on a control after pressing it', /:true$/.test(await where()), await where());
await press(BTN.B);
await sleep(300);
check('B closes the shop', await p.evaluate(() => document.getElementById('contactpanel').hidden));
await press(BTN.VIEW);
await sleep(500);
check('bag opens with a highlight', await p.evaluate(() => !document.getElementById('inventory').hidden) && /\.HL:/.test(await focused()), await focused());
await press(BTN.B);
await sleep(300);
check('B closes the bag', await p.evaluate(() => document.getElementById('inventory').hidden));

// A second player walks up and asks to trade: the bar at the top is answered by holding the View button.
const WS = require('ws');
const ws = new WS(WORLD_WS);
const other = [];
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'toast' || m.t === 'ptrade') other.push(m.t === 'toast' ? m.text : `ptrade:${m.state}`); });
await new Promise((r) => ws.on('open', r));
const say = (m) => ws.send(JSON.stringify(m));
const me = await p.evaluate(() => ({ id: window.__dz.state.id, x: window.__dz.state.x, z: window.__dz.state.z }));
say({ t: 'join', name: 'Trader' + String(Date.now()).slice(-4), token: 'e'.repeat(32) });
await sleep(700);
say({ t: 'deploy', kind: 'contact', id: 0 });
await sleep(700);
say({ t: 'dev', x: me.x + 1.5, z: me.z + 1 });
await sleep(500);
const ask = async () => { say({ t: 'ptrade', action: 'request', id: me.id }); await p.waitForSelector('#invitebar:not([hidden])', { timeout: 5000 }).catch(() => {}); };
await ask();
check('trade request shows the bar with a controller hint', await p.evaluate(() => { const b = document.getElementById('invitebar'); return !b.hidden && /wants to trade/.test(b.textContent) && /Hold ⧉ to trade/.test(b.textContent) && getComputedStyle(b.querySelector('small')).display !== 'none'; }), await p.evaluate(() => document.getElementById('invitebar').textContent) + ' | other: ' + other.join(' ; '));
await shot(p, 'controller-ask');
// A tap still opens the bag (when you let go), and does not answer.
await press(BTN.VIEW, 120);
await sleep(300);
check('with the bar up, a tap of View still opens the bag and answers nothing', await p.evaluate(() => !document.getElementById('inventory').hidden && !document.getElementById('invitebar').hidden && document.getElementById('tradepanel').hidden));
await press(BTN.B);
await sleep(300);
await press(BTN.VIEW, 800);
// Opening the trade screen takes a round trip to the server: wait for it rather than a fixed time.
await p.waitForFunction(() => !document.getElementById('tradepanel').hidden, null, { timeout: 5000 }).catch(() => {});
check('holding View says yes: the trade screen opens', await p.evaluate(() => !document.getElementById('tradepanel').hidden && document.getElementById('invitebar').hidden && document.getElementById('inventory').hidden), other.join(' ; '));
check('trade screen has a highlight', /\.HL:/.test(await focused()), await focused());
await shot(p, 'controller-trade');
await press(BTN.B);
await sleep(600);
check('B cancels the trade', await p.evaluate(() => document.getElementById('tradepanel').hidden));
ws.close();
check('no errors', errs.length === 0, errs.slice(0, 4).join(' | '));
console.log(`${results.filter(Boolean).length} of ${results.length} passed`);
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
