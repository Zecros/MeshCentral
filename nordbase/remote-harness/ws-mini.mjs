// Minimal WebSocket server side (RFC 6455) for the local remote-desktop harness.
// No dependencies: only what the harness needs (text, binary, ping, close, no extensions).
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptWebSocket(req, socket, onOpen) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return null; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    const ws = new MiniSocket(socket);
    onOpen(ws);
    return ws;
}

export function refuseUpgrade(socket, status = 503) {
    try { socket.write('HTTP/1.1 ' + status + ' Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch (ex) { }
    socket.destroy();
}

class MiniSocket {
    constructor(socket) {
        this.socket = socket;
        this.open = true;
        this.onmessage = null; // (data: Buffer|string, isBinary: boolean)
        this.onclose = null;
        this.buffer = Buffer.alloc(0);
        this.fragments = null;
        this.fragmentOpcode = 0;
        socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
        socket.on('close', () => this.closed());
        socket.on('error', () => this.closed());
    }

    closed() {
        if (!this.open) return;
        this.open = false;
        if (this.onclose) this.onclose();
    }

    parse() {
        for (;;) {
            const b = this.buffer;
            if (b.length < 2) return;
            const fin = (b[0] & 0x80) !== 0, opcode = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
            let len = b[1] & 0x7f, off = 2;
            if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
            const maskOff = off;
            if (masked) off += 4;
            if (b.length < off + len) return;
            let payload = Buffer.from(b.subarray(off, off + len));
            if (masked) { const mask = b.subarray(maskOff, maskOff + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
            this.buffer = b.subarray(off + len);
            if (opcode === 8) { this.close(); return; }
            if (opcode === 9) { this.sendFrame(10, payload); continue; }
            if (opcode === 10) continue;
            if (opcode === 0) {
                if (!this.fragments) continue;
                this.fragments.push(payload);
                if (!fin) continue;
                payload = Buffer.concat(this.fragments); this.fragments = null;
                this.deliver(this.fragmentOpcode, payload);
                continue;
            }
            if (!fin) { this.fragments = [payload]; this.fragmentOpcode = opcode; continue; }
            this.deliver(opcode, payload);
        }
    }

    deliver(opcode, payload) {
        if (!this.onmessage) return;
        if (opcode === 1) this.onmessage(payload.toString('utf8'), false);
        else if (opcode === 2) this.onmessage(payload, true);
    }

    sendFrame(opcode, payload) {
        if (!this.open) return;
        const len = payload.length;
        let header;
        if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
        else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
        else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
        try { this.socket.write(Buffer.concat([header, payload])); } catch (ex) { }
    }

    send(data) {
        if (typeof data === 'string') this.sendFrame(1, Buffer.from(data, 'utf8'));
        else this.sendFrame(2, Buffer.isBuffer(data) ? data : Buffer.from(data));
    }

    close() {
        if (!this.open) return;
        this.sendFrame(8, Buffer.alloc(0));
        try { this.socket.end(); } catch (ex) { }
        this.closed();
    }

    // A dropped network: no close frame, the TCP connection just goes away.
    kill() { try { this.socket.destroy(); } catch (ex) { } this.closed(); }
}
