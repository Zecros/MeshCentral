# Nordbase Remote: local harness for the share page

Tests `views/sharing.handlebars` without MeshCentral, a server or a real computer.

```
cd external/meshcentral-fork
node nordbase/remote-harness/run.mjs --out /tmp/nordbase-remote-harness   # about 3 minutes
node nordbase/remote-harness/run.mjs --quick                               # skips the Auto and jitter tests
node nordbase/remote-harness/run.mjs --step2 --quick                       # step 2 (phone, keyboard, WebRTC) and step 3
node nordbase/remote-harness/run.mjs --step3                               # only step 3 (scaling habits of the real agent, Ctrl+Alt+Del x 50), about 3 minutes
```

Needs Node 22+ and Google Chrome (or Edge; set `CHROME_PATH`). No installs, no network.

- `harness-server.mjs`: renders the real template, serves `public/`, fake `meshrelay.ashx` (MeshAgent KVM tile
  protocol, emulated latency and bandwidth, drop, dead link, broken tiles) and a fake
  `sharecontrol.ashx` that records every clipboard message (there must be none).
- `encoder.html`: draws a synthetic 4K + Full HD "desktop" and encodes JPEG/WebP tiles in the same headless Chrome.
- `run.mjs`: the step 1 checks, then `step2.mjs`. Writes `resultat.json`, `tangenttabell.json`, `auto-forlopp.json`, `telefon-skrivtabell.json`, `steg2-matvarden.json` and screenshots to `--out`.
- `step2.mjs` (step 2): phone/tablet view with Chrome touch emulation (portrait, landscape, tablet, safe areas), exact mouse/wheel/key bytes for every gesture,
  zoom/pan maths against the rendered canvas, typed Swedish text through the hidden keyboard field (incl. composition and autocorrect), sticky modifiers,
  reconnect that keeps the view, network change and stall handling, and WebRTC against a fake peer with its silent fallbacks, expiry and revocation.
- `step3.mjs` (step 3): the real Windows agent's habits (screen size twice at the start, late copies of the old size, scaling
  without a size message, no scaling, going back to 100 % by itself) and Ctrl+Alt+Del pressed 50 times across path switches
  (relay, switching, direct, broken direct path with a quiet switch, relay): each press must reach the KVM exactly once.
- `peer.html` (step 2): the fake agent's WebRTC end in its own tab (Chrome stands in for MeshAgent's ILibWebRTC). Chrome is started with
  `--disable-features=WebRtcHideLocalIpsWithMdns --allow-loopback-in-peer-connection` so two tabs on this machine can connect.

What it cannot show: how a real MeshAgent reacts (frame rate, its own WebRTC stack, timing on a real network), and how a real phone keyboard and hand behave. See `docs/fjarrstyrning.md` in the RMM repo.
