---
name: run-app
description: Launch Multi Browser (Electron) headless under Xvfb and drive it over CDP to verify UI changes — shell chrome, home screen, modals, and the in-page AI assistant overlay. Use whenever a change needs to be seen working in the real app, or when asked to run/start/screenshot the app.
---

# Run Multi Browser and drive it

Three things break a naive `npm run dev`, so start from this recipe.

1. **The installed app holds the single-instance lock.** If `/opt/Multi Browser`
   is running, a dev instance prints the DevTools line and exits 0. Pass
   `--user-data-dir=<scratch>` — the lock is keyed on userData.
2. **Nothing to screenshot on the user's desktop.** Run under `xvfb-run` and
   capture through CDP instead, so the user's screen is never touched.
3. **The AI overlay lives in a `WebContentsView`**, not the `BrowserWindow`.
   Playwright's `_electron` only exposes windows, so use raw CDP
   (`--remote-debugging-port`) — every view shows up as its own target.

## Launch

Work from a symlinked copy so the repo's `sessions.json` (which the app writes
to, since `JsonDB` resolves relative to cwd) stays untouched:

```bash
S=<scratch>            # e.g. the session scratchpad
mkdir -p $S/app $S/udata
for f in main.js renderer.js index.html styles.css ai-provider.js preload assets build node_modules package.json; do
  ln -s "$PWD/$f" $S/app/$f
done
cp sessions.json $S/app/sessions.json     # a copy — writes land here, not in git

cd $S/app && XDG_SESSION_TYPE=x11 xvfb-run -a --server-args="-screen 0 1500x950x24" \
  "$OLDPWD/node_modules/.bin/electron" --no-sandbox . --dev \
  --user-data-dir=$S/udata --remote-debugging-port=9222
```

Run it in the background. `curl -s http://localhost:9222/json/list` lists the
targets: the shell is titled `Multi Browser Manager`, each session view carries
its page title.

For a predictable session view, point the copied `sessions.json` at a local
page (`python3 -m http.server` in the scratch dir) instead of web.whatsapp.com.

## Drive it

Node 24 has a global `WebSocket`, so a CDP client is ~15 lines — no deps:

```js
const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(x => x.type === 'page' && x.title.includes(TITLE));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, m => res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
```

- `Runtime.evaluate` for state (`{expression, awaitPromise:true, returnByValue:true}`).
  It runs in the main world; the preload's isolated world shares the DOM, so
  overlay elements are visible from here.
- `Input.dispatchMouseEvent` for real, trusted pointer events — required for
  the AI button's drag (`mousePressed` → several `mouseMoved` → `mouseReleased`).
- `Input.dispatchKeyEvent` with `modifiers: 1` for Alt+H (main-process
  `before-input-event` path).
- `Page.captureScreenshot` → write the base64 to a png and **look at it**.

## Cache gotcha

Chromium caches `file://` assets in the userData dir, so a second run against
the same `--user-data-dir` serves the previous `styles.css`. If a CSS change
seems to have no effect, send `Network.clearBrowserCache` then
`Page.reload {ignoreCache:true}` — or use a fresh userData dir.

## Cleanup

Kill the electron processes, then the `Xvfb` that `xvfb-run` left behind, then
any `http.server`. Verify with
`pgrep -af "Xvfb|dist/electron|http.server"` — it should come back empty.

## Don't

- Don't click **Delete** on a session: `deleteSession()` calls `confirm()`, and
  a modal dialog freezes CDP until it is dismissed.
- Don't reuse the repo's own `sessions.json`; the app rewrites `lastAccessed`
  and `/ai-fab-position` on it.
