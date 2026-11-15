// Nordbase Remote step 2: phone/tablet view, gestures, phone keyboard, sticky modifiers, zoom/pan maths,
// reconnect that keeps the view, networks that change, and the direct path (WebRTC) with its silent
// fallback. Called from run.mjs with the same fake server, agent and Chrome.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';

const UA = {
    iphone: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone' },
    android: { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l' },
    ipad: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', platform: 'MacIntel' }
};

export async function runStep2(ctx) {
    const { page, agent, check, outDir, load, connected, lastComp, waitComp, fmtKeys, peerPage } = ctx;
    const shot = (name) => page.screenshot(path.join(outDir, name));
    const mouse = () => agent.log.input.filter((k) => k.t === 'm');
    const wheels = () => agent.log.input.filter((k) => k.t === 'w');
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    const fmtMouse = (list) => list.map((m) => ({ 0: 'move', 2: 'L-ned', 4: 'L-upp', 8: 'H-ned', 16: 'H-upp' }[m.b] + '@' + m.x + ',' + m.y));
    const remoteText = (list) => { let s = ''; for (const k of list) { if ((k.t === 'uni') && (k.flag === 0)) s += k.ch; else if ((k.t === 'key') && (k.flag === 0) && (k.kc === 8)) s = s.slice(0, -1); else if ((k.t === 'key') && (k.flag === 0) && (k.kc === 13)) s += '\n'; } return s; };
    const keysOnly = () => fmtKeys(agent.log.input.filter((k) => (k.t === 'key') || (k.t === 'uni') || (k.t === 'cad')));
    const tracker = {};

    async function device(w, h, dpr, ua) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: true, screenWidth: w, screenHeight: h });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        try { await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] }); } catch (ex) { }
        await page.send('Emulation.setUserAgentOverride', Object.assign({}, UA[ua]));
    }
    async function desktopMode() {
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        try { await page.send('Emulation.setEmulatedMedia', { features: [] }); } catch (ex) { }
        await page.send('Emulation.setUserAgentOverride', { userAgent: '' });
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    }
    // The rendered canvas rectangle is what the finger touches; the page's own maths must agree with it.
    const view = () => page.eval(`(function(){ var a = document.getElementById('deskarea3x').getBoundingClientRect(), c = document.getElementById('Desk'), d = c.getBoundingClientRect();
        return { area: { l: a.left, t: a.top, w: a.width, h: a.height }, fit: rmmView.fit, z: rmmView.z, tx: rmmView.tx, ty: rmmView.ty, cx: rmmView.cx, cy: rmmView.cy, cw: c.width, ch: c.height,
                 rect: { l: d.left, t: d.top, w: d.width, h: d.height }, ptr: { nx: rmmPtr.nx, ny: rmmPtr.ny }, scale: rmmViewScale() }; })()`);
    const expectAt = (v, cx, cy) => ({ x: Math.floor(((cx - v.rect.l) / v.rect.w) * v.cw), y: Math.floor(((cy - v.rect.t) / v.rect.h) * v.ch) });
    const ptrRemote = (v) => ({ x: Math.floor(v.ptr.nx * v.cw), y: Math.floor(v.ptr.ny * v.ch) });
    const normAt = (v, cx, cy) => ({ nx: (cx - v.rect.l) / v.rect.w, ny: (cy - v.rect.t) / v.rect.h });
    const clickAt = (list, b, p, tol = 1) => list.some((m) => (m.b === b) && near(m.x, p.x, tol) && near(m.y, p.y, tol));
    async function panel(open) { const isOpen = await page.eval("document.body.classList.contains('rmm-panel-open')"); if (isOpen !== open) { if (open) await page.tapEl('#rmmHandle'); else await page.tapEl('#rmmPanel .rmm-close'); await sleep(300); } }
    // The key bar scrolls sideways on a phone: bring the key into view first, as a finger would.
    async function keyTap(sel) { await page.eval(`document.querySelector(${JSON.stringify('#rmmKeyBar ' + sel)}).scrollIntoView({ block: 'nearest', inline: 'center' }); true`); await sleep(120); await page.tapEl('#rmmKeyBar ' + sel); await sleep(60); }
    const ime = (text) => page.send('Input.insertText', { text });
    async function backspace() {
        await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, commands: ['deleteBackward'] });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    }
    async function freshPhone(values) {
        await device(390, 844, 3, 'iphone');
        await page.eval('try { localStorage.clear(); sessionStorage.clear(); } catch (ex) { } true').catch(() => { });
        agent.reset(); agent.display = 1;
        await load(values);
        await page.eval('try { localStorage.clear(); sessionStorage.clear(); } catch (ex) { } true');
        agent.reset(); agent.display = 1;
        await load(values);
        await connected();
        await sleep(800);
    }

    // =====================================================================================  phone, portrait
    await freshPhone();
    const dev = await page.eval("({ mobile: document.body.classList.contains('rmm-mobile'), phone: rmmDev.phone, bars: document.getElementById('deskarea1').offsetHeight + document.getElementById('deskarea4').offsetHeight, handle: (function(){ var r = document.getElementById('rmmHandle').getBoundingClientRect(); return { w: r.width, h: r.height, t: r.top }; })(), scroll: document.documentElement.scrollWidth <= window.innerWidth })");
    check('Telefon: mobilvyn slås på av sig själv (pekskärm), samma länk som på datorn', dev.mobile && dev.phone, dev);
    check('Telefon: verktygsraderna är borta, ett litet handtag finns (minst 44 px)', (dev.bars === 0) && (dev.handle.h >= 44) && (dev.handle.w >= 44), dev);
    check('Telefon: sidan rullar inte i sidled', dev.scroll);
    let v = await view();
    check('Telefon: datorns skärm fyller telefonens bredd', near(v.rect.w, 390, 1), v.rect);
    let c = lastComp();
    const slow = await page.eval('({ cellular: rmmDev.cellular, type: navigator.connection ? (navigator.connection.type || "") : "", effective: navigator.connection ? navigator.connection.effectiveType : "" })');
    check('Telefon: Auto börjar lägre (kvalitet 40, 12,5 bilder/s; ett steg till om nätet är mobildata eller långsamt)', c && (slow.cellular ? ((c.q === 35) && (c.fr === 100)) : ((c.q === 40) && (c.fr === 80))), Object.assign({}, c, slow));
    check('Telefon: 4K-skärm skickas som 25 % (960x540), inte 4K', c && (c.scaling === 256) && (v.cw === 960), { scaling: c && c.scaling, canvas: v.cw + 'x' + v.ch });

    // ---------------------------------------------------------------- panel
    await panel(true);
    const pb = await page.eval("Array.from(document.querySelectorAll('#rmmPanel .rmm-btn')).filter(b => b.offsetParent !== null).map(b => ({ t: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width) }))");
    check('Panelen: alla knappar är minst 44 px höga (fingervänliga)', pb.length > 10 && pb.every((b) => b.h >= 44 && b.w >= 44), pb.filter((b) => b.h < 44 || b.w < 44));
    const pnet = await page.eval("({ t: document.getElementById('rmmMNetText').textContent, p: document.getElementById('rmmMNetPath').textContent })");
    check('Panelen: anslutningen visas med väg ("Bra", "Via servern")', (pnet.t === 'Bra') && (pnet.p === 'Via servern'), pnet);
    await shot('telefon-panel.png');
    await page.tapEl('#rmmPanel [data-pm="touch"]');
    await sleep(150);
    check('Panelen: byte till Peka', (await page.eval('rmmPrefs.pointer')) === 'touch');
    await panel(false);

    // ---------------------------------------------------------------- Peka: taps, zoom, hold, drag, scroll, pinch
    v = await view();
    let P = { x: v.rect.l + v.rect.w * 0.30, y: v.rect.t + v.rect.h * 0.40 };
    agent.clearInput();
    await page.tap(P.x, P.y);
    await sleep(120);
    const early = mouse().length;
    await sleep(400);
    let exp = expectAt(v, P.x, P.y), got = mouse();
    check('Peka, liten bild: tryck = klick där fingret var (väntar 0,3 s på ett dubbeltryck)', early === 0 && got.length === 3 && got[0].b === 0 && clickAt(got, 2, exp) && clickAt(got, 4, exp), { expected: exp, got: fmtMouse(got), early });

    const before = normAt(v, P.x, P.y);
    agent.clearInput();
    await page.tap(P.x, P.y); await sleep(110); await page.tap(P.x, P.y);
    await sleep(600);
    v = await view();
    const after = normAt(v, P.x, P.y);
    check('Peka: dubbeltryck på liten bild zoomar in där (och klickar inte)', v.z >= 2 && mouse().length === 0, { z: v.z, clicks: mouse().length });
    check('Zoom: punkten under fingret ligger kvar under fingret', near(before.nx, after.nx, 0.002) && near(before.ny, after.ny, 0.002), { before, after });
    check('Zoom: sidans egen räkning stämmer med den ritade bilden', near(v.rect.l, v.area.l + v.fit.x + v.tx, 0.6) && near(v.rect.t, v.area.t + v.fit.y + v.ty, 0.6) && near(v.rect.w, v.fit.w * v.z, 0.6), { rect: v.rect, calc: { l: v.area.l + v.fit.x + v.tx, w: v.fit.w * v.z } });
    c = await waitComp((x) => x.scaling > 256, 5000, 'sharper when zoomed');
    await sleep(800);
    c = lastComp();
    check('Inzoomat: skarpare bild begärs, men aldrig mer än Full HD till en telefon (4K högst 50 %)', c.scaling === 512, c);
    v = await view();
    check('Inzoomat: bilden är nu 1920x1080', (v.cw === 1920) && (v.ch === 1080), v.cw + 'x' + v.ch);

    // zoomed: taps click at once
    P = { x: 120, y: 380 };
    v = await view();
    exp = expectAt(v, P.x, P.y);
    agent.clearInput();
    await page.tap(P.x, P.y);
    await sleep(150);
    got = mouse();
    check('Peka, inzoomat: tryck klickar direkt på exakt den punkt som syns under fingret', got.length === 3 && clickAt(got, 2, exp) && clickAt(got, 4, exp), { expected: exp, got: fmtMouse(got), scale: v.scale });
    tracker.zoomTap = { finger: P, expected: exp, got: fmtMouse(got), z: v.z, tx: v.tx, ty: v.ty };
    agent.clearInput();
    await page.tap(P.x, P.y); await sleep(100); await page.tap(P.x, P.y);
    await sleep(200);
    got = mouse();
    check('Peka, inzoomat: dubbeltryck = dubbelklick', got.filter((m) => m.b === 2).length === 2 && got.filter((m) => m.b === 4).length === 2 && clickAt(got, 2, exp), fmtMouse(got));

    agent.clearInput();
    await page.touch('touchStart', [{ x: P.x, y: P.y, id: 1 }]); await sleep(650); await page.touch('touchEnd', []);
    await sleep(150);
    got = mouse();
    check('Peka: håll kvar = högerklick där', got.length === 3 && clickAt(got, 8, exp) && clickAt(got, 16, exp), fmtMouse(got));

    agent.clearInput();
    const Q2 = { x: P.x + 60, y: P.y + 40 };
    await page.touch('touchStart', [{ x: P.x, y: P.y, id: 1 }]); await sleep(600);
    for (let i = 1; i <= 10; i++) { await page.touch('touchMove', [{ x: P.x + 6 * i, y: P.y + 4 * i, id: 1 }]); await sleep(30); }
    await page.touch('touchEnd', []);
    await sleep(150);
    got = mouse();
    v = await view();
    const expEnd = expectAt(v, Q2.x, Q2.y);
    const downI = got.findIndex((m) => m.b === 2), upI = got.findIndex((m) => m.b === 4);
    check('Peka: håll kvar och dra = dra och släpp (ned vid start, upp där fingret släpper)', downI >= 0 && upI > downI && clickAt([got[downI]], 2, exp) && clickAt([got[upI]], 4, expEnd, 2) && got.slice(downI + 1, upI).some((m) => m.b === 0), { start: exp, end: expEnd, got: fmtMouse(got).slice(0, 4).concat(['...']).concat(fmtMouse(got).slice(-2)) });

    agent.clearInput();
    let v0 = await view();
    await page.drag(null, { x: 250, y: 400 }, { x: 170, y: 400 }, 8, 25);
    await sleep(150);
    v = await view();
    check('Peka, inzoomat: dra med ett finger flyttar bilden (inga klick)', near(v.tx - v0.tx, -80, 2) && mouse().length === 0, { dtx: v.tx - v0.tx, clicks: mouse().length });

    agent.clearInput();
    const a0 = { x: 150, y: 520 }, b0 = { x: 240, y: 520 };
    await page.touch('touchStart', [{ x: a0.x, y: a0.y, id: 1 }, { x: b0.x, y: b0.y, id: 2 }]); await sleep(40);
    for (let i = 1; i <= 12; i++) { await page.touch('touchMove', [{ x: a0.x, y: a0.y - 10 * i, id: 1 }, { x: b0.x, y: b0.y - 10 * i, id: 2 }]); await sleep(30); }
    await page.touch('touchEnd', []);
    await sleep(150);
    let w = wheels();
    v = await view();
    let sum = w.reduce((s, x) => s + x.d, 0), expUnits = -(120 - 14) / v.scale * 1.2;
    check('Två fingrar uppåt = rulla nedåt (hjul minus), innehållet följer fingrarna', w.length > 0 && w.every((x) => x.d < 0) && mouse().length === 0 && near(sum, expUnits, 40), { events: w.length, sum, expected: Math.round(expUnits), scale: v.scale });
    tracker.scroll = { events: w.length, sum, expected: Math.round(expUnits) };
    agent.clearInput();
    await page.touch('touchStart', [{ x: a0.x, y: 300, id: 1 }, { x: b0.x, y: 300, id: 2 }]); await sleep(40);
    for (let i = 1; i <= 6; i++) { await page.touch('touchMove', [{ x: a0.x, y: 300 + 10 * i, id: 1 }, { x: b0.x, y: 300 + 10 * i, id: 2 }]); await sleep(30); }
    await page.touch('touchEnd', []);
    await sleep(150);
    w = wheels();
    check('Två fingrar nedåt = rulla uppåt (hjul plus)', w.length > 0 && w.every((x) => x.d > 0), w.map((x) => x.d));

    await panel(true);
    await page.tapEl('#rmmPanel [onclick^="rmmFitView"]');
    await sleep(500);
    v = await view();
    check('Passa in: hela skärmen syns igen', v.z === 1 && near(v.rect.w, 390, 1), { z: v.z });
    const M = { x: 195, y: 422 };
    const mBefore = normAt(v, M.x, M.y);
    await page.touch('touchStart', [{ x: M.x - 50, y: M.y, id: 1 }, { x: M.x + 50, y: M.y, id: 2 }]); await sleep(40);
    for (let i = 1; i <= 10; i++) { await page.touch('touchMove', [{ x: M.x - 50 - 5 * i, y: M.y, id: 1 }, { x: M.x + 50 + 5 * i, y: M.y, id: 2 }]); await sleep(30); }
    await page.touch('touchEnd', []);
    await sleep(300);
    v = await view();
    const mAfter = normAt(v, M.x, M.y);
    check('Nyp: avståndet dubbelt så stort = dubbel zoom', near(v.z, 2, 0.05), { z: v.z });
    check('Nyp: punkten mellan fingrarna ligger kvar', near(mBefore.nx, mAfter.nx, 0.003) && near(mBefore.ny, mAfter.ny, 0.003), { mBefore, mAfter });
    tracker.pinch = { z: v.z, mBefore, mAfter };
    await sleep(1500); // the sharper picture for the new zoom arrives first

    agent.clearInput();
    v = await view();
    const mid = { x: 195, y: 422 }, expMid = expectAt(v, mid.x, mid.y);
    await page.touch('touchStart', [{ x: mid.x - 30, y: mid.y, id: 1 }, { x: mid.x + 30, y: mid.y, id: 2 }]); await sleep(60); await page.touch('touchEnd', []);
    await sleep(150);
    got = mouse();
    check('Två fingrar tryck = högerklick (Peka: mitt mellan fingrarna)', got.length === 3 && clickAt(got, 8, expMid) && clickAt(got, 16, expMid), { expected: expMid, got: fmtMouse(got) });

    // ---------------------------------------------------------------- Styrplatta
    await panel(true);
    await page.tapEl('#rmmPanel [data-pm="trackpad"]');
    await sleep(150);
    await panel(false);
    check('Styrplatta vald, pekaren syns', (await page.eval("rmmPrefs.pointer == 'trackpad' && document.getElementById('rmmPointer').classList.contains('rmm-show')")) === true);
    await page.eval('rmmZoomTo(7, 0.35, 0.35, 195, 400, false); rmmPtr.nx = 0.35; rmmPtr.ny = 0.35; rmmPointerPlace(); true');
    await sleep(700);
    v0 = await view();
    agent.clearInput();
    await page.drag(null, { x: 150, y: 600 }, { x: 210, y: 630 }, 12, 30);
    await sleep(150);
    v = await view();
    const dnx = v.ptr.nx - v0.ptr.nx, dny = v.ptr.ny - v0.ptr.ny;
    const expDnx = 60 / (v0.fit.w * v0.z), expDny = 30 / (v0.fit.h * v0.z);
    got = mouse();
    const lastMove = got.filter((m) => m.b === 0).pop();
    const pr = ptrRemote(v);
    check('Styrplatta: dra 60x30 px flyttar pekaren lika långt på skärmen (1:1 när det går långsamt)', near(dnx, expDnx, 0.0006) && near(dny, expDny, 0.0006), { dnx, expDnx, dny, expDny });
    check('Styrplatta: datorn får pekarens nya plats', lastMove && near(lastMove.x, pr.x, 1) && near(lastMove.y, pr.y, 1) && got.every((m) => m.b === 0), { last: lastMove, ptr: pr, n: got.length });
    const pe = await page.eval("(function(){ var r = document.getElementById('rmmPointer').getBoundingClientRect(); return { x: r.left + 2, y: r.top + 2 }; })()");
    const tip = { x: v.area.l + v.fit.x + v.tx + v.ptr.nx * v.fit.w * v.z, y: v.area.t + v.fit.y + v.ty + v.ptr.ny * v.fit.h * v.z };
    check('Styrplatta: den ritade pekarens spets står exakt på punkten (även inzoomat)', near(pe.x, tip.x, 1) && near(pe.y, tip.y, 1), { pe, tip });
    agent.clearInput();
    await page.tap(300, 200);
    await sleep(150);
    got = mouse();
    check('Styrplatta: tryck = klick där pekaren är (inte där fingret är)', got.length === 3 && clickAt(got, 2, pr) && clickAt(got, 4, pr), { ptr: pr, got: fmtMouse(got) });
    agent.clearInput();
    await page.touch('touchStart', [{ x: 100, y: 300, id: 1 }, { x: 180, y: 300, id: 2 }]); await sleep(60); await page.touch('touchEnd', []);
    await sleep(150);
    got = mouse();
    check('Styrplatta: två fingrar tryck = högerklick där pekaren är', got.length === 3 && clickAt(got, 8, pr) && clickAt(got, 16, pr), fmtMouse(got));
    agent.clearInput();
    v0 = await view();
    await page.touch('touchStart', [{ x: 150, y: 600, id: 1 }]); await sleep(600);
    for (let i = 1; i <= 10; i++) { await page.touch('touchMove', [{ x: 150 + 4 * i, y: 600 + 2 * i, id: 1 }]); await sleep(30); }
    await page.touch('touchEnd', []);
    await sleep(150);
    v = await view();
    got = mouse();
    const prEnd = ptrRemote(v);
    const d1 = got.findIndex((m) => m.b === 2), u1 = got.findIndex((m) => m.b === 4);
    check('Styrplatta: håll kvar och dra = dra och släpp från pekaren', d1 >= 0 && u1 > d1 && clickAt([got[d1]], 2, pr) && clickAt([got[u1]], 4, prEnd) && near(v.ptr.nx - v0.ptr.nx, 40 / (v0.fit.w * v0.z), 0.0006), { start: pr, end: prEnd, got: fmtMouse(got).slice(0, 3).concat(fmtMouse(got).slice(-1)) });
    v0 = await view();
    await page.drag(null, { x: 100, y: 500 }, { x: 380, y: 500 }, 28, 30);
    await sleep(200);
    v = await view();
    check('Styrplatta, inzoomat: bilden följer med när pekaren når kanten', v.tx < v0.tx - 50, { from: v0.tx, to: v.tx });
    v0 = await view();
    await page.drag(null, { x: 100, y: 500 }, { x: 160, y: 500 }, 3, 2);
    await sleep(150);
    v = await view();
    check('Styrplatta: snabb rörelse flyttar pekaren längre (acceleration)', (v.ptr.nx - v0.ptr.nx) > 1.3 * (60 / (v0.fit.w * v0.z)), { moved: v.ptr.nx - v0.ptr.nx, oneToOne: 60 / (v0.fit.w * v0.z) });
    await page.eval('rmmFitView(false); rmmPtr.nx = 0.5; rmmPtr.ny = 0.5; rmmPointerPlace(); true');
    await sleep(600);

    // ---------------------------------------------------------------- phone keyboard and key bar
    await panel(true);
    await page.tapEl('#rmmKbButton');
    await sleep(400);
    const kb = await page.eval("({ open: document.body.classList.contains('rmm-kb-open'), focus: document.activeElement && document.activeElement.id, bar: (function(){ var b = Array.from(document.querySelectorAll('#rmmKeyBar .rmm-btn')); return { n: b.length, minH: Math.min.apply(null, b.map(x => x.getBoundingClientRect().height)), minW: Math.min.apply(null, b.map(x => x.getBoundingClientRect().width)), bottom: document.getElementById('rmmKeyBar').getBoundingClientRect().bottom }; })(), font: getComputedStyle(document.getElementById('rmmIme')).fontSize })");
    check('Tangentbord: knappen öppnar telefonens tangentbord (dolt fält får fokus) och tangentraden', kb.open && kb.focus === 'rmmIme', kb);
    check('Tangentraden: knapparna är minst 44 px, fältet har 16 px text (iOS zoomar annars)', kb.bar.minH >= 44 && kb.bar.minW >= 44 && kb.font === '16px', kb);
    await shot('telefon-styrplatta-tangentrad.png');

    const typed = [
        ['Hej Åsa!', 'Hej Åsa!'],
        ['åäö ÅÄÖ', 'åäö ÅÄÖ'],
        ['@£$€{[]}\\|~', '@£$€{[]}\\|~'],
        ['^¨´`<>§½', '^¨´`<>§½'],
        ['Lösen0rd#2026', 'Lösen0rd#2026'],
        ['é ü ñ ß', 'é ü ñ ß']
    ];
    const typeTable = [];
    for (const [text, want] of typed) {
        agent.clearInput();
        for (const ch of text) { await ime(ch); }
        await sleep(120);
        const seq = keysOnly(), wantSeq = [...want].flatMap((ch) => ['U+' + ch + ':d', 'U+' + ch + ':u']);
        typeTable.push({ text, got: seq });
        check('Skriva från telefonen: "' + text + '" blir exakt de tecknen', JSON.stringify(seq) === JSON.stringify(wantSeq), seq.length > 20 ? seq.slice(0, 20).concat(['...']) : seq);
    }
    agent.clearInput();
    await ime('Ok'); await ime('\n');
    await sleep(100);
    check('Enter på telefonens tangentbord = Enter', JSON.stringify(keysOnly()) === JSON.stringify(['U+O:d', 'U+O:u', 'U+k:d', 'U+k:u', 'K13:d', 'K13:u']), keysOnly());
    agent.clearInput();
    await ime('ab'); await backspace(); await sleep(60); await backspace(); await sleep(60); await backspace(); await sleep(100);
    check('Backspace = Backspace, även när fältet är tomt', JSON.stringify(keysOnly()) === JSON.stringify(['U+a:d', 'U+a:u', 'U+b:d', 'U+b:u', 'K8:d', 'K8:u', 'K8:d', 'K8:u', 'K8:d', 'K8:u']), keysOnly());
    agent.clearInput();
    await ime('teh');
    await page.eval("(function(){ var t = document.getElementById('rmmIme'); t.value = t.value.replace(/teh$/, 'the '); t.dispatchEvent(new Event('input')); })(); true");
    await sleep(100);
    check('Autokorrigering ("teh" byts mot "the "): datorn får rätt text', remoteText(agent.log.input) === 'the ', { text: remoteText(agent.log.input), keys: keysOnly() });
    agent.clearInput();
    let compOk = true;
    try {
        for (const part of ['h', 'he', 'hej']) { await page.send('Input.imeSetComposition', { text: part, selectionStart: part.length, selectionEnd: part.length }); await sleep(40); }
        await ime('hej ');
    } catch (ex) { compOk = String(ex.message || ex); }
    await sleep(150);
    check('Tangentbord som bygger hela ord (Android Gboard): "hej " blir rätt', (compOk === true) && remoteText(agent.log.input) === 'hej ', { compOk, text: remoteText(agent.log.input), keys: keysOnly() });
    fs.writeFileSync(path.join(outDir, 'telefon-skrivtabell.json'), JSON.stringify(typeTable, null, 2));

    // sticky modifiers
    agent.clearInput();
    await keyTap('[data-mod="ctrl"]');
    const st1 = await page.eval("document.querySelector('#rmmKeyBar [data-mod=ctrl]').getAttribute('data-mod-state')");
    await ime('c'); await sleep(80);
    const st2 = await page.eval("document.querySelector('#rmmKeyBar [data-mod=ctrl]').getAttribute('data-mod-state')");
    await ime('c'); await sleep(80);
    check('Klistriga tangenter: Ctrl, sedan c = Ctrl+C; nästa c är bara c', JSON.stringify(keysOnly()) === JSON.stringify(['K17:d', 'K67:d', 'K67:u', 'K17:u', 'U+c:d', 'U+c:u']) && st1 === '1' && st2 === '0', { st1, st2, got: keysOnly() });
    agent.clearInput();
    await keyTap('[data-mod="ctrl"]'); await keyTap('[data-mod="ctrl"]');
    const st3 = await page.eval("document.querySelector('#rmmKeyBar [data-mod=ctrl]').getAttribute('data-mod-state')");
    await ime('a'); await ime('b'); await sleep(80);
    await keyTap('[data-mod="ctrl"]');
    await ime('d'); await sleep(80);
    check('Klistriga tangenter: tryck två gånger = låst (Ctrl+A, Ctrl+B), en gång till = av', st3 === '2' && JSON.stringify(keysOnly()) === JSON.stringify(['K17:d', 'K65:d', 'K65:u', 'K17:u', 'K17:d', 'K66:d', 'K66:u', 'K17:u', 'U+d:d', 'U+d:u']), { st3, got: keysOnly() });
    const combos = [
        ['Ctrl + Tab (raden)', async () => { await keyTap('[data-mod="ctrl"]'); await keyTap('[data-vk="9"]'); }, ['K17:d', 'K9:d', 'K9:u', 'K17:u']],
        ['Alt + Tab (raden)', async () => { await keyTap('[data-mod="alt"]'); await keyTap('[data-vk="9"]'); }, ['K18:d', 'K9:d', 'K9:u', 'K18:u']],
        ['Win + r', async () => { await keyTap('[data-mod="win"]'); await ime('r'); }, ['K91:xd', 'K82:d', 'K82:u', 'K91:xu']],
        ['Ctrl + Alt + Del via Ctrl, Alt och Del', async () => { await keyTap('[data-mod="ctrl"]'); await keyTap('[data-mod="alt"]'); await keyTap('[data-vk="46"]'); }, ['K17:d', 'K18:d', 'K46:xd', 'K46:xu', 'K18:u', 'K17:u']],
        ['Esc', async () => { await keyTap('[data-vk="27"]'); }, ['K27:d', 'K27:u']],
        ['Pil vänster', async () => { await keyTap('[data-vk="37"]'); }, ['K37:xd', 'K37:xu']],
        ['Pil upp', async () => { await keyTap('[data-vk="38"]'); }, ['K38:xd', 'K38:xu']],
        ['Snabbval Ctrl+Alt+Del', async () => { await keyTap('[data-quick="10"]'); }, ['CAD']],
        ['Snabbval Alt+Tab', async () => { await keyTap('[data-quick="9"]'); }, ['K18:xd', 'K9:d', 'K9:u', 'K18:xu']],
        ['Snabbval Alt+F4', async () => { await keyTap('[data-quick="7"]'); }, ['K18:xd', 'K115:d', 'K115:u', 'K18:xu']]
    ];
    for (const [name, act, want] of combos) {
        agent.clearInput();
        await act();
        await sleep(120);
        check('Tangentraden: ' + name, JSON.stringify(keysOnly()) === JSON.stringify(want), { want, got: keysOnly() });
    }
    check('Tangentraden tar inte fokus: telefonens tangentbord är kvar', (await page.eval('document.activeElement && document.activeElement.id')) === 'rmmIme');
    agent.clearInput();
    await page.eval("rmmSetPointerMode('touch'); true");
    await keyTap('[data-mod="ctrl"]');
    v = await view();
    await page.tap(200, 300);
    await sleep(500);
    check('Ctrl + tryck på skärmen = Ctrl+klick', JSON.stringify(fmtKeys(agent.log.input.filter((k) => k.t !== 'm'))) === JSON.stringify(['K17:d', 'K17:u']) && mouse().length === 3 && agent.log.input[0].t === 'key' && agent.log.input[agent.log.input.length - 1].t === 'key', agent.log.input.map((k) => k.t === 'm' ? 'm' + k.b : (k.kc + ':' + k.flag)));
    await shot('telefon-peka-tangentrad.png');
    await keyTap('[data-kb="type"]');
    await sleep(300);
    check('Tangentraden: Skriv text öppnar rutan', (await page.eval('xxdialogMode == 2 && !!document.getElementById("d2typeText")')) === true);
    await page.eval('dialogclose(0); true');
    await sleep(200);

    // ---------------------------------------------------------------- screens in the panel
    await page.eval("rmmKeyboard(false); true");
    await panel(true);
    const scr = await page.eval("Array.from(document.querySelectorAll('#rmmMDisplays .rmm-btn')).map(b => b.textContent)");
    check('Panelen: en knapp per skärm', JSON.stringify(scr) === JSON.stringify(['Skärm 1', 'Skärm 2', 'Alla skärmar']), scr);
    await page.tapEl('#rmmMDisplays [data-display="2"]');
    await sleep(1200);
    check('Panelen: Skärm 2 byter skärm', agent.log.setDisplay.includes(2) && (await page.eval("document.querySelector('#rmmMDisplays [data-display=\"2\"]').getAttribute('aria-pressed')")) === 'true', agent.log.setDisplay);
    await page.tapEl('#rmmPanel [data-q="fast"]');
    c = await waitComp((x) => x.q === 30, 3000, 'snabb på telefon');
    check('Panelen: Snabb fungerar på telefon', c.q === 30, c);
    await page.tapEl('#rmmPanel [data-q="auto"]');
    await sleep(300);
    await panel(false);

    // ---------------------------------------------------------------- reconnect keeps zoom, pointer mode, screen, key bar
    await page.eval("rmmSetPointerMode('touch'); rmmZoomTo(3, 0.6, 0.4, 195, 422, false); rmmKeyboard(true); true");
    await sleep(800);
    const s0 = await page.eval('({ z: rmmView.z, cx: rmmView.cx, cy: rmmView.cy, pm: rmmPrefs.pointer, kb: rmmKb.open })');
    const sdN = agent.log.setDisplay.length;
    agent.display = 1; // a new agent session starts on its primary screen
    agent.drop(1500);
    await page.waitFor("document.getElementById('rmmReconnect').classList.contains('rmm-show')", 3000, 'overlay');
    await connected(12000);
    await sleep(1500);
    const s1 = await page.eval('({ z: rmmView.z, cx: rmmView.cx, cy: rmmView.cy, pm: rmmPrefs.pointer, kb: rmmKb.open })');
    check('Efter avbrott: zoom och plats är kvar', near(s1.z, s0.z, 0.01) && near(s1.cx, s0.cx, 0.01) && near(s1.cy, s0.cy, 0.01), { s0, s1 });
    check('Efter avbrott: Peka och tangentraden är kvar', s1.pm === 'touch' && s1.kb === true, s1);
    check('Efter avbrott: vald skärm (2) väljs igen', agent.log.setDisplay.slice(sdN).includes(2), agent.log.setDisplay.slice(sdN));
    await page.eval("rmmKeyboard(false); true");
    await load();
    await connected();
    await sleep(800);
    const s2 = await page.eval('({ z: rmmView.z, cx: rmmView.cx, pm: rmmPrefs.pointer })');
    check('Efter omladdning av fliken: zoom och läge är kvar', near(s2.z, s0.z, 0.01) && near(s2.cx, s0.cx, 0.01) && s2.pm === 'touch', s2);

    // ---------------------------------------------------------------- networks that change
    for (const [name, ev] of [['nätet byts (wifi till mobildata)', "window.dispatchEvent(new Event('online'))"], ['skärmen tänds igen', "document.dispatchEvent(new Event('visibilitychange'))"]]) {
        await connected();
        const t0 = Date.now(), n0 = agent.log.connects.length;
        agent.silence();
        await sleep(300);
        await page.eval(ev + '; true');
        let ms = null;
        while (Date.now() - t0 < 15000) { if (agent.log.connects.length > n0) { ms = Date.now() - t0; break; } await sleep(100); }
        check('Död länk när ' + name + ': ny anslutning inom cirka 3 s (förut 12 s)', ms !== null && ms < 5000, { ms });
        tracker['natbyte-' + ev.slice(16, 22)] = ms;
        await connected(10000);
    }
    await sleep(2500);
    const stepBefore = await page.eval('rmmAutoStep'), connBefore = agent.log.connects.length;
    agent.stall(3000);
    await sleep(9000);
    const stepAfter = await page.eval('rmmAutoStep');
    check('Kort avbrott (3 s utan något, sedan allt på en gång): Auto sänker inte bilden och ingen ny anslutning', stepAfter <= stepBefore && agent.log.connects.length === connBefore, { stepBefore, stepAfter, reconnects: agent.log.connects.length - connBefore });

    if (!ctx.quick) {
        // A phone on a jittery 4G line from the start of the session (40-300 ms, in order, no queue).
        const jitterRun = async (mode) => {
            agent.cfg.latency = 40; agent.cfg.jitter = 260;
            await load();
            await page.eval(`rmmBaseMode = '${mode}'; true`);
            await connected(15000);
            await sleep(3500);
            const start = await page.eval('rmmAutoStep');
            let worst = start;
            const t0 = Date.now(), trace = [];
            while (Date.now() - t0 < 24000) {
                const st = await page.eval('({ step: rmmAutoStep, eff: rmmNet.eff, base: rmmNet.base, dq: rmmNet.decodeQueue, state: rmmNet.state })');
                trace.push(st); worst = Math.max(worst, st.step); await sleep(1000);
            }
            tracker['jitter-trace-' + mode] = trace;
            agent.cfg.latency = 0; agent.cfg.jitter = 0;
            return { start, worst, drop: worst - start };
        };
        const jMin = await jitterRun('min');
        const jP20 = await jitterRun('p20');
        check('Ryckigt mobilnät (40–300 ms, ingen kö): Auto sänker högst ett steg', jP20.drop <= 1, { steg1Regel: jMin, steg2Regel: jP20 });
        tracker.jitter = { step1Rule: jMin, step2Rule: jP20 };
        await load();
        await connected();
    }

    // ---------------------------------------------------------------- landscape phone and tablet: screenshots and checks
    await page.eval('try { sessionStorage.clear(); } catch (ex) { } true');
    await device(844, 390, 3, 'android');
    agent.reset(); agent.display = 1;
    await load();
    await connected();
    await sleep(1200);
    v = await view();
    c = lastComp();
    check('Liggande telefon: mobilvyn, bilden fyller höjden, högst Full HD', (await page.eval('rmmDev.phone')) && near(v.rect.h, 390, 1) && (v.cw * v.ch) <= 1920 * 1080, { rect: v.rect, scaling: c.scaling, canvas: v.cw + 'x' + v.ch, screen: await page.eval('rmmNode.display') });
    await panel(true);
    const side = await page.eval("(function(){ var r = document.getElementById('rmmPanel').getBoundingClientRect(); return { l: r.left, w: r.width, h: r.height }; })()");
    check('Liggande telefon: panelen kommer från höger och täcker inte hela bilden', side.l > 300 && side.h >= 380, side);
    await shot('liggande-panel.png');
    await panel(false);
    await page.eval("rmmSetPointerMode('trackpad'); rmmKeyboard(true); true");
    await sleep(400);
    await shot('liggande-styrplatta-tangentrad.png');
    await page.eval("rmmSetPointerMode('touch'); true");
    await page.tap(420, 150);
    await sleep(420);
    await shot('liggande-peka-tangentrad.png');
    await page.eval("rmmKeyboard(false); true");

    await device(820, 1180, 2, 'ipad');
    await page.eval('try { sessionStorage.clear(); } catch (ex) { } true');
    agent.reset(); agent.display = 1;
    await load();
    await connected();
    await sleep(1200);
    c = lastComp();
    v = await view();
    tracker.tablet = await page.eval('({ dev: rmmDev, step: rmmAutoStep, comps: null })');
    tracker.tablet.comps = agent.log.compression.slice(-4);
    const tcell = await page.eval('rmmDev.cellular');
    check('Surfplatta: mobilvyn, Auto börjar som på datorn (kvalitet 50, 40 på långsamt nät), högst 2560x1600 pixlar', (await page.eval('rmmDev.tablet && !rmmDev.phone')) && c.q === (tcell ? 40 : 50) && (v.cw * v.ch) <= 2560 * 1600, { q: c.q, cellular: tcell, scaling: c.scaling, canvas: v.cw + 'x' + v.ch });
    await panel(true);
    await shot('surfplatta-panel.png');
    await panel(false);
    await page.eval("rmmSetPointerMode('trackpad'); rmmKeyboard(true); true");
    await sleep(400);
    await shot('surfplatta-styrplatta-tangentrad.png');
    await page.eval("rmmSetPointerMode('touch'); true");
    await page.tap(400, 300);
    await sleep(420);
    await shot('surfplatta-peka-tangentrad.png');
    await page.eval("rmmKeyboard(false); true");

    // safe areas (notch and home bar), if this Chrome can emulate them
    await device(390, 844, 3, 'iphone');
    let safeOk = 'saknas i denna Chrome';
    try { await page.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, topMax: 59, left: 0, leftMax: 0, bottom: 34, bottomMax: 34, right: 0, rightMax: 0 } }); safeOk = true; } catch (ex) { safeOk = 'saknas i denna Chrome (' + String(ex.message || ex).slice(0, 80) + ')'; }
    if (safeOk === true) {
        agent.reset();
        await load();
        await connected();
        await sleep(800);
        await page.eval("rmmSetPointerMode('trackpad'); true");
        await page.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true, screenWidth: 844, screenHeight: 390 });
        await page.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, topMax: 0, left: 59, leftMax: 59, bottom: 21, bottomMax: 21, right: 59, rightMax: 59 } });
        await sleep(1200);
        v = await view();
        const hb = await page.eval("(function(){ var r = document.getElementById('rmmHandle').getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, t: r.top }; })()");
        check('Säkra ytor (liggande iPhone, notch 59 px, hemlist 21 px): hela fjärrskärmen ligger innanför', v.rect.l >= 58.5 && (v.rect.l + v.rect.w) <= (844 - 58.5) && (v.rect.t + v.rect.h) <= (390 - 20.5), { rect: v.rect });
        await panel(true);
        const pr2 = await page.eval("(function(){ var p = document.getElementById('rmmPanel'), cs = getComputedStyle(p); return { padR: cs.paddingRight, padB: cs.paddingBottom }; })()");
        check('Säkra ytor: panelen håller avstånd till notch och hemlist', parseFloat(pr2.padR) >= 59 && parseFloat(pr2.padB) >= 21, pr2);
        await shot('liggande-sakra-ytor.png');
        await panel(false);
        await page.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, topMax: 0, left: 0, leftMax: 0, bottom: 0, bottomMax: 0, right: 0, rightMax: 0 } });
    } else {
        check('Säkra ytor: kan inte emuleras i denna Chrome (kontrolleras på riktig iPhone)', true, safeOk);
    }

    // =====================================================================================  direct path (WebRTC)
    await desktopMode();
    check('WebRTC: utan serverns tillstånd skickas inget erbjudande (dagens läge)', ctx.offersBefore === 0, { offers: ctx.offersBefore });
    await page.eval('try { sessionStorage.clear(); } catch (ex) { } true');
    agent.reset(); agent.display = 1; agent.cfg.rtc = 'ok';
    await load({ webrtc: 1 });
    await connected();
    let ok = await page.waitFor("rmmRtc.state == 'direct'", 12000, 'direct').catch(() => false);
    const r1 = await page.eval("({ state: rmmRtc.state, path: document.getElementById('rmmNetPath').textContent, active: desktop.webRtcActive === true })");
    check('WebRTC: erbjudande, svar och byte till direktväg', ok && agent.log.rtc.offers === 1 && agent.log.rtc.answers === 1 && agent.log.rtc.switched === 1 && r1.active, Object.assign({}, r1, agent.log.rtc));
    check('WebRTC: anslutningen visar "Direkt"', r1.path === 'Direkt', r1.path);
    const kv0 = agent.log.rtc.kvmBytesRtc, td0 = await page.eval('rmmStats.drawn || 0');
    await sleep(2500);
    const kv1 = agent.log.rtc.kvmBytesRtc, td1 = await page.eval('rmmStats.drawn || 0');
    check('WebRTC: bilden kommer direkt (inte via servern) och ritas', kv1 > kv0 && td1 > td0, { bytesDirect: kv1 - kv0, tilesDrawn: td1 - td0 });
    agent.clearInput();
    await page.click('.rmm-quick[data-key="esc"]');
    for (let i = 0; (i < 30) && (agent.log.input.length < 2); i++) { await sleep(100); }
    check('WebRTC: tangenter går direkt, inget tappas', agent.log.input.length === 2 && agent.log.input.every((k) => k.path === 'rtc') && agent.log.rtc.wsInputAfterSwitch === 0, { input: agent.log.input, wsAfter: agent.log.rtc.wsInputAfterSwitch });
    await shot('dator-direkt.png');

    await page.eval("window.__ov = false; window.__ovT = setInterval(function () { if (document.getElementById('rmmReconnect').classList.contains('rmm-show') || document.getElementById('Desk').classList.contains('rmm-stale')) { window.__ov = true; } }, 25); true");
    const cn0 = agent.log.connects.length, tLost = Date.now();
    peerPage.eval('peerClose()');
    let back = null;
    while (Date.now() - tLost < 8000) { if ((agent.log.connects.length > cn0) && (await page.eval('(desktop != null) && (desktop.State == 3) && !rmmStale'))) { back = Date.now() - tLost; break; } await sleep(100); }
    const lost = await page.eval("({ ov: window.__ov, state: rmmRtc.state, reason: rmmRtc.reason, path: document.getElementById('rmmNetPath').textContent })");
    check('WebRTC bryts: tyst byte till servern, bilden tillbaka utan "Ansluter igen…"', back !== null && back < 4000 && !lost.ov, Object.assign({ msToPicture: back }, lost));
    await sleep(1500);
    check('WebRTC bryts: nytt försök väntar (2 min), visar "Via servern"', agent.log.rtc.offers === 1 && (await page.eval("document.getElementById('rmmNetPath').textContent")) === 'Via servern', { offers: agent.log.rtc.offers });
    await page.eval('clearInterval(window.__ovT); true');

    for (const mode of ['noanswer', 'icefail']) {
        await page.eval('try { sessionStorage.clear(); } catch (ex) { } true');
        agent.reset(); agent.display = 1; agent.cfg.rtc = mode;
        await load({ webrtc: 1 });
        await connected();
        await page.eval("window.__ov = false; window.__ovT = setInterval(function () { if (document.getElementById('rmmReconnect').classList.contains('rmm-show')) { window.__ov = true; } }, 25); true");
        const t0 = await page.eval('rmmStats.drawn || 0'), n0 = agent.log.connects.length;
        await page.waitFor("rmmRtc.state == 'failed'", 16000, 'failed').catch(() => { });
        await sleep(500);
        const r = await page.eval("({ state: rmmRtc.state, reason: rmmRtc.reason, pcs: (window.__pcs || []).map(p => p.connectionState + '/' + p.signalingState), tiles: rmmStats.drawn || 0, ov: window.__ov, path: document.getElementById('rmmNetPath').textContent, active: desktop.webRtcActive })");
        const allClosed = r.pcs.length >= 1 && r.pcs.every((s) => s.indexOf('closed') >= 0);
        check('WebRTC ' + (mode === 'noanswer' ? 'utan svar' : 'som nätet stoppar') + ': stannar tyst på servern, bilden går hela tiden', r.state === 'failed' && allClosed && r.tiles > t0 && agent.log.connects.length === n0 && !r.ov && r.path === 'Via servern' && !r.active, Object.assign({ offers: agent.log.rtc.offers }, r));
        await page.eval('clearInterval(window.__ovT); true');
    }

    await page.eval('try { sessionStorage.clear(); } catch (ex) { } true');
    agent.reset(); agent.display = 1; agent.cfg.rtc = 'ok';
    await load({ webrtc: 1, expire: Date.now() + 16000 });
    await connected();
    ok = await page.waitFor("rmmRtc.state == 'direct'", 12000, 'direct').catch(() => false);
    await page.waitFor("document.getElementById('rmmReconnectTitle').textContent == 'Tiden för fjärrstyrningen är slut' && document.getElementById('rmmReconnect').classList.contains('rmm-show')", 16000, 'expired').catch(() => { });
    const nE = agent.log.connects.length;
    await sleep(3000);
    let r = await page.eval("({ pcs: (window.__pcs || []).map(p => p.connectionState), desk: desktop == null, rtc: rmmRtc.pc == null, share: shareControl == null })");
    check('WebRTC och utgången länk: direktvägen stängs med sessionen, inga nya försök', ok && r.pcs.length >= 1 && r.pcs.every((s) => s === 'closed') && r.desk && r.rtc && r.share && agent.log.connects.length === nE, Object.assign({ wasDirect: !!ok }, r));

    await page.eval('try { sessionStorage.clear(); } catch (ex) { } true');
    agent.reset(); agent.display = 1; agent.cfg.rtc = 'ok';
    await load({ webrtc: 1 });
    await connected();
    ok = await page.waitFor("rmmRtc.state == 'direct'", 12000, 'direct').catch(() => false);
    agent.revoke();
    await sleep(2500);
    r = await page.eval("({ pcs: (window.__pcs || []).map(p => p.connectionState), rtc: rmmRtc.pc == null, active: !!(desktop && desktop.webRtcActive) })");
    check('WebRTC och borttagen länk: när servern stänger reläet stängs direktvägen också', ok && r.pcs.length >= 1 && r.pcs.every((s) => s === 'closed') && r.rtc && !r.active, Object.assign({ wasDirect: !!ok, refusedAfter: agent.log.refused.length }, r));
    agent.cfg.refuse = false;

    // phone with the direct path: the panel says so
    await device(390, 844, 3, 'android');
    await page.eval('try { sessionStorage.clear(); } catch (ex) { } true');
    agent.reset(); agent.display = 1; agent.cfg.rtc = 'ok';
    await load({ webrtc: 1 });
    await connected();
    ok = await page.waitFor("rmmRtc.state == 'direct'", 12000, 'direct').catch(() => false);
    await sleep(800);
    await page.eval("rmmSetPointerMode('trackpad'); true");
    await panel(true);
    const mp = await page.eval("document.getElementById('rmmMNetPath').textContent");
    check('Telefon med direktväg: panelen visar "Direkt"', ok && mp === 'Direkt', mp);
    await shot('telefon-panel-direkt.png');
    await panel(false);
    agent.cfg.rtc = 'off';

    fs.writeFileSync(path.join(outDir, 'steg2-matvarden.json'), JSON.stringify(tracker, null, 2));
    await desktopMode();
}
