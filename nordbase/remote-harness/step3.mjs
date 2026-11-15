// Nordbase Remote step 3: what the real Windows agent showed on staging.
//  1. Scaling: the agent repeats its screen size (twice at the start) and late copies of the old size arrive;
//     the page must keep the scaling it asked for. Also: an agent that scales without sending its size, and
//     one that does not scale at all.
//  2. Picture format: JPEG only (checked in run.mjs).
//  3. Ctrl+Alt+Del pressed 50 times across path switches (relay -> switching -> direct -> broken direct path ->
//     quiet switch to the relay -> relay): every press must reach the agent's KVM exactly once.
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';

export async function runStep3(ctx) {
    const { page, agent, check, outDir, load, connected, peerPage } = ctx;
    const trace = {};
    const resetCfg = () => Object.assign(agent.cfg, { dupConnect: false, lateOldSize: '', noscale: false, silentScale: false, ctrlDelay: 0, revertAfter: 0, rtc: 'off', latency: 0, jitter: 0, bw: 0, refuse: false });
    const state = () => page.eval(`({ agentScaling: rmmAgentScaling, pending: rmmPendingScaling, ignored: rmmScale.ignoredUntil > Date.now(), canvas: document.getElementById('Desk').width + 'x' + document.getElementById('Desk').height,
        stale: rmmScale.stale, log: rmmScale.log.slice(-12), info: rmmInfoText() })`);
    const asked = () => agent.log.compression.map((c) => c.scaling);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.eval('try { localStorage.clear(); sessionStorage.clear(); } catch (ex) { } true');

    // ------------------------------------------------------------------ 1. scaling
    async function scalingRun(name, cfg, waitMs) {
        resetCfg(); Object.assign(agent.cfg, cfg);
        agent.reset(); agent.display = 1;
        await load();
        // Watch the picture size every 50 ms: once the smaller picture is there it must never jump back.
        await page.eval("window.__sizes = []; window.__sizeT = setInterval(function () { var c = document.getElementById('Desk'), v = c.width + 'x' + c.height; if (window.__sizes[window.__sizes.length - 1] !== v) { window.__sizes.push(v); } }, 50); true");
        await connected(15000);
        await sleep(waitMs);
        const seen = await page.eval('clearInterval(window.__sizeT); window.__sizes');
        trace[name + '-bildstorlekar'] = seen;
        const st = await state();
        trace[name] = { cfg, sizesFromAgent: agent.log.sizes || [], scalingsAsked: asked(), page: st, agentSessionScaling: [...agent.sessions].map((s) => s.scaling) };
        return st;
    }

    // Exactly the staging sequence: old size, request, the old size again (duplicate), the new size, and a late copy of the old size.
    let st = await scalingRun('staging-foljden', { dupConnect: true, lateOldSize: 'both' }, 7000);
    let a = trace['staging-foljden'].scalingsAsked, first = a.indexOf(384);
    check('Skalning, staging-följden (gammal storlek, fråga, gammal igen, ny, sen kopia av gammal): sidan behåller 37,5 %',
        st.agentScaling === 384 && st.canvas === '1440x810' && st.pending === null && !st.ignored && first >= 0 && a.slice(first).every((x) => x === 384),
        { canvas: st.canvas, agentScaling: st.agentScaling, asked: a, sizes: trace['staging-foljden'].sizesFromAgent, log: st.log });
    const seenSizes = trace['staging-foljden-bildstorlekar'], firstSmall = seenSizes.indexOf('1440x810');
    check('Skalning: dubbletten och den sena kopian avgör inget, bilden hoppar aldrig tillbaka till 100 %', st.stale >= 2 && firstSmall >= 0 && seenSizes.slice(firstSmall).every((x) => x === '1440x810') && !(await page.eval("rmmScale.log.join(' ')")).includes('was real'), { stale: st.stale, pictureSizes: seenSizes });

    // A late copy after every change, also when the window changes size afterwards.
    st = await scalingRun('sen-kopia-och-nytt-fonster', { lateOldSize: 'after' }, 4000);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await sleep(5000);
    st = await state();
    a = asked();
    trace['sen-kopia-och-nytt-fonster'].after = { page: st, asked: a, sizes: agent.log.sizes };
    check('Skalning: sen kopia efter varje byte, och sedan större fönster: 50 % hålls', st.agentScaling === 512 && st.canvas === '1920x1080' && !st.ignored && a[a.length - 1] === 512, { canvas: st.canvas, asked: a, log: st.log });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    // Back and forth quickly with late copies on: 37,5 % -> 25 % (Snabb) -> 37,5 % (Auto) within 5 s. The answer to
    // the last request equals the size before the previous change and must still count.
    st = await scalingRun('fram-och-tillbaka', { lateOldSize: 'after' }, 3000);
    await page.click('#rmmQuality [data-q="fast"]');
    await sleep(1200);
    await page.click('#rmmQuality [data-q="auto"]');
    await sleep(2500);
    await page.click('#rmmFit [data-fit="0"]');
    await sleep(2500);
    const s100 = await state();
    await page.click('#rmmFit [data-fit="1"]');
    await sleep(2500);
    st = await state();
    trace['fram-och-tillbaka'].after = { asked: asked(), sizes: agent.log.sizes, s100, page: st };
    check('Skalning fram och tillbaka (37,5 → 25 → 37,5 → 100 → 37,5 % på några sekunder, sena kopior på): varje svar räknas', s100.canvas === '3840x2160' && s100.agentScaling === 1024 && st.canvas === '1440x810' && st.agentScaling === 384 && st.pending === null, { at100: s100.canvas, end: st.canvas, asked: asked(), log: st.log });

    // The agent really goes back to 100 % shortly after (a desktop switch): the "late copy" was real; the tiles show it.
    st = await scalingRun('agenten-gar-tillbaka', { revertAfter: 300 }, 7000);
    check('Agenten går själv tillbaka till 100 %: sidan ser det på bildrutorna och ber om 37,5 % igen', st.agentScaling === 384 && st.canvas === '1440x810' && (await page.eval("rmmScale.log.join(' ')")).includes('was real'), { canvas: st.canvas, sizes: agent.log.sizes, pictureSizes: trace['agenten-gar-tillbaka-bildstorlekar'], log: st.log });

    // The agent scales but its size message never comes: the tiles show the new size.
    st = await scalingRun('skalar-utan-storlek', { silentScale: true }, 11000);
    check('Skalning utan storleksbesked: sidan ser på bildrutorna att datorn skalade (1440x810)', st.agentScaling === 384 && st.canvas === '1440x810' && !st.ignored, { canvas: st.canvas, log: st.log });

    // The agent does not scale at all: ask once more, then stop asking for a minute (not forever).
    st = await scalingRun('skalar-inte', { noscale: true }, 10500);
    a = asked();
    check('Agent som inte skalar: frågar en gång till, sedan 100 % och nytt försök om en minut', st.ignored && st.canvas === '3840x2160' && a.filter((x) => x === 384).length <= 3 && /skalar inte/.test(st.info), { canvas: st.canvas, asked: a, info: st.info, log: st.log });

    // ------------------------------------------------------------------ 3. Ctrl+Alt+Del 50 times across path switches
    resetCfg();
    await page.eval('try { sessionStorage.clear(); } catch (ex) { } true');
    agent.reset(); agent.display = 1;
    agent.cfg.rtc = 'ok'; agent.cfg.ctrlDelay = 400; // a wide switch window, like a slow relay
    await load({ webrtc: 1 });
    await connected(15000);
    const cad0 = agent.cadTotal, presses = [];
    async function press(phase) {
        const s = await page.eval("({ enabled: !document.querySelector('.rmm-quick[data-key=\"10\"]').disabled, rtc: rmmRtc.state, switching: rmmRtc.switching, connected: (desktop != null) && (desktop.State == 3) })");
        if (s.enabled) { await page.click('.rmm-quick[data-key="10"]'); }
        presses.push(Object.assign({ phase }, s));
    }
    for (let i = 0; i < 30; i++) { await press('start: relä, byte, direkt'); await sleep(120); }
    await page.waitFor("rmmRtc.state == 'direct'", 12000, 'direct').catch(() => { });
    for (let i = 0; i < 5; i++) { await press('direkt'); await sleep(200); }
    for (let i = 0; i < 10; i++) {
        await press('direktvägen bryts, tyst byte till servern');
        if (i === 2) { await sleep(80); await peerPage.eval('peerClose()'); }
        await sleep(150);
    }
    await connected(12000);
    for (let i = 0; i < 5; i++) { await press('via servern'); await sleep(200); }
    await sleep(3000);
    const got = agent.cadTotal - cad0, enabled = presses.filter((p) => p.enabled).length;
    const st3 = await page.eval('({ rtc: rmmRtc.state, reason: rmmRtc.reason, stats: rmmStats })');
    const byPhase = {};
    for (const p of presses) { const k = p.phase + (p.switching ? ' (under bytet)' : '') + (!p.connected ? ' (under tyst byte)' : ''); byPhase[k] = (byPhase[k] || 0) + 1; }
    trace.ctrlAltDel = { presses: presses.length, enabled, reachedKvm: got, byPhase, rtc: agent.log.rtc, page: st3 };
    check('Ctrl+Alt+Del 50 gånger över vägbyten: alla 50 når datorn, ingen två gånger', presses.length === 50 && enabled === 50 && got === 50, { presses: presses.length, enabled, reachedKvm: got, byPhase });
    check('Ctrl+Alt+Del: tryck under själva bytet och under det tysta bytet till servern ingår', presses.some((p) => p.switching) && presses.some((p) => !p.connected), byPhase);
    check('Ingen indata på fel väg (relä efter bytet, direktväg före bytet)', agent.log.rtc.wsInputAfterSwitch === 0 && agent.log.rtc.rtcInputBeforeSwitch === 0, agent.log.rtc);
    check('På direktvägen bekräftas Ctrl+Alt+Del av agentens svar (eko)', (st3.stats.echoOk || 0) >= 5, { echoOk: st3.stats.echoOk, echoMissed: st3.stats.echoMissed, kept: st3.stats.specialKept, resent: st3.stats.specialResent, queuedAtSwitch: st3.stats.queuedAtSwitch });

    // A special key on a direct path whose answers stop (the channel looks open but nothing comes back):
    // after 2 s the page switches quietly to the relay and sends the key again there, exactly once.
    resetCfg();
    await page.eval('try { sessionStorage.clear(); } catch (ex) { } true');
    agent.reset(); agent.display = 1; agent.cfg.rtc = 'ok';
    await load({ webrtc: 1 });
    await connected(15000);
    await page.waitFor("rmmRtc.state == 'direct' && rmmRtc.echo === true", 12000, 'direct with echo').catch(() => { });
    const cad1 = agent.cadTotal;
    const realSend = agent.peer.send;
    agent.peer.send = () => { };           // the agent's direct path stops answering (input still arrives)
    await page.click('.rmm-quick[data-key="10"]');
    await sleep(6000);
    agent.peer.send = realSend;
    const st4 = await page.eval('({ rtc: rmmRtc.state, reason: rmmRtc.reason, connected: (desktop != null) && (desktop.State == 3), stats: rmmStats })');
    trace.echoMissing = { reachedKvm: agent.cadTotal - cad1, page: st4 };
    check('Utan svar på direktvägen: tyst byte till servern och Ctrl+Alt+Del skickas där (kan nå datorn två gånger, se rapporten)', st4.connected && st4.reason === 'no-echo' && (agent.cadTotal - cad1) >= 1 && (agent.cadTotal - cad1) <= 2, { reachedKvm: agent.cadTotal - cad1, reason: st4.reason, resent: st4.stats.specialResent });

    resetCfg();
    fs.writeFileSync(path.join(outDir, 'steg3-matvarden.json'), JSON.stringify(trace, null, 2));
}
