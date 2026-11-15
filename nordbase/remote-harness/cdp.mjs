// Tiny Chrome DevTools Protocol client over Node's built-in WebSocket (Node 22+). No dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);

export async function launchChrome(userDataDir) {
    const bin = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
    if (!bin) throw new Error('No Chrome/Edge found. Set CHROME_PATH.');
    const proc = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + userDataDir, '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio', '--hide-scrollbars', '--window-size=1280,800', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
        let buf = '';
        const t = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
        proc.stderr.on('data', (d) => { buf += d.toString(); const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
        proc.on('exit', (c) => reject(new Error('Chrome exited ' + c)));
    });
    return { proc, wsUrl, bin };
}

export class CDP {
    static async connect(url) {
        const c = new CDP();
        c.ws = new WebSocket(url);
        c.id = 0; c.pending = new Map(); c.listeners = [];
        c.ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && c.pending.has(msg.id)) {
                const p = c.pending.get(msg.id); c.pending.delete(msg.id);
                if (msg.error) p.reject(new Error(p.method + ': ' + msg.error.message)); else p.resolve(msg.result);
            } else if (msg.method) {
                for (const l of c.listeners) l(msg);
            }
        };
        await new Promise((resolve, reject) => { c.ws.onopen = resolve; c.ws.onerror = reject; });
        return c;
    }

    send(method, params = {}, sessionId) {
        const id = ++this.id;
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.ws.send(JSON.stringify(msg)); });
    }

    on(fn) { this.listeners.push(fn); }

    async newPage(url = 'about:blank') {
        const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
        const page = new Page(this, sessionId, targetId);
        await page.send('Page.enable');
        await page.send('Runtime.enable');
        if (url !== 'about:blank') await page.goto(url);
        return page;
    }

    close() { try { this.ws.close(); } catch (ex) { } }
}

export class Page {
    constructor(cdp, sessionId, targetId) {
        this.cdp = cdp; this.sessionId = sessionId; this.targetId = targetId; this.console = []; this.errors = [];
        cdp.on((msg) => {
            if (msg.sessionId !== sessionId) return;
            if (msg.method === 'Runtime.consoleAPICalled') this.console.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
            if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
        });
    }

    send(method, params) { return this.cdp.send(method, params, this.sessionId); }

    async goto(url) {
        const loaded = new Promise((resolve) => {
            const fn = (msg) => { if (msg.sessionId === this.sessionId && msg.method === 'Page.loadEventFired') resolve(); };
            this.cdp.on(fn);
        });
        await this.send('Page.navigate', { url });
        await loaded;
    }

    async eval(expr) {
        const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + '\n' + expr.slice(0, 200));
        return r.result.value;
    }

    async waitFor(expr, timeoutMs = 10000, label = expr) {
        const end = Date.now() + timeoutMs;
        for (;;) {
            let v = null;
            try { v = await this.eval(expr); } catch (ex) { v = null; }
            if (v) return v;
            if (Date.now() > end) throw new Error('timeout waiting for: ' + label);
            await sleep(100);
        }
    }

    async screenshot(file) {
        const r = await this.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    }

    async click(selector) {
        const box = await this.eval(`(function(){ var e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; var r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
        if (!box || !box.w) throw new Error('not clickable: ' + selector);
        for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }

    async key(type, k) {
        // k: { key, code, vk, mods, text }
        const p = { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk || 0, nativeVirtualKeyCode: k.vk || 0, modifiers: k.mods || 0 };
        if (type === 'keyDown' && k.text) { p.text = k.text; p.unmodifiedText = k.text; }
        await this.send('Input.dispatchKeyEvent', p);
    }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
