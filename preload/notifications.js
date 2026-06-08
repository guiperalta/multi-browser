// Wrap Web Notifications so the app can log them and bring the owning
// window/tab to the front when one is clicked.
//
// The browser views run with contextIsolation: true, so this preload lives in
// an ISOLATED world. Overriding `window.Notification` here would NOT affect the
// page's own code (e.g. WhatsApp Web), which runs in the main world with its
// own `window`. So we inject the override into the page's MAIN world via
// webFrame.executeJavaScript — this runs in the page's real JS context and is
// not blocked by the site's CSP (it is not an inline <script>).
//
// The main-world hook keeps the site's real notification alive (so its own
// onclick still navigates to the right conversation) and signals back to this
// isolated world via CustomEvents on `document` (DOM nodes are shared across
// worlds, so the events cross the boundary). We then forward to main over IPC.

const { ipcRenderer, webFrame } = require('electron');

// --- Isolated world: receive signals from the main-world hook and forward ---

document.addEventListener('mb:notification-shown', (e) => {
  let data = {};
  try { data = JSON.parse(e.detail); } catch { /* ignore */ }
  try {
    ipcRenderer.send('site-notification', {
      title: data.title,
      options: { body: data.body },
      url: location.href,
    });
  } catch (err) {
    console.error('[preload] Error forwarding site-notification:', err);
  }
});

document.addEventListener('mb:notification-click', () => {
  try {
    ipcRenderer.send('focus-session-from-notification', { url: location.href });
  } catch (err) {
    console.error('[preload] Error forwarding notification click:', err);
  }
});

// --- Main world: the actual Notification override (runs in the page context) ---

const mainWorldHook = `
(() => {
  try {
    const Native = window.Notification;
    if (!Native || window.__mbNotificationHooked) return;
    window.__mbNotificationHooked = true;

    class Wrapped extends Native {
      constructor(title, options = {}) {
        // Construct the REAL, visible notification so the site's own click
        // handler (conversation navigation) stays intact.
        super(title, options);

        try {
          document.dispatchEvent(new CustomEvent('mb:notification-shown', {
            detail: JSON.stringify({
              title: String(title == null ? '' : title),
              body: (options && options.body) || ''
            })
          }));
        } catch (e) {}

        try {
          this.addEventListener('click', () => {
            try { document.dispatchEvent(new CustomEvent('mb:notification-click')); } catch (e) {}
          });
        } catch (e) {}
      }
    }

    // Preserve static members the site may read.
    Wrapped.permission = Native.permission;
    if (Native.requestPermission) {
      Wrapped.requestPermission = Native.requestPermission.bind(Native);
    }
    try {
      Object.defineProperty(Wrapped, 'maxActions', {
        get() { return Native.maxActions; },
        configurable: true,
      });
    } catch (e) {}

    Object.defineProperty(window, 'Notification', { value: Wrapped, configurable: true });
    console.log('[mb] Notification hook installed in main world');
  } catch (e) {
    console.error('[mb] Failed to hook Notification in main world:', e);
  }
})();
`;

try {
  webFrame.executeJavaScript(mainWorldHook);
} catch (err) {
  console.error('[preload] Failed to inject main-world Notification hook:', err);
}
