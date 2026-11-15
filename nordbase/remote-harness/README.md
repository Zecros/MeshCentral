# Nordbase Remote: local harness for the share page

Tests `views/sharing.handlebars` without MeshCentral, a server or a real computer.

```
cd external/meshcentral-fork
node nordbase/remote-harness/run.mjs --out /tmp/nordbase-remote-harness   # about 3 minutes
node nordbase/remote-harness/run.mjs --quick                               # skips the Auto test, about 1.5 minutes
```

Needs Node 22+ and Google Chrome (or Edge; set `CHROME_PATH`). No installs, no network.

- `harness-server.mjs`: renders the real template, serves `public/`, fake `meshrelay.ashx` (MeshAgent KVM tile
  protocol, emulated latency and bandwidth, drop, dead link, agent without WebP, broken WebP tiles) and a fake
  `sharecontrol.ashx` that records every clipboard message (there must be none).
- `encoder.html`: draws a synthetic 4K + Full HD "desktop" and encodes JPEG/WebP tiles in the same headless Chrome.
- `run.mjs`: the checks. Writes `resultat.json`, `tangenttabell.json`, `auto-forlopp.json` and screenshots to `--out`.

What it cannot show: how a real MeshAgent reacts (WebP, scaling, frame rate). See `docs/fjarrstyrning.md` in the RMM repo.
