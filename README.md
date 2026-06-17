# Multi Browser

A desktop app for running **multiple fully-isolated browser sessions** side by side in a tabbed window. Each session keeps its own cookies, `localStorage`, and storage partition, so you can stay logged into several accounts of the same site at once (e.g. multiple WhatsApp Web or social accounts). Ships with an in-page AI assistant and smart notification/deep-link handling.

Built with Electron — Chromium is embedded, so **no external browser is required**.

## Features

- 🧩 **Fully-isolated sessions** — each session is its own persistent Electron partition (cookies, `localStorage`, cache). Be logged into many accounts of the same site simultaneously.
- 💾 **Persistence** — sessions and their logins survive app restarts. Deleting a session wipes its data.
- 🗂️ **Tabbed UI** — create, rename, and switch between sessions; mark sessions to auto-open on startup.
- ✨ **AI assistant overlay** — review, translate, reply, and summarize text in-page (default shortcut `Alt+H`). Backed by the local **Claude CLI** (no key), **Claude API**, **OpenAI API**, or **OpenRouter**.
- 🔤 **Per-session spellcheck** — pick one or more languages per session (defaults to Portuguese + English). Right-click a misspelled word for suggestions and "add to dictionary".
- 🔔 **Native notifications** — site notifications fire natively; clicking one raises the window and jumps to the right session, tab, and conversation.
- 💬 **WhatsApp deep links** — `whatsapp://`, `wa.me`, and `api.whatsapp.com` links open in your WhatsApp session instead of failing to launch a native app.
- 🔗 **URL suggestions** — the new-session dialog autocompletes common targets (WhatsApp Web, Telegram Web).

## Download

Grab a prebuilt installer from the [**Releases**](https://github.com/guiperalta/multi-browser/releases) page:

| Platform | File |
|----------|------|
| Windows  | `Multi Browser Setup <version>.exe` |
| Linux    | `multi-browser_<version>_amd64.deb`, `Multi Browser-<version>.AppImage` |

(macOS `.dmg` can be built from source — see below.)

## Run from source

Requires **Node.js 18+**.

```bash
npm install
npm run dev      # verbose logging
npm start        # normal launch
```

> Both scripts pass `--no-sandbox`. To run with Chromium's sandbox enabled, see the Linux note under Troubleshooting and use `npm run dev:sandbox`.

Press **Ctrl+T** to fire a self-test notification.

## Build installers

Output lands in `dist/`. App version comes from `package.json` → `version`.

```bash
npm run build:linux                 # deb + rpm + AppImage
npm run build:deb                   # deb only
npx electron-builder --linux deb AppImage   # what we ship on Linux
npm run build:win                   # Windows nsis installer (.exe)
npm run build:mac                   # macOS dmg
```

> Releases are built automatically by GitHub Actions when a version tag is pushed (`git tag v1.2.3 && git push origin v1.2.3`): Linux artifacts build on a Linux runner, the Windows `.exe` on a Windows runner, and both are attached to a GitHub Release.

## Usage

1. **Create a session** — give it a name (e.g. "Work", "Personal") and an optional start URL (autocompletes WhatsApp/Telegram).
2. **Open it** — a new tab loads with that session's isolated storage.
3. **Manage** — rename a session (and change its spellcheck languages), toggle auto-open, or delete it.
4. **Configure AI** — open AI Settings, pick a provider, and set the keyboard shortcut.

Each session has separate cookies and storage, so logging into a site in one tab does not affect any other.

## How it works

- **Isolation** — every session runs in a `WebContentsView` bound to a `persist:session-<id>` partition; partitions persist to disk.
- **Notifications** — a main-world hook wraps the site's `Notification`, so the site's own click handler still navigates while the app also raises the window and switches tabs.
- **WhatsApp links** — the app registers as the `whatsapp://` scheme handler and normalizes `wa.me` / `api.whatsapp.com` links to `web.whatsapp.com`, routing them into the WhatsApp session.

See [`CLAUDE.md`](CLAUDE.md) for the full architecture notes.

## Troubleshooting

**Linux sandbox error** (`chrome-sandbox is owned by root and has mode 4755`):
- Use `npm run dev` / `npm start` (they pass `--no-sandbox`), or fix the helper to keep the sandbox enabled:
  ```bash
  sudo chown root:root node_modules/electron/dist/chrome-sandbox
  sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
  npm run dev:sandbox
  ```

**WhatsApp "Open app" links don't offer Multi Browser (Linux):**
- Run once: `xdg-mime default multi-browser.desktop x-scheme-handler/whatsapp`

**Clicking a notification flashes the dock but doesn't raise the window (GNOME + Wayland):**
- Mutter's focus-stealing prevention blocks apps from raising themselves; this affects every app and isn't fixable from app code. Tab-switch and conversation-open still work. A GNOME extension such as "Steal My Focus Window" works around it.

## License

MIT
