/**
 * Nordbase Control: staged agent updates, test computer first.
 *
 * NORDBASE PATCH: keep this file on every MeshCentral upgrade. All logic is here; upstream files only call it:
 *   meshagent.js  MeshCommand_AgentHash (cmdid 12): gate(), action 'agentupdate': allowManual(), obj.close(): disconnected(),
 *                 ws 'message': obj.nordbaseLastInAt (a link whose answers stopped counts as gone)
 *   meshuser.js   processWebSocketData, action 'nordbaseAgentRollout' (full site administrators only): command()
 * Search for "Nordbase: staged agent updates" to find the five hooks. When this file is missing (not mounted),
 * meshagent.js sends no agent binary update at all (fail closed).
 *
 * The rule:
 *  - A computer on the test list (testNodes) gets a new agent binary as soon as the server has one (upstream behaviour).
 *  - Every other computer gets it only when an operator has released exactly that binary for its architecture
 *    (released[arch] = the server's agent hash). Release is allowed only when a test computer of that architecture
 *    is connected with that binary and has been connected, without a break, for at least minOnlineMinutes.
 *  - The rollout stops by itself (stop is latched, released is cleared, nobody gets an update) when:
 *      a test computer got an update and did not come back with it within returnMinutes ("no-return"),
 *      a test computer was sent the same update MAX_ATTEMPTS times ("update-failed"),
 *      within watchHours after a release a test computer is gone for more than returnMinutes ("offline-after-release").
 *    Only an operator clears a stop (op "resume"); a resume releases nothing.
 *  - A new server binary (MeshCentral upgrade, a file in meshcentral-data/agents) has another hash, so it is not
 *    released: it goes to the test computers again first.
 *
 * State lives in meshcentral-data/nordbase-agent-rollout.json (0600). A missing or unreadable file means: no test
 * computers, nothing released, so no computer gets an agent update.
 */
'use strict';

const FILE_NAME = 'nordbase-agent-rollout.json';
const DEFAULTS = { minOnlineMinutes: 30, returnMinutes: 20, watchHours: 24 };
const LIMITS = { minOnlineMinutes: [5, 1440], returnMinutes: [5, 240], watchHours: [1, 168] };
const MAX_TEST_NODES = 4;
const MAX_ATTEMPTS = 3;
const MAX_LOG = 30;
const NODE_KEY = /^node\/[^/]{0,64}\/[A-Za-z0-9@$]{16,128}$/;
const HASH_HEX = /^[0-9a-f]{96}$/;
const ACTION = 'nordbaseAgentRollout';

function clamp(value, limits, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(limits[1], Math.max(limits[0], Math.round(n)));
}

function normalize(raw) {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const settings = (s.settings && typeof s.settings === 'object') ? s.settings : {};
    const state = {
        v: 1,
        testNodes: Array.isArray(s.testNodes) ? s.testNodes.filter(function (k) { return typeof k === 'string' && NODE_KEY.test(k); }).slice(0, MAX_TEST_NODES) : [],
        settings: {
            minOnlineMinutes: clamp(settings.minOnlineMinutes, LIMITS.minOnlineMinutes, DEFAULTS.minOnlineMinutes),
            returnMinutes: clamp(settings.returnMinutes, LIMITS.returnMinutes, DEFAULTS.returnMinutes),
            watchHours: clamp(settings.watchHours, LIMITS.watchHours, DEFAULTS.watchHours)
        },
        released: {},
        releasedAt: (typeof s.releasedAt === 'number') ? s.releasedAt : null,
        releasedBy: (typeof s.releasedBy === 'string') ? s.releasedBy : null,
        stop: (s.stop && typeof s.stop === 'object' && typeof s.stop.reason === 'string') ? s.stop : null,
        test: {},
        log: Array.isArray(s.log) ? s.log.slice(-MAX_LOG) : []
    };
    if (s.released && typeof s.released === 'object') {
        for (const arch in s.released) { if (/^\d{1,5}$/.test(arch) && HASH_HEX.test(String(s.released[arch]))) { state.released[arch] = String(s.released[arch]); } }
    }
    if (s.test && typeof s.test === 'object') {
        for (const key of state.testNodes) { if (s.test[key] && typeof s.test[key] === 'object') { state.test[key] = Object.assign({}, s.test[key]); } }
    }
    if (Object.keys(state.released).length === 0) { state.releasedAt = null; }
    return state;
}

/**
 * io: { load() -> string|null, save(text), now() -> ms, connected(nodeKey) -> bool,
 *       serverHashes() -> { [arch]: hashhex }, noAgentUpdate() -> bool,
 *       askHash(filter(nodeKey, arch) -> bool) -> count }  askHash makes connected agents send MeshCommand_AgentHash
 *       again, so a release (or a resume) reaches them without waiting for their next connection.
 */
function createAgentRollout(io) {
    let state;
    try { state = normalize(JSON.parse(io.load() || '{}')); } catch (ex) { state = normalize({}); }
    const bootAt = io.now();
    const held = {};      // arch -> { count, lastAt, serverHash }: other computers that wait for a release (since start)
    const passed = {};    // arch -> count: other computers that got a released update (since start)
    let connSeq = 0;

    function save() { try { io.save(JSON.stringify(state, null, 1)); } catch (ex) { } }
    function minutes(ms) { return ms * 60000; }
    function log(now, what, extra) {
        state.log.push(Object.assign({ at: now, what: what }, extra || {}));
        if (state.log.length > MAX_LOG) { state.log = state.log.slice(-MAX_LOG); }
    }

    function latchStop(now, reason, nodeKey, by) {
        if (state.stop) return;
        const t = (nodeKey && state.test[nodeKey]) || {};
        state.stop = { at: now, reason: reason, nodeKey: nodeKey || null, name: t.name || null, by: by || null, revoked: state.released };
        state.released = {};
        state.releasedAt = null;
        log(now, 'stop', { reason: reason, nodeKey: nodeKey || null });
        save();
    }

    // Latches a stop when a test computer did not come back (see the rule at the top). Called before every decision.
    function evaluate(now) {
        if (state.stop) return;
        const ret = minutes(state.settings.returnMinutes);
        for (const key of state.testNodes) {
            const t = state.test[key];
            if (!t) continue;
            if (t.pendingHash && (typeof t.pendingSince === 'number') && (now - t.pendingSince > ret)) { latchStop(now, 'no-return', key); return; }
        }
        if ((state.releasedAt != null) && (now - state.releasedAt < state.settings.watchHours * 3600000)) {
            for (const key of state.testNodes) {
                const t = state.test[key];
                if (!t || !state.released[t.arch] || io.connected(key)) continue;
                const lastIn = (typeof io.lastInAt === 'function') ? io.lastInAt(key) : null;
                const goneSince = (typeof t.disconnectedAt === 'number') ? t.disconnectedAt : Math.max(bootAt, state.releasedAt, (typeof lastIn === 'number') ? lastIn : 0);
                if (now - goneSince > ret) { latchStop(now, 'offline-after-release', key); return; }
            }
        }
    }

    // Arches a test computer has proven: connected now, on the server's current binary, for minOnlineMinutes.
    function proofs(now) {
        const hashes = io.serverHashes();
        const min = minutes(state.settings.minOnlineMinutes);
        const out = {};
        for (const key of state.testNodes) {
            const t = state.test[key];
            if (!t || !t.upToDate || !t.arch || !io.connected(key) || (typeof t.connectedAt !== 'number')) continue;
            const serverHash = hashes[t.arch];
            if (!serverHash || t.serverHash !== serverHash) continue;
            const readyAt = t.connectedAt + min;
            const proof = { arch: t.arch, serverHash: serverHash, nodeKey: key, name: t.name || null, onlineSince: t.connectedAt, readyAt: readyAt, ready: now >= readyAt, released: state.released[t.arch] === serverHash };
            if (!out[t.arch] || (proof.ready && !out[t.arch].ready) || (proof.readyAt < out[t.arch].readyAt)) { out[t.arch] = proof; }
        }
        return out;
    }

    function status(now) {
        if (now == null) { now = io.now(); }
        evaluate(now);
        const hashes = io.serverHashes();
        const proven = proofs(now);
        const tests = state.testNodes.map(function (key) {
            const t = state.test[key] || {};
            const connected = io.connected(key);
            return {
                nodeKey: key, name: t.name || null, connected: connected, arch: t.arch || null,
                upToDate: (t.upToDate === true) && !!t.arch && (t.serverHash === hashes[t.arch]),
                agentHash: t.hash || null, serverHash: t.arch ? (hashes[t.arch] || null) : null,
                onlineSince: (connected && (typeof t.connectedAt === 'number')) ? t.connectedAt : null,
                disconnectedAt: connected ? null : ((typeof t.disconnectedAt === 'number') ? t.disconnectedAt : null),
                pendingSince: t.pendingHash ? t.pendingSince : null, attempts: t.pendingHash ? (t.attempts || 0) : 0,
                updatedAt: (typeof t.updatedAt === 'number') ? t.updatedAt : null, seen: (typeof t.connectedAt === 'number'), noHash: t.noHash === true
            };
        });
        const proofList = Object.keys(proven).map(function (a) { return proven[a]; });
        const releasable = proofList.filter(function (p) { return p.ready && !p.released; });
        const testing = proofList.filter(function (p) { return !p.ready && !p.released; });
        const watching = (state.releasedAt != null) && (now - state.releasedAt < state.settings.watchHours * 3600000);
        let phase = 'idle';
        if (io.noAgentUpdate()) phase = 'off';
        else if (state.stop) phase = 'stopped';
        else if (state.testNodes.length === 0) phase = 'no-test-computer';
        else if (tests.some(function (t) { return t.pendingSince != null; })) phase = 'updating-test';
        else if (releasable.length > 0) phase = 'ready';
        else if (testing.length > 0) phase = 'testing';
        else if (watching) phase = 'released';
        const heldList = {};
        for (const a in held) { heldList[a] = { count: held[a].count, lastAt: held[a].lastAt, released: state.released[a] === held[a].serverHash }; }
        return {
            phase: phase, now: now, settings: Object.assign({}, state.settings), noAgentUpdate: io.noAgentUpdate(),
            testNodes: tests, serverHashes: hashes, released: Object.assign({}, state.released), releasedAt: state.releasedAt, releasedBy: state.releasedBy,
            watchUntil: watching ? state.releasedAt + state.settings.watchHours * 3600000 : null,
            stop: state.stop ? Object.assign({}, state.stop) : null, proofs: proofList, releasable: releasable, held: heldList, passed: Object.assign({}, passed),
            log: state.log.slice(-10)
        };
    }

    /**
     * MeshCommand_AgentHash. info: { nodeKey, name, arch, agentHash (hex), serverHash (hex), method } where method is
     * upstream's compareAgentBinaryHash() (0 = up to date). Returns the method to use, 0 = send no update.
     */
    function gate(info, connection) {
        const now = io.now();
        evaluate(now);
        const method = (typeof info.method === 'number') ? info.method : 0;
        const arch = String(info.arch);
        if (state.testNodes.indexOf(info.nodeKey) >= 0) {
            const t = Object.assign({}, state.test[info.nodeKey] || {});
            t.arch = arch; t.name = info.name || t.name || null; t.hash = info.agentHash || null; t.serverHash = info.serverHash || null;
            // An all-zero hash means the agent has self-update off (console mode, disableUpdate): it never runs a new
            // binary, so it can never prove one. Upstream sends such an agent no update either (method 0).
            t.noHash = /^0*$/.test(String(info.agentHash || ''));
            t.upToDate = (method === 0) && !t.noHash;
            // A second MeshCommand_AgentHash on the same connection (askHash) keeps the time it connected.
            const sameConnection = (connection != null) && (connection.nordbaseRolloutConn != null) && (connection.nordbaseRolloutConn === t.connId);
            if (!sameConnection) { t.connectedAt = now; t.disconnectedAt = null; t.connId = ++connSeq; }
            if (connection != null) { connection.nordbaseRolloutConn = t.connId; }
            let result = method;
            if (method === 0) {
                if (t.pendingHash && !t.noHash) {
                    if (t.pendingHash === info.serverHash) { t.updatedAt = now; log(now, 'test-back', { nodeKey: info.nodeKey, arch: arch }); }
                    delete t.pendingHash; delete t.pendingSince; delete t.attempts;
                }
            } else if (state.stop) {
                result = 0;
            } else {
                if (t.pendingHash === info.serverHash) {
                    t.attempts = (t.attempts || 0) + 1;
                } else {
                    t.pendingHash = info.serverHash; t.pendingSince = now; t.attempts = 1;
                }
                if (t.attempts > MAX_ATTEMPTS) { result = 0; } else { log(now, 'test-update', { nodeKey: info.nodeKey, arch: arch, attempt: t.attempts }); }
            }
            state.test[info.nodeKey] = t;
            if (t.attempts > MAX_ATTEMPTS) { latchStop(now, 'update-failed', info.nodeKey); }
            save();
            return result;
        }
        if (method === 0) return 0;
        if (!state.stop && HASH_HEX.test(String(info.serverHash)) && (state.released[arch] === info.serverHash)) {
            passed[arch] = (passed[arch] || 0) + 1;
            return method;
        }
        held[arch] = { count: ((held[arch] && held[arch].serverHash === info.serverHash) ? held[arch].count : 0) + 1, lastAt: now, serverHash: info.serverHash };
        return 0;
    }

    // An update asked for by hand (MeshCentral "Update agents" or the agent console): test computers, or a released binary.
    function allowManual(info) {
        const now = io.now();
        evaluate(now);
        if (state.stop) return false;
        if (state.testNodes.indexOf(info.nodeKey) >= 0) { log(now, 'manual-update', { nodeKey: info.nodeKey }); save(); return true; }
        return HASH_HEX.test(String(info.serverHash)) && (state.released[String(info.arch)] === info.serverHash);
    }

    // obj.close() of the agent connection that is the current one for this node (meshagent.js checks that).
    function disconnected(nodeKey, connection) {
        const t = state.test[nodeKey];
        if (!t || (connection == null) || (connection.nordbaseRolloutConn !== t.connId)) return;
        t.disconnectedAt = io.now();
        save();
    }

    function ask(filter) { try { return (typeof io.askHash === 'function') ? io.askHash(filter) : 0; } catch (ex) { return 0; } }
    function isTest(key) { return state.testNodes.indexOf(key) >= 0; }

    function reply(command, ok, error, extra) {
        return Object.assign({ action: ACTION, responseid: command.responseid, ok: ok, error: error || null, status: status(io.now()) }, extra || {});
    }

    // The control websocket command (meshuser.js). command.op: status | settestnodes | release | stop | resume | settings
    function command(command, by) {
        const now = io.now();
        const op = String(command.op || 'status');
        if (op === 'status') return reply(command, true);
        if (op === 'settestnodes') {
            const list = Array.isArray(command.nodeKeys) ? command.nodeKeys : null;
            if (!list || list.length > MAX_TEST_NODES || !list.every(function (k) { return typeof k === 'string' && NODE_KEY.test(k); })) return reply(command, false, 'invalid-test-nodes');
            const next = list.filter(function (k, i) { return list.indexOf(k) === i; });
            if (next.join(',') !== state.testNodes.join(',')) {
                state.testNodes = next;
                const kept = {};
                for (const key of next) { if (state.test[key]) kept[key] = state.test[key]; }
                state.test = kept;
                log(now, 'test-nodes', { count: next.length, by: by || null });
                save();
                return reply(command, true, null, { asked: ask(function (key) { return isTest(key); }) });
            }
            return reply(command, true);
        }
        if (op === 'settings') {
            const s = (command.settings && typeof command.settings === 'object') ? command.settings : {};
            state.settings = {
                minOnlineMinutes: clamp(s.minOnlineMinutes != null ? s.minOnlineMinutes : state.settings.minOnlineMinutes, LIMITS.minOnlineMinutes, DEFAULTS.minOnlineMinutes),
                returnMinutes: clamp(s.returnMinutes != null ? s.returnMinutes : state.settings.returnMinutes, LIMITS.returnMinutes, DEFAULTS.returnMinutes),
                watchHours: clamp(s.watchHours != null ? s.watchHours : state.settings.watchHours, LIMITS.watchHours, DEFAULTS.watchHours)
            };
            log(now, 'settings', Object.assign({ by: by || null }, state.settings));
            save();
            return reply(command, true);
        }
        if (op === 'release') {
            evaluate(now);
            if (state.stop) return reply(command, false, 'stopped');
            const proven = proofs(now);
            const ready = Object.keys(proven).map(function (a) { return proven[a]; }).filter(function (p) { return p.ready && !p.released; });
            let wanted = ready;
            if (command.arch != null) {
                wanted = ready.filter(function (p) { return p.arch === String(command.arch); });
                if (wanted.length === 0) return reply(command, false, 'not-ready');
            }
            if (wanted.length === 0) return reply(command, false, 'not-ready');
            for (const p of wanted) { state.released[p.arch] = p.serverHash; }
            state.releasedAt = now;
            state.releasedBy = by || null;
            const arches = wanted.map(function (p) { return p.arch; });
            log(now, 'release', { arches: arches, by: by || null });
            save();
            // Connected computers of these arches check their agent now (each update still goes through the task limiter).
            const asked = ask(function (key, arch) { return !isTest(key) && (arches.indexOf(String(arch)) >= 0); });
            return reply(command, true, null, { releasedArches: arches, asked: asked });
        }
        if (op === 'stop') {
            if (state.stop) return reply(command, true);
            latchStop(now, 'manual', null, by);
            return reply(command, true);
        }
        if (op === 'resume') {
            if (state.stop) {
                state.stop = null;
                for (const key in state.test) { delete state.test[key].pendingHash; delete state.test[key].pendingSince; delete state.test[key].attempts; }
                log(now, 'resume', { by: by || null });
                save();
                return reply(command, true, null, { asked: ask(function (key) { return isTest(key); }) });
            }
            return reply(command, true);
        }
        return reply(command, false, 'unknown-op');
    }

    return { gate: gate, allowManual: allowManual, disconnected: disconnected, status: status, command: command };
}

// One instance per MeshCentral server object (meshcentral.js `obj`), created on first use.
function get(server) {
    if (server.nordbaseAgentRollout != null) return server.nordbaseAgentRollout;
    const fs = require('fs');
    const path = require('path');
    const file = path.join(server.datapath, FILE_NAME);
    server.nordbaseAgentRollout = createAgentRollout({
        load: function () { try { return fs.readFileSync(file, 'utf8'); } catch (ex) { return null; } },
        save: function (text) { const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); },
        now: function () { return Date.now(); },
        // Upstream pings an agent every agentPing seconds but never closes a link whose answers stopped (a dead TCP link
        // stayed "connected" for more than 15 minutes on staging, 28/11). Nothing received for 3 pings counts as gone.
        connected: function (nodeKey) {
            const agent = (server.webserver != null) && (server.webserver.wsagents != null) ? server.webserver.wsagents[nodeKey] : null;
            if (agent == null) return false;
            const ping = (server.args != null) && (typeof server.args.agentping == 'number') ? server.args.agentping : 0;
            if ((ping <= 0) || (typeof agent.nordbaseLastInAt != 'number')) return true;
            return (Date.now() - agent.nordbaseLastInAt) < (3 * ping * 1000 + 15000);
        },
        lastInAt: function (nodeKey) {
            const agent = (server.webserver != null) && (server.webserver.wsagents != null) ? server.webserver.wsagents[nodeKey] : null;
            return ((agent != null) && (typeof agent.nordbaseLastInAt == 'number')) ? agent.nordbaseLastInAt : null;
        },
        serverHashes: function () {
            const out = {};
            const binaries = server.meshAgentBinaries || {};
            for (const id in binaries) { if (binaries[id] && (typeof binaries[id].hashhex === 'string')) { out[id] = binaries[id].hashhex; } }
            return out;
        },
        noAgentUpdate: function () { return (server.args != null) && ((server.args.noagentupdate == 1) || (server.args.noagentupdate === true)); },
        askHash: function (filter) {
            const agents = ((server.webserver != null) && server.webserver.wsagents) || {};
            let count = 0;
            for (const key in agents) {
                const agent = agents[key];
                if ((agent == null) || (agent.authenticated != 2) || (agent.agentExeInfo == null) || !filter(key, String(agent.agentExeInfo.id))) continue;
                try { agent.sendBinary(String.fromCharCode(0, 12, 0, 0)); count++; } catch (ex) { } // MeshCommand_AgentHash: please send your agent hash
            }
            return count;
        }
    });
    return server.nordbaseAgentRollout;
}

module.exports = { createAgentRollout: createAgentRollout, get: get, normalize: normalize, FILE_NAME: FILE_NAME, DEFAULTS: DEFAULTS, MAX_ATTEMPTS: MAX_ATTEMPTS };
