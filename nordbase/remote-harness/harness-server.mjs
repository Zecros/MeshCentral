// Local stand-in for MeshCentral's share page and the device relay. It serves the fork's real
// views/sharing.handlebars and public/ files and plays a synthetic desktop into the page over a fake
// meshrelay.ashx, speaking the MeshAgent KVM tile protocol. Nothing leaves this machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket, refuseUpgrade } from './ws-mini.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const forkRoot = path.resolve(here, '..', '..');
const publicDir = path.join(forkRoot, 'public');

const NATIVE = { 1: { w: 3840, h: 2160 }, 2: { w: 1920, h: 1080 }, 65535: { w: 5760, h: 2160 } };
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.html': 'text/html; charset=utf-8' };
// The same policy MeshCentral sends for its pages (webserver.js, cspBase), so the page cannot rely on anything looser.
const CSP = "default-src 'none'; font-src 'self' data:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; media-src 'self'; form-action 'self'; manifest-src 'self'";

function u16(v) { return [(v >> 8) & 0xff, v & 0xff]; }

export class FakeAgent {
    constructor() {
        this.encoder = null; // async (spec) => [{x, y, b64}]
        this.cfg = { latency: 0, bw: 0, refuse: false, nowebp: false, heavy: false, corruptWebp: 0, displays: [1, 2, 65535] };
        this.display = 1;
        this.sessions = new Set();
        this.reset();
    }

    reset() {
        this.log = { connects: [], refused: [], compression: [], keys: [], setDisplay: [], ctrl: [], sharecontrol: [], sharecontrolConnects: 0, tilesSent: 0, bytesSent: 0, mouse: 0 };
    }

    clearKeys() { this.log.keys = []; }

    handleRelay(req, socket) {
        const url = new URL(req.url, 'http://x');
        if (this.cfg.refuse) { this.log.refused.push(Date.now()); refuseUpgrade(socket); return; }
        if (url.searchParams.get('p') !== '2') { refuseUpgrade(socket, 404); return; } // only the desktop in this harness
        acceptWebSocket(req, socket, (ws) => { this.log.connects.push(Date.now()); new Session(this, ws); });
    }

    handleShareControl(req, socket) {
        acceptWebSocket(req, socket, (ws) => {
            this.log.sharecontrolConnects++;
            ws.onmessage = (data) => { this.log.sharecontrol.push(String(data)); };
            ws.send(JSON.stringify({ action: 'sharecontrol', status: 'ready', clipboard: true }));
        });
    }

    // The network goes away: connections die without a close frame, new ones fail for refuseMs.
    drop(refuseMs) {
        for (const s of this.sessions) s.ws.kill();
        if (refuseMs > 0) { this.cfg.refuse = true; setTimeout(() => { this.cfg.refuse = false; }, refuseMs); }
    }

    // A link that stays "open" but carries nothing (no data, no probe answers).
    silence() { for (const s of this.sessions) s.silent = true; }
}

class Session {
    constructor(agent, ws) {
        this.agent = agent; this.ws = ws;
        this.scaling = 1024; this.type = 1; this.q = 50; this.fr = 100;
        this.frame = 0; this.silent = false; this.queueEnd = 0; this.started = false;
        this.animTimer = null; this.encoding = false; this.timers = new Set();
        agent.sessions.add(this);
        ws.onmessage = (data, bin) => { try { if (bin) this.onBinary(data); else this.onText(data); } catch (ex) { console.error('session error', ex); } };
        ws.onclose = () => this.stop();
        ws.send('c');
    }

    stop() {
        this.agent.sessions.delete(this);
        if (this.animTimer) clearInterval(this.animTimer);
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
    }

    size() { const n = NATIVE[this.agent.display]; return { w: Math.floor(n.w * this.scaling / 1024), h: Math.floor(n.h * this.scaling / 1024) }; }

    // Emulated link: bandwidth (bytes/s, 0 = unlimited) queues data, latency delays it.
    // A string goes out as a text frame (control messages), a Buffer as binary (KVM commands).
    enqueue(buf) {
        if (this.silent || !this.ws.open) return;
        const now = Date.now(), cfg = this.agent.cfg;
        const ser = cfg.bw ? (buf.length * 1000 / cfg.bw) : 0;
        const start = Math.max(now, this.queueEnd);
        this.queueEnd = start + ser;
        const at = this.queueEnd + cfg.latency;
        const t = setTimeout(() => { this.timers.delete(t); if (!this.silent) this.ws.send(buf); }, Math.max(0, at - now));
        this.timers.add(t);
        this.agent.log.bytesSent += buf.length;
    }

    backlogMs() { return Math.max(0, this.queueEnd - Date.now()); }

    onText(text) {
        if (text === '2') { this.started = true; this.sendScreen(); this.sendDisplays(); this.fullFrame(); this.restartAnim(); return; }
        let msg = null;
        try { msg = JSON.parse(text); } catch (ex) { return; }
        this.agent.log.ctrl.push(msg);
        if (msg && (String(msg.ctrlChannel) === '102938') && (msg.type === 'rtt')) {
            this.enqueue(JSON.stringify({ type: 'rtt', ctrlChannel: '102938', time: msg.time })); // text, like the agent
        }
    }

    onBinary(buf) {
        let off = 0;
        while (off + 4 <= buf.length) {
            const cmd = buf.readUInt16BE(off), size = buf.readUInt16BE(off + 2);
            if (size < 4 || off + size > buf.length) break;
            this.onCommand(cmd, buf.subarray(off, off + size));
            off += size;
        }
    }

    onCommand(cmd, b) {
        const log = this.agent.log;
        switch (cmd) {
            case 1: log.keys.push({ t: 'key', flag: b[4], kc: b[5] }); break;
            case 85: log.keys.push({ t: 'uni', flag: b[4], ch: String.fromCharCode(b.readUInt16BE(5)) }); break;
            case 10: log.keys.push({ t: 'cad' }); break;
            case 2: log.mouse++; break;
            case 5: {
                const type = b[4], q = b[5], scaling = b.readUInt16BE(6), fr = b.readUInt16BE(8);
                log.compression.push({ at: Date.now(), type, q, scaling, fr });
                const scaleChanged = (scaling !== this.scaling), picChanged = (type !== this.type) || (q !== this.q);
                this.type = type; this.q = q; this.scaling = scaling; this.fr = fr;
                if (!this.started) break;
                if (scaleChanged) { this.sendScreen(); this.fullFrame(); }
                else if (picChanged) { this.fullFrame(); }
                this.restartAnim();
                break;
            }
            case 6: if (this.started) this.fullFrame(); break;
            case 11: this.sendDisplays(); break;
            case 12: {
                const n = b.readUInt16BE(4);
                log.setDisplay.push(n);
                if (NATIVE[n]) { this.agent.display = n; this.sendScreen(); this.sendDisplays(); this.fullFrame(); }
                break;
            }
            default: break; // pause/unpause (8), touch init (14), input lock (87) ...
        }
    }

    sendScreen() { const s = this.size(); this.enqueue(Buffer.from([0, 7, 0, 8, ...u16(s.w), ...u16(s.h)])); }

    sendDisplays() {
        const list = this.agent.cfg.displays;
        if (list.length < 2) return;
        const bytes = [0, 11, ...u16(4 + 2 + list.length * 2 + 2), ...u16(list.length)];
        for (const d of list) bytes.push(...u16(d));
        bytes.push(...u16(this.agent.display));
        this.enqueue(Buffer.from(bytes));
    }

    sendTile(x, y, data) {
        const total = 8 + data.length;
        let head;
        if (total <= 65535) head = Buffer.from([0, 3, ...u16(total), ...u16(x), ...u16(y)]);
        else head = Buffer.from([0, 27, 0, 8, 0, (total >> 16) & 0xff, (total >> 8) & 0xff, total & 0xff, 0, 3, 0, 0, ...u16(x), ...u16(y)]);
        this.enqueue(Buffer.concat([head, data]));
        this.agent.log.tilesSent++;
    }

    imageType() { return ((this.type === 4) && !this.agent.cfg.nowebp) ? 'image/webp' : 'image/jpeg'; }

    async encode(mode) {
        if (!this.agent.encoder) return [];
        const s = this.size();
        return this.agent.encoder({ display: this.agent.display, w: s.w, h: s.h, frame: this.frame, heavy: this.agent.cfg.heavy, type: this.imageType(), q: this.q, mode });
    }

    async fullFrame() {
        const tiles = await this.encode('full');
        if (!this.ws.open) return;
        for (const t of tiles) this.sendTile(t.x, t.y, Buffer.from(t.b64, 'base64'));
    }

    restartAnim() {
        if (this.animTimer) clearInterval(this.animTimer);
        this.animTimer = setInterval(() => this.animTick(), Math.max(this.fr, 33));
    }

    async animTick() {
        if (this.encoding || !this.ws.open || this.silent) return;
        if (this.backlogMs() > 1500) return; // like TCP back-pressure on a real agent
        this.encoding = true;
        try {
            this.frame++;
            const cfg = this.agent.cfg;
            if ((cfg.corruptWebp > 0) && (this.imageType() === 'image/webp')) {
                cfg.corruptWebp--;
                const junk = Buffer.alloc(200, 0x5a); junk.write('RIFF', 0); junk.writeUInt32LE(192, 4); junk.write('WEBPVP8 ', 8);
                this.sendTile(0, 0, junk);
            } else {
                const tiles = await this.encode('anim');
                for (const t of tiles) this.sendTile(t.x, t.y, Buffer.from(t.b64, 'base64'));
            }
        } finally { this.encoding = false; }
    }
}

export function renderSharing(values) {
    const tpl = fs.readFileSync(path.join(forkRoot, 'views', 'sharing.handlebars'), 'utf8');
    return tpl.replace(/\{\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}\}/g, (m, k) => (values[k] !== undefined ? String(values[k]) : ''));
}

export function startHarnessServer({ port = 0, pageValues = () => ({}) } = {}) {
    const agent = new FakeAgent();
    const encoderHtml = fs.readFileSync(path.join(here, 'encoder.html'));
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/sharing') {
            const addr = server.address();
            const v = Object.assign({
                randomlength: '', serverDnsName: '127.0.0.1', serverPublicPort: addr.port, domain: '', domainurl: '/', authCookie: 'harness-cookie',
                viewOnly: 0, nodeName: encodeURIComponent('TEST-PC (Prov AB)'), remotePlatform: 'windows', expire: Date.now() + 30 * 60000,
                features: 7, features2: 0, features3: 0, min: '',
                customCSSTags: '<link keeplink=1 type="text/css" href="styles/custom.css" media="screen" rel="stylesheet" title="CSS" />',
                customJSTags: '<script keeplink=1 type="text/javascript" src="scripts/custom.js"></script>'
            }, pageValues(url));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
            res.end(renderSharing(v));
            return;
        }
        if (url.pathname === '/__encoder.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(encoderHtml); return; }
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const file = path.resolve(publicDir, rel);
        if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    });
    server.on('upgrade', (req, socket) => {
        const p = new URL(req.url, 'http://x').pathname;
        if (p === '/meshrelay.ashx') agent.handleRelay(req, socket);
        else if (p === '/sharecontrol.ashx') agent.handleShareControl(req, socket);
        else refuseUpgrade(socket, 404);
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, agent, port: server.address().port })));
}
