# Multi Browser

Electron desktop app for running **multiple fully-isolated browser sessions** side by side in a tabbed UI. Each session has its own cookies, localStorage, and storage partition, so you can be logged into several accounts of the same site (e.g. multiple WhatsApp Web / social accounts) at once. Ships with an AI assistant overlay (review/translate/reply/summarize) backed by the Claude CLI or an LLM API.

## Architecture

Standard Electron split — one main process, one renderer for the app shell (tab bar + chrome), and one `WebContentsView` per browser session.

| File | Role |
|------|------|
| `main.js` | Main process. Owns the `BrowserWindow`, creates one `WebContentsView` per session, manages session partitions, downloads, native notifications, and AI IPC. App bootstrap is `new MultiBrowserApp()` at the bottom; Linux command-line switches are appended at module load (before `app.whenReady`). The window title is `Multi Browser v<version>` (from `app.getVersion()`); a `page-title-updated` handler keeps it pinned so the shell's `<title>` can't overwrite it. |
| `renderer.js` | App-shell UI logic: tab bar, session list, create/rename modals, AI settings. Talks to main over IPC. Maps: `sessions` (id → metadata), `activeTabs` (id → tab element). |
| `index.html` / `styles.css` | App-shell markup and styling (NOT the web content — that's rendered in the per-session `WebContentsView`). |
| `preload/index.js` | Single preload for every session view (Electron allows one preload per view). Requires `notifications.js` then `ai-assistant.js`. |
| `preload/notifications.js` | Notification interception (see below). |
| `preload/ai-assistant.js` | In-page AI assistant overlay injected into each session. |
| `ai-provider.js` | AI provider factory: `claude-cli` (local `claude` CLI, no key), `claude-api`, `openai-api`. Actions: review, translate, reply, summarize. |
| `sessions.json` | Persisted session metadata (via `node-json-db`). |
| `assets/`, `build/icons/` | App icons (png/ico/icns; `build/icons` is the electron-builder Linux icon set). |

### Session isolation

Each session is an Electron partition `persist:session-<sessionId>` (`main.js`, `session.fromPartition(...)`), attached to a `WebContentsView`. Partitions persist to disk, so cookies/logins survive restarts. Deleting a session clears its partition data.

### Notification flow (and the click → focus behavior)

This is subtle and was the source of a real bug — read before touching it.

1. Session views run with **`contextIsolation: true`**. A preload that does `window.Notification = ...` only patches the preload's *isolated* world, **not** the page's main world where site JS (e.g. WhatsApp Web) actually runs. So `preload/notifications.js` injects its override into the **main world** via `webFrame.executeJavaScript(...)` (this also bypasses the site's CSP, unlike an inline `<script>`).
2. The override **wraps** the native `Notification` — it constructs the *real* notification (`super(...)`) so the site's own `onclick` still fires and navigates to the right conversation. It does **not** replace or suppress it.
3. On show/click, the main-world hook dispatches a `CustomEvent` on `document` (DOM nodes are shared across isolated worlds, so the event crosses the boundary). The isolated-world preload listens and forwards over IPC: `site-notification` (logging) and `focus-session-from-notification` (click).
4. Main resolves the originating session from `event.sender`, then `handleNotificationClick()` raises the window and sends `focus-session` to the renderer, which switches to that session's tab.

### WhatsApp deep links (wa.me / "Abrir app")

The app registers itself as the OS handler for the `whatsapp://` scheme (`app.setAsDefaultProtocolClient` + `build.protocols` in `package.json`, which adds `MimeType=x-scheme-handler/whatsapp` to the Linux .desktop file). Clicking "Abrir app"/"Open app" on a wa.me or api.whatsapp.com interstitial fires `whatsapp://send/?phone=...`, which lands here instead of a (nonexistent) native WhatsApp app.

Flow: `parseWhatsAppLink()` (top of `main.js`) normalizes `whatsapp://send`, `wa.me/<phone>`, and `api.whatsapp.com/send` URLs to `https://web.whatsapp.com/send?phone=...&text=...`; `handleWhatsAppLink()` picks the WhatsApp session (active view → any open WhatsApp view → most recently used saved session with a whatsapp.com URL), navigates it, and reuses `handleNotificationClick()` to raise the window and switch/open the tab (if the tab isn't open, the URL is parked in `pendingSessionNavigations` and consumed by `createBrowserView`). Links arrive via single-instance `second-instance` argv (app running), `process.argv` (cold start), or `open-url` (macOS). The same links clicked *inside* a session view are intercepted in `setWindowOpenHandler` / `will-navigate` / `will-redirect`. `wa.me/message/<code>` short links can't be mapped to web.whatsapp.com and are left alone.

**Linux registration:** the .deb's .desktop file declares the scheme, and the app also runs `setAsDefaultProtocolClient` on startup. If the browser still doesn't offer Multi Browser, run `xdg-mime default multi-browser.desktop x-scheme-handler/whatsapp` once.

**Linux / Wayland caveat:** on GNOME + Wayland, mutter enforces focus-stealing prevention — an app **cannot** un-minimize/raise itself; the compositor only flashes the dock icon ("attention" hint). This affects every app, not just this one, and is **not fixable from app code**. We launch in native Wayland mode (`ozone-platform-hint=auto`, set only when `XDG_SESSION_TYPE=wayland`) so a notification-click's `xdg-activation` token *can* authorize a raise, but mutter may still downgrade it to the attention hint. Tab-switch and conversation-open always work; raise-from-minimized depends on the compositor. User-side workaround: a GNOME extension such as "Steal My Focus Window".

## Develop

```bash
npm install
npm run dev        # electron --no-sandbox . --dev  (verbose logging)
npm start          # electron --no-sandbox .
```

`--no-sandbox` is required in the current launch scripts. Press **Ctrl+T** to fire a self-test notification.

Main-process logs (`[Site notification]`, `🔔 Notification clicked`, `🎯 Window shown...`) print to stdout. Preload/main-world logs (`[mb] ...`) go to the renderer DevTools console, not stdout.

## Build (electron-builder)

Output goes to `dist/`. Linux targets are configured as `deb`, `rpm`, and `AppImage` in `package.json` → `build.linux`.

```bash
# Build just .deb + AppImage (what we ship on Linux):
npx electron-builder --linux deb AppImage

# Other targets:
npm run build:linux     # deb + rpm + AppImage (all Linux targets)
npm run build:deb       # deb only
npm run build:win       # Windows nsis installer
npm run build:mac       # macOS dmg
```

Artifacts land in `dist/` — e.g. `Multi Browser-<version>.AppImage` and `multi-browser_<version>_amd64.deb`. App version comes from `package.json` → `version` (currently `1.0.7`) and is also shown in the window title. Bump `version` there before re-packaging.
