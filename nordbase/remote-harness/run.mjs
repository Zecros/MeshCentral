#!/usr/bin/env node
// Nordbase Remote step 1: local harness for the share page (views/sharing.handlebars).
// Starts a fake share server + relay + agent, opens the real page in headless Chrome and checks
// scaling, quality switching, screens, Mac -> Windows keys (exact bytes), quick keys, reconnect,
// the connection indicator, Auto, JPEG only (step 3), broken tiles, share expiry and that the clipboard never moves by itself.
//
//   node nordbase/remote-harness/run.mjs [--out <dir>] [--quick]
//
// No network access, no installs. Needs Node 22+ and Google Chrome (or CHROME_PATH).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarnessServer } from './harness-server.mjs';
import { launchChrome, CDP, sleep } from './cdp.mjs';
import { runStep2 } from './step2.mjs';
import { runStep3 } from './step3.mjs';

const args = process.argv.slice(2);
const outDir = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(os.tmpdir(), 'nordbase-remote-harness'));
const quick = args.includes('--quick');
const step2Only = args.includes('--step2'); // only the step 2 checks (phone, keyboard, WebRTC) and step 3
const step3Only = args.includes('--step3'); // only the step 3 checks (scaling, Ctrl+Alt+Del across path switches)
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const trace = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail }); console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); }

const ALT = { key: 'Alt', code: 'AltLeft', vk: 18 };
const META = { key: 'Meta', code: 'MetaLeft', vk: 91 };
const SHIFT = { key: 'Shift', code: 'ShiftLeft', vk: 16 };
const CTRL = { key: 'Control', code: 'ControlLeft', vk: 17 };
const M = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

function fmtKeys(log) {
    return log.map((k) => {
        if (k.t === 'cad') return 'CAD';
        if (k.t === 'uni') return 'U+' + k.ch + ':' + (k.flag === 0 ? 'd' : 'u');
        return 'K' + k.kc + ':' + ({ 0: 'd', 1: 'u', 4: 'xd', 3: 'xu' }[k.flag] || k.flag);
    });
}

let pageValues = {};
const { server, agent, port } = await startHarnessServer({ pageValues: () => pageValues });
const base = 'http://127.0.0.1:' + port;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nordbase-harness-chrome-'));
const chrome = await launchChrome(profile);
const cdp = await CDP.connect(chrome.wsUrl);
console.log('harness on ' + base + ', browser ' + path.basename(chrome.bin) + ', output ' + outDir);

async function cleanup() {
    try { cdp.close(); } catch (ex) { }
    try { chrome.proc.kill('SIGTERM'); } catch (ex) { }
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (ex) { }
    server.close();
}

try {
    // Encoder tab: draws the synthetic desktop and makes JPEG/WebP tiles for the fake agent.
    const enc = await cdp.newPage(base + '/__encoder.html');
    await enc.waitFor('window.encoderReady === true');
    agent.encoder = (spec) => enc.eval('encodeTiles(' + JSON.stringify(spec) + ')');

    // Step 2: the fake agent's WebRTC end lives in its own tab.
    const peerPage = await cdp.newPage(base + '/__peer.html');
    await peerPage.waitFor('window.peerReady === true');
    await peerPage.binding('harnessPeer', (payload) => agent.onPeerEvent(JSON.parse(payload)));
    agent.peer = {
        answer: (sdp, mode) => peerPage.eval('peerAnswer(' + JSON.stringify(sdp) + ', ' + JSON.stringify(mode) + ')'),
        send: (buf) => { peerPage.eval('peerSend(' + JSON.stringify(buf.toString('base64')) + ')').catch(() => { }); },
        close: () => { peerPage.eval('peerClose()').catch(() => { }); }
    };

    const page = await cdp.newPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.bringToFront');
    // Count every RTCPeerConnection the share page makes, so the checks can see that each one is closed.
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "(function(){ var O = window.RTCPeerConnection; if (!O) return; window.__pcs = []; var W = function (c) { var pc = new O(c); window.__pcs.push(pc); return pc; }; W.prototype = O.prototype; window.RTCPeerConnection = W; })();" });
    const lastComp = () => agent.log.compression[agent.log.compression.length - 1];
    const waitComp = async (pred, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { const c = lastComp(); if (c && pred(c)) return c; await sleep(100); } throw new Error('timeout: ' + label + ' last=' + JSON.stringify(lastComp())); };
    const connected = (ms = 15000) => page.waitFor("(desktop != null) && (desktop.State == 3) && rmmHadPicture && !document.getElementById('rmmReconnect').classList.contains('rmm-show')", ms, 'connected with picture');

    async function load(values) {
        pageValues = values || {};
        await page.goto(base + '/sharing');
        await page.eval('window.__harnessMarker = 1; true');
        await page.eval("document.getElementById('Desk') && document.getElementById('Desk').focus(); true");
    }

    if (!step2Only && !step3Only) {
    // ---------------------------------------------------------------- first load, Auto, scaling
    await page.eval('localStorage.clear(); true').catch(() => { });
    await load();
    await page.eval('localStorage.clear(); true');
    await load();
    await connected();
    await sleep(800);
    let c = lastComp();
    check('Bild: JPEG begärs (steg 3: agenten kan inte göra WebP, så sidan ber inte om det)', c && c.type === 1 && agent.log.compression.every((x) => x.type === 1), c);
    check('Auto startar på JPEG-kvalitet 60 och 20 bilder/s', c && c.q === 60 && c.fr === 50, c);
    // Window 1280x800, left bar 54 px, bars 2 x 52 px: area 1226 x 696. 4K screen: 1226/3840 = 0.32 -> 384 (37.5 %).
    check('Skalning till fönstret: 4K-skärm i 1280-fönster ger 37,5 %', c && c.scaling === 384, c);
    const canvasW = await page.eval("document.getElementById('Desk').width");
    check('Datorn skickar 1440 px bred bild i stället för 3840', canvasW === 1440, canvasW);
    check('Anslutningsprick visar Bra', (await page.waitFor("rmmNet.state == 'good' && document.getElementById('rmmNetText').textContent", 8000)) === 'Bra');
    await page.screenshot(path.join(outDir, 'skrivbord-1280.png'));

    // ---------------------------------------------------------------- quality control
    await page.click('#rmmQuality [data-q="sharp"]');
    c = await waitComp((x) => x.q === 80, 3000, 'skarp');
    check('Skarp: JPEG-kvalitet 80, 20 bilder/s, full skalning för fönstret', c.q === 80 && c.fr === 50 && c.scaling === 384, c);
    await page.click('#rmmQuality [data-q="fast"]');
    c = await waitComp((x) => x.q === 40, 3000, 'snabb');
    check('Snabb: kvalitet 40, 10 bilder/s, mindre bild (25 %)', c.fr === 100 && c.scaling === 256, c);
    check('Valet sparas i webbläsaren', (await page.eval("JSON.parse(localStorage.getItem('nordbaseRemote.v1')).quality")) === 'fast');
    await page.click('#rmmQuality [data-q="auto"]');
    c = await waitComp((x) => x.q === 60 && x.scaling === 384, 3000, 'auto');
    check('Tillbaka till Auto', true, c);

    // ---------------------------------------------------------------- fit / 100 %
    await page.click('#rmmFit [data-fit="0"]');
    c = await waitComp((x) => x.scaling === 1024, 3000, '100 %');
    await page.waitFor("document.getElementById('Desk').width == 3840", 5000);
    const cssW = await page.eval("parseInt(document.getElementById('Desk').style.width)");
    check('100 %: full upplösning och en pixel per pixel', cssW === 3840, { scaling: c.scaling, cssW });
    await page.click('#rmmFit [data-fit="1"]');
    c = await waitComp((x) => x.scaling === 384, 3000, 'anpassa');
    check('Anpassa: tillbaka till fönstrets storlek', true, c);

    // ---------------------------------------------------------------- resize
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    c = await waitComp((x) => x.scaling === 512, 4000, 'resize');
    check('Större fönster (1920x1080) ger ny skalning 50 %', true, c);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
    c = await waitComp((x) => x.scaling === 768, 4000, 'retina');
    check('Retina (2x) i 1280-fönster ger 75 % så texten blir skarp', true, c);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await waitComp((x) => x.scaling === 384, 4000, 'back');

    // ---------------------------------------------------------------- step 5: the picture in its frame, clicks exact
    await page.eval("(function(){ window.__mouse = []; var m = desktop.m; if (m.__rr5) return true; m.__rr5 = true; var s = m.send; m.send = function (x) { if ((typeof x == 'string') && (x.length >= 10) && (x.charCodeAt(1) == 2)) { window.__mouse.push({ x: x.charCodeAt(6) * 256 + x.charCodeAt(7), y: x.charCodeAt(8) * 256 + x.charCodeAt(9) }); } return s.apply(m, arguments); }; return true; })()");
    const frame = () => page.eval("(function(){ var c = document.getElementById('Desk'), r = c.getBoundingClientRect(), a = document.getElementById('deskarea3x').getBoundingClientRect(); return { l: r.left - a.left, r: a.right - r.right, t: r.top - a.top, b: a.bottom - r.bottom, w: r.width, h: r.height, iw: c.width, ih: c.height, crisp: c.classList.contains('rmm-crisp'), focus: getComputedStyle(document.getElementById('DeskFocus')).display, theme: document.documentElement.getAttribute('data-rmm-theme') }; })()");
    const mouseErr = async (scroll) => {
        if (scroll) await page.eval("(function(){ var p = document.getElementById('DeskParent'); p.scrollLeft = " + scroll[0] + "; p.scrollTop = " + scroll[1] + "; return true; })()");
        const g = await page.eval("(function(){ var c = document.getElementById('Desk'), r = c.getBoundingClientRect(), a = document.getElementById('deskarea3x').getBoundingClientRect(); var L = Math.max(r.left, a.left), T = Math.max(r.top, a.top), R = Math.min(r.right, a.right), B = Math.min(r.bottom, a.bottom); return { r: { l: r.left, t: r.top, w: r.width, h: r.height }, iw: c.width, ih: c.height, pts: [[L + 3, T + 3], [(L + R) / 2, (T + B) / 2], [R - 4, B - 4]] }; })()");
        let worst = 0; const seen = [];
        for (const [x, y] of g.pts) {
            await page.eval('window.__mouse.length = 0; true');
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
            await sleep(60);
            const m = await page.eval('window.__mouse[window.__mouse.length - 1] || null');
            const ex = [(x - g.r.l) * g.iw / g.r.w, (y - g.r.t) * g.ih / g.r.h];
            const e = m ? Math.max(Math.abs(m.x - ex[0]), Math.abs(m.y - ex[1])) : 99;
            worst = Math.max(worst, e); seen.push({ sent: m && [m.x, m.y], ex: ex.map((v) => Math.round(v)) });
        }
        return { worst: +worst.toFixed(2), scale: +(g.iw / g.r.w).toFixed(3), seen };
    };
    await page.waitFor("document.getElementById('Desk').width == 1440", 5000); // the agent's new size has arrived
    await sleep(400);
    let fr = await frame();
    check('Steg 5, Anpassa: bilden i mitten (lika kant vänster/höger och upp/ner), hela pixlar, jämn kant runt om', Math.abs(fr.l - fr.r) <= 1 && Math.abs(fr.t - fr.b) <= 1 && Math.min(fr.l, fr.t) >= 7.5 && Math.min(fr.l, fr.t) <= 8.5 && Number.isInteger(fr.w) && Number.isInteger(fr.h), fr);
    check('Steg 5: ingen röd fokusruta i hörnet, mörkt tema som standard', fr.focus === 'none' && fr.theme === 'dark', { focus: fr.focus, theme: fr.theme });
    let me = await mouseErr();
    check('Steg 5, Anpassa: musen hamnar exakt (högst en fjärrpixel fel)', me.worst <= Math.max(1, me.scale), me);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1.5, mobile: false });
    await page.click('#rmmFit [data-fit="0"]');
    await waitComp((x) => x.scaling === 1024, 4000, '100 % at 1.5');
    await page.waitFor("document.getElementById('Desk').width == 3840", 5000);
    await sleep(300);
    fr = await frame();
    check('Steg 5, 100 % på 150 %-skärm: en fjärrpixel = en skärmpixel (2560 px CSS för 3840)', Math.abs(fr.w - 2560) < 1 && !fr.crisp, fr);
    me = await mouseErr([300, 200]);
    check('Steg 5, 100 % med rullning på 150 %-skärm: musen hamnar exakt', me.worst <= 1.5, me);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
    await page.waitFor("document.getElementById('Desk').classList.contains('rmm-crisp')", 6000).catch(() => null); // a new pixel ratio is seen within about 2 s
    fr = await frame();
    me = await mouseErr([500, 300]);
    check('Steg 5, 100 % på Retina: två skärmpixlar per fjärrpixel utan suddning, musen exakt', fr.w === 3840 && fr.crisp && me.worst <= 1, { fr, me });
    await page.click('#rmmFit [data-fit="1"]');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await waitComp((x) => x.scaling === 384, 4000, 'back after step 5');

    // ---------------------------------------------------------------- screens
    const labels = await page.eval("Array.from(document.querySelectorAll('#rmmDisplays .rmm-btn')).map(b => b.textContent)");
    check('En knapp per skärm och Alla skärmar', JSON.stringify(labels) === JSON.stringify(['Skärm 1', 'Skärm 2', 'Alla skärmar']), labels);
    await page.click('#rmmDisplays [data-display="2"]');
    c = await waitComp((x) => x.scaling === 768, 5000, 'skärm 2');
    check('Skärm 2 (1920x1080): agenten byter skärm och skalningen räknas om (75 %)', agent.log.setDisplay.includes(2), { setDisplay: agent.log.setDisplay, c });
    await page.click('#rmmDisplays [data-display="65535"]');
    c = await waitComp((x) => x.scaling === 256, 5000, 'alla');
    check('Alla skärmar (5760 bred) skalas ner till 25 %', true, c);
    await page.click('#rmmDisplays [data-display="2"]');
    await waitComp((x) => x.scaling === 768, 5000, 'skärm 2 igen');

    // ---------------------------------------------------------------- keys
    async function seq(steps) {
        agent.clearKeys();
        for (const s of steps) { await page.key(s[0], s[1]); }
        await sleep(150);
        return fmtKeys(agent.log.keys);
    }
    const down = (k, mods = 0, text) => [text ? 'keyDown' : 'rawKeyDown', Object.assign({}, k, { mods, text })];
    const up = (k, mods = 0) => ['keyUp', Object.assign({}, k, { mods })];
    const optChar = (ch, code, vk, shift) => {
        const steps = [];
        if (shift) steps.push(down(SHIFT, M.shift));
        steps.push(down(ALT, M.alt | (shift ? M.shift : 0)));
        steps.push(down({ key: ch, code, vk }, M.alt | (shift ? M.shift : 0), ch));
        steps.push(up({ key: ch, code, vk }, M.alt | (shift ? M.shift : 0)));
        steps.push(up(ALT, shift ? M.shift : 0));
        if (shift) steps.push(up(SHIFT, 0));
        return steps;
    };
    const cmdKey = (ch, code, vk) => [down(META, M.meta), down({ key: ch, code, vk }, M.meta, ch.length === 1 ? ch : undefined), up(META, 0)]; // macOS: no keyup for the key while Cmd is held
    const plain = (ch, code, vk) => [down({ key: ch, code, vk }, 0, ch), up({ key: ch, code, vk }, 0)];

    check('Mac-läget är på av sig självt (Mac-webbläsare, Windows-dator)', await page.eval('rmmMacKeysOn()') === true);
    const table = [
        ['Option+2 ger @', optChar('@', 'Digit2', 50), ['U+@:d', 'U+@:u']],
        ['Option+3 ger £', optChar('£', 'Digit3', 51), ['U+£:d', 'U+£:u']],
        ['Option+4 ger $', optChar('$', 'Digit4', 52), ['U+$:d', 'U+$:u']],
        ['Option+E ger € (om Mac-layouten ger € med Option)', optChar('€', 'KeyE', 69), ['U+€:d', 'U+€:u']],
        ['Shift+4 ger € (Mac svensk, utan Option)', [down(SHIFT, M.shift), down({ key: '€', code: 'Digit4', vk: 52 }, M.shift, '€'), up({ key: '€', code: 'Digit4', vk: 52 }, M.shift), up(SHIFT, 0)], ['K16:d', 'U+€:d', 'U+€:u', 'K16:u']],
        ['Option+8 ger [', optChar('[', 'Digit8', 56), ['U+[:d', 'U+[:u']],
        ['Option+9 ger ]', optChar(']', 'Digit9', 57), ['U+]:d', 'U+]:u']],
        ['Shift+Option+8 ger {', optChar('{', 'Digit8', 56, true), ['K16:d', 'U+{:d', 'U+{:u', 'K16:u']],
        ['Shift+Option+9 ger }', optChar('}', 'Digit9', 57, true), ['K16:d', 'U+}:d', 'U+}:u', 'K16:u']],
        ['Option+7 ger |', optChar('|', 'Digit7', 55), ['U+|:d', 'U+|:u']],
        ['Shift+Option+7 ger \\', optChar('\\', 'Digit7', 55, true), ['K16:d', 'U+\\:d', 'U+\\:u', 'K16:u']],
        ['Option+¨ ger ~ (direkt)', optChar('~', 'BracketRight', 221), ['U+~:d', 'U+~:u']],
        ['Option+¨ som död tangent, sedan mellanslag, ger ~', [down(ALT, M.alt), down({ key: 'Dead', code: 'BracketRight', vk: 221 }, M.alt), up({ key: 'Dead', code: 'BracketRight', vk: 221 }, M.alt), up(ALT, 0), down({ key: '~', code: 'Space', vk: 32 }, 0, '~'), up({ key: '~', code: 'Space', vk: 32 }, 0)], ['U+~:d', 'U+~:u']],
        ['Cmd+C blir Ctrl+C', cmdKey('c', 'KeyC', 67), ['K17:d', 'K67:d', 'K67:u', 'K17:u']],
        ['Cmd+V blir Ctrl+V', cmdKey('v', 'KeyV', 86), ['K17:d', 'K86:d', 'K86:u', 'K17:u']],
        ['Cmd+X blir Ctrl+X', cmdKey('x', 'KeyX', 88), ['K17:d', 'K88:d', 'K88:u', 'K17:u']],
        ['Cmd+A blir Ctrl+A', cmdKey('a', 'KeyA', 65), ['K17:d', 'K65:d', 'K65:u', 'K17:u']],
        ['Cmd+Z blir Ctrl+Z', cmdKey('z', 'KeyZ', 90), ['K17:d', 'K90:d', 'K90:u', 'K17:u']],
        ['Cmd+S blir Ctrl+S', cmdKey('s', 'KeyS', 83), ['K17:d', 'K83:d', 'K83:u', 'K17:u']],
        ['Cmd+C med keyup för C (Safari/äldre) ger inget extra', [down(META, M.meta), down({ key: 'c', code: 'KeyC', vk: 67 }, M.meta, 'c'), up({ key: 'c', code: 'KeyC', vk: 67 }, M.meta), up(META, 0)], ['K17:d', 'K67:d', 'K67:u', 'K17:u']],
        ['Cmd+Shift+Z blir Ctrl+Shift+Z', [down(META, M.meta), down(SHIFT, M.meta | M.shift), down({ key: 'z', code: 'KeyZ', vk: 90 }, M.meta | M.shift, 'z'), up(SHIFT, M.meta), up(META, 0)], ['K16:d', 'K17:d', 'K90:d', 'K90:u', 'K16:u', 'K17:u']],
        ['Cmd+Vänsterpil blir Ctrl+Vänsterpil', [down(META, M.meta), down({ key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, M.meta), up(META, 0)], ['K17:d', 'K37:xd', 'K37:xu', 'K17:u']],
        ['Cmd ensam öppnar inte Start', [down(META, M.meta), up(META, 0)], []],
        ['Option ensam skickar inget', [down(ALT, M.alt), up(ALT, 0)], []],
        ['Option+Tab blir Alt+Tab', [down(ALT, M.alt), down({ key: 'Tab', code: 'Tab', vk: 9 }, M.alt), up({ key: 'Tab', code: 'Tab', vk: 9 }, M.alt), up(ALT, 0)], ['K18:d', 'K9:d', 'K9:u', 'K18:u']],
        ['Option+F4 blir Alt+F4', [down(ALT, M.alt), down({ key: 'F4', code: 'F4', vk: 115 }, M.alt), up({ key: 'F4', code: 'F4', vk: 115 }, M.alt), up(ALT, 0)], ['K18:d', 'K115:d', 'K115:u', 'K18:u']],
        ['< ger <', plain('<', 'IntlBackslash', 226), ['U+<:d', 'U+<:u']],
        ['Shift+< ger >', [down(SHIFT, M.shift), down({ key: '>', code: 'IntlBackslash', vk: 226 }, M.shift, '>'), up({ key: '>', code: 'IntlBackslash', vk: 226 }, M.shift), up(SHIFT, 0)], ['K16:d', 'U+>:d', 'U+>:u', 'K16:u']],
        ['Ctrl+< skickar tangentkod 226', [down(CTRL, M.ctrl), down({ key: '<', code: 'IntlBackslash', vk: 226 }, M.ctrl), up({ key: '<', code: 'IntlBackslash', vk: 226 }, M.ctrl), up(CTRL, 0)], ['K17:d', 'K226:d', 'K226:u', 'K17:u']],
        ['å', plain('å', 'BracketLeft', 219), ['U+å:d', 'U+å:u']],
        ['ä', plain('ä', 'Quote', 222), ['U+ä:d', 'U+ä:u']],
        ['ö', plain('ö', 'Semicolon', 186), ['U+ö:d', 'U+ö:u']],
        ['Ctrl+C från Mac:ens Ctrl-tangent är oförändrat Ctrl+C', [down(CTRL, M.ctrl), down({ key: 'c', code: 'KeyC', vk: 67 }, M.ctrl, 'c'), up({ key: 'c', code: 'KeyC', vk: 67 }, M.ctrl), up(CTRL, 0)], ['K17:d', 'K67:d', 'K67:u', 'K17:u']]
    ];
    const keyTable = [];
    for (const [name, steps, expected] of table) {
        const got = await seq(steps);
        keyTable.push({ name, expected, got });
        check('Tangent: ' + name, JSON.stringify(got) === JSON.stringify(expected), { expected, got });
    }
    fs.writeFileSync(path.join(outDir, 'tangenttabell.json'), JSON.stringify(keyTable, null, 2));

    // Switch off: MeshCentral's own behaviour comes back (Cmd = Windows key, Option = Alt).
    await page.click('#rmmMacButton');
    check('Mac-tangenter går att slå av', (await page.eval('rmmMacKeysOn()')) === false);
    let got = await seq(cmdKey('c', 'KeyC', 67));
    check('Avslaget: Cmd+C blir Windows-tangenten (som förut)', got.includes('K91:d'), got);
    got = await seq(optChar('@', 'Digit2', 50));
    check('Avslaget: Option+2 blir Alt+2 (som förut)', JSON.stringify(got) === JSON.stringify(['K18:d', 'K50:d', 'K50:u', 'K18:u']), got);
    await page.click('#rmmMacButton');
    check('Mac-tangenter på igen', (await page.eval('rmmMacKeysOn()')) === true);

    // ---------------------------------------------------------------- quick keys and typing
    const quickExpect = [
        ['10', ['CAD']], ['5', ['K91:xd', 'K91:xu']], ['esc', ['K27:d', 'K27:u']], ['tab', ['K9:d', 'K9:u']],
        ['9', ['K18:xd', 'K9:d', 'K9:u', 'K18:xu']], ['7', ['K18:xd', 'K115:d', 'K115:u', 'K18:xu']]
    ];
    const quickNames = { 10: 'Ctrl+Alt+Del', 5: 'Win', esc: 'Esc', tab: 'Tab', 9: 'Alt+Tab', 7: 'Alt+F4' };
    for (const [k, expected] of quickExpect) {
        agent.clearKeys();
        await page.click('.rmm-quick[data-key="' + k + '"]');
        await sleep(150);
        got = fmtKeys(agent.log.keys);
        check('Snabbknapp ' + quickNames[k], JSON.stringify(got) === JSON.stringify(expected), { expected, got });
    }
    check('Snabbknapparna tar inte tangentbordsfokus', (await page.eval("document.activeElement && document.activeElement.classList.contains('rmm-btn')")) === false);
    agent.clearKeys();
    await page.click('#DeskType');
    await page.waitFor("document.getElementById('d2typeText') != null && xxdialogMode == 2");
    await page.eval("document.getElementById('d2typeText').value = 'Hej å\\n@'; dialogclose(1); true");
    await sleep(200);
    got = fmtKeys(agent.log.keys);
    const typeExpect = ['U+H:d', 'U+H:u', 'U+e:d', 'U+e:u', 'U+j:d', 'U+j:u', 'U+ :d', 'U+ :u', 'U+å:d', 'U+å:u', 'K13:d', 'K13:u', 'U+@:d', 'U+@:u'];
    check('Skriv text: tecken som tecken, radbrytning som Enter', JSON.stringify(got) === JSON.stringify(typeExpect), got);

    // ---------------------------------------------------------------- connection indicator (fixed quality, so Auto does not move)
    await page.click('#rmmQuality [data-q="sharp"]');
    agent.cfg.latency = 250;
    check('Fördröjning 250 ms visas som Svajig', (await page.waitFor("rmmNet.state == 'shaky' && document.getElementById('rmmNetText').textContent", 10000)) === 'Svajig');
    await page.screenshot(path.join(outDir, 'svajig.png'));
    agent.cfg.latency = 700;
    check('Fördröjning 700 ms visas som Dålig', (await page.waitFor("rmmNet.state == 'bad' && document.getElementById('rmmNetText').textContent", 10000)) === 'Dålig');
    agent.cfg.latency = 0;
    check('Bra igen när fördröjningen försvinner', (await page.waitFor("rmmNet.state == 'good' && document.getElementById('rmmNetText').textContent", 12000)) === 'Bra');

    // ---------------------------------------------------------------- Auto under a narrow link
    if (!quick) {
        await page.click('#rmmQuality [data-q="auto"]');
        await sleep(1500);
        const t0 = Date.now(), startStep = await page.eval('rmmAutoStep');
        agent.cfg.heavy = true; agent.cfg.bw = 150000; // 150 kB/s and a moving picture
        let lowest = startStep;
        while (Date.now() - t0 < 30000) {
            const s = await page.eval('({ step: rmmAutoStep, state: rmmNet.state, eff: rmmNet.eff, kbs: Math.round(rmmNet.rateBytes / 1024) })');
            trace.push(Object.assign({ t: Math.round((Date.now() - t0) / 1000), phase: 'smal länk 150 kB/s' }, s));
            lowest = Math.max(lowest, s.step);
            if (s.step >= startStep + 3) break;
            await sleep(1000);
        }
        c = lastComp();
        check('Auto: smal länk ger lägre kvalitet och färre bilder per sekund', lowest >= startStep + 2, { startStep, step: lowest, last: c });
        agent.cfg.heavy = false; agent.cfg.bw = 0;
        const t1 = Date.now();
        let up = false;
        while (Date.now() - t1 < 45000) {
            const s = await page.eval('({ step: rmmAutoStep, state: rmmNet.state, eff: rmmNet.eff, kbs: Math.round(rmmNet.rateBytes / 1024) })');
            trace.push(Object.assign({ t: Math.round((Date.now() - t0) / 1000), phase: 'bra länk' }, s));
            if (s.step < lowest) { up = true; if (s.step <= startStep) break; }
            await sleep(1000);
        }
        check('Auto: går upp igen när länken blir bra', up, { from: lowest, now: await page.eval('rmmAutoStep') });
        fs.writeFileSync(path.join(outDir, 'auto-forlopp.json'), JSON.stringify(trace, null, 2));
    }

    // ---------------------------------------------------------------- reconnect after a drop
    await connected();
    const connectsBefore = agent.log.connects.length;
    const tDrop = Date.now();
    agent.drop(1800);
    await page.waitFor("document.getElementById('rmmReconnect').classList.contains('rmm-show')", 3000, 'overlay');
    const ov = await page.eval("({ title: document.getElementById('rmmReconnectTitle').textContent, stale: document.getElementById('Desk').classList.contains('rmm-stale'), px: (function(){ var c = document.getElementById('Desk'); var d = c.getContext('2d').getImageData(Math.floor(c.width/2), Math.floor(c.height/3), 1, 1).data; return d[0] + d[1] + d[2]; })() })");
    check('Avbrott: "Ansluter igen…" över den senaste bilden (gråad, inte svart)', ov.title === 'Ansluter igen…' && ov.stale && ov.px > 30, ov);
    await sleep(300);
    await page.screenshot(path.join(outDir, 'ansluter-igen.png'));
    await connected(12000);
    const back = Date.now() - tDrop;
    const attempts = agent.log.refused.filter((t) => t >= tDrop).concat(agent.log.connects.slice(connectsBefore)).sort((a, b) => a - b).map((t) => t - tDrop);
    check('Återansluter av sig själv, utan omladdning', (await page.eval('window.__harnessMarker === 1')) && back < 6000, { msToPicture: back, attemptsMs: attempts });
    check('Snabba försök med back-off (cirka 0,5 s, 1 s, 2 s)', attempts.length >= 2 && attempts[0] < 1200 && (attempts.length < 3 || (attempts[2] - attempts[1]) > (attempts[1] - attempts[0]) - 200), attempts);

    // ---------------------------------------------------------------- dead link (no close, no data)
    const tSilent = Date.now(), connectsSilent = agent.log.connects.length;
    agent.silence();
    let detected = null;
    while (Date.now() - tSilent < 25000) { if (agent.log.connects.length > connectsSilent) { detected = Date.now() - tSilent; break; } await sleep(200); }
    check('Död länk upptäcks och återansluts (inom cirka 12–16 s)', detected !== null && detected < 20000, { ms: detected });
    await connected(10000);

    // ---------------------------------------------------------------- picture format (step 3: JPEG only)
    await sleep(1500);
    const info = await page.eval('rmmInfoText()');
    check('Bildformat: JPEG ritas och visas som JPEG, ingen WebP nämns', (await page.eval('rmmAgentFormat')) === 'jpeg' && info.indexOf('JPEG') === 0 && !/webp/i.test(info) && !/webp/i.test(await page.eval('document.body.innerText')), info);
    agent.drop(0);
    await connected(10000);
    await sleep(800);
    const req0 = agent.log.compression.length, drawn0 = await page.eval('rmmStats.drawn || 0');
    agent.cfg.corrupt = 3;
    await sleep(2500);
    const drawn = await page.eval('({ broken: rmmBrokenTiles, pending: desktop.m.PendingOperations.length, fmt: rmmAgentFormat, drawn: rmmStats.drawn || 0 })');
    check('Bildruta som inte går att avkoda: hoppas över, bilden fastnar inte, sidan ber om en ny bild', drawn.broken >= 3 && drawn.pending < 5 && drawn.drawn > drawn0 && agent.log.compression.length > req0, drawn);

    // ---------------------------------------------------------------- end session and reconnect by hand
    const connectsEnd = agent.log.connects.length;
    await page.click('#disconnectbutton1');
    await page.waitFor("document.getElementById('rmmReconnectTitle').textContent == 'Sessionen är avslutad'", 3000);
    await sleep(3000);
    check('Avsluta: ingen automatisk återanslutning', agent.log.connects.length === connectsEnd, { connects: agent.log.connects.length - connectsEnd });
    await page.click('#rmmReconnectButton');
    await connected(10000);
    check('Knappen Anslut igen fungerar', agent.log.connects.length === connectsEnd + 1);

    // ---------------------------------------------------------------- remembered choices after reload
    await page.click('#rmmQuality [data-q="sharp"]');
    await sleep(500);
    agent.display = 1;
    const sdBefore = agent.log.setDisplay.length;
    agent.reset();
    await load();
    await connected();
    await sleep(1200);
    check('Efter omladdning: Skarp är kvar', (await page.eval("document.querySelector('#rmmQuality [data-q=\"sharp\"]').getAttribute('aria-pressed')")) === 'true' && agent.log.compression.some((x) => x.q === 80));
    check('Efter omladdning: vald skärm (2) väljs igen', agent.log.setDisplay.includes(2), { sdBefore, setDisplay: agent.log.setDisplay });

    // ---------------------------------------------------------------- clipboard safety
    check('Urklippet flyttas aldrig av sig självt (inget skickat på urklippskanalen)', agent.log.sharecontrol.length === 0 && agent.log.sharecontrolConnects >= 1, { messages: agent.log.sharecontrol.length, connects: agent.log.sharecontrolConnects });

    // ---------------------------------------------------------------- share expiry
    agent.reset();
    await load({ expire: Date.now() + 7000 });
    await connected();
    await page.waitFor("document.getElementById('rmmReconnectTitle').textContent == 'Tiden för fjärrstyrningen är slut' && document.getElementById('rmmReconnect').classList.contains('rmm-show')", 12000, 'expired overlay');
    const afterExpiry = agent.log.connects.length;
    await sleep(4000);
    const exp = await page.eval('({ desktop: desktop == null, share: shareControl == null })');
    check('När länken går ut: skrivbord och urklipp stängs, inga nya försök', exp.desktop && exp.share && agent.log.connects.length === afterExpiry, exp);
    await page.screenshot(path.join(outDir, 'tiden-slut.png'));

    // ---------------------------------------------------------------- Windows viewer: Mac mode off by default
    await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', platform: 'Win32', userAgentMetadata: { platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', model: '', mobile: false, brands: [] } });
    await page.eval('localStorage.clear(); true');
    agent.reset();
    await load();
    await connected();
    check('Windows-webbläsare: Mac-läget är av', (await page.eval('rmmMacKeysOn()')) === false);
    await page.send('Emulation.setUserAgentOverride', { userAgent: '' });

    } // end of the step 1 checks

    // ---------------------------------------------------------------- step 2: phone, tablet, keyboard, WebRTC
    // (Step 1's 390 px check of the two toolbars is replaced: on a phone the toolbars give way to the mobile view.)
    const offersBefore = agent.totalOffers || 0;
    if (!step3Only) { await runStep2({ page, cdp, agent, check, outDir, load, connected, lastComp, waitComp, fmtKeys, peerPage, quick, offersBefore }); }

    // ---------------------------------------------------------------- step 3: scaling with a real agent's habits, Ctrl+Alt+Del across path switches
    await runStep3({ page, agent, check, outDir, load, connected, peerPage });

    check('Inga JavaScript-fel på sidan', page.errors.length === 0, page.errors.slice(0, 5));
} catch (ex) {
    check('Körningen avbröts', false, String(ex && ex.stack || ex));
} finally {
    const failed = results.filter((r) => !r.ok);
    fs.writeFileSync(path.join(outDir, 'resultat.json'), JSON.stringify({ when: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
    console.log('\n' + (results.length - failed.length) + ' OK, ' + failed.length + ' FAIL. Resultat och bilder: ' + outDir);
    await cleanup();
    process.exit(failed.length ? 1 : 0);
}
