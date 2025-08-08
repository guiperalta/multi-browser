// Intercept Web Notifications in the page context and forward to main
// so the app can log them and focus the originating session when clicked.

const { ipcRenderer } = require('electron');

(() => {
  try {
    const NativeNotification = window.Notification;

    class InterceptedNotification extends NativeNotification {
      constructor(title, options = {}) {
        // Do NOT show Chromium's native toast; instead render a controlled one in main
        // by sending IPC. We still construct a minimal object by calling super with
        // an empty, muted notification and closing it immediately.
        try {
          super('', { silent: true });
          setTimeout(() => { try { this.close?.(); } catch {} }, 0);
        } catch { /* ignore */ }

        try {
          // Ask main to show a native notification we can reliably click
          ipcRenderer.send('show-native-notification', {
            title,
            options,
            url: location.href,
          });
        } catch {}

        try {
          // Forward metadata for logging purposes
          ipcRenderer.send('site-notification', { title, options, url: location.href });
        } catch {}
      }
    }

    // Preserve static members
    InterceptedNotification.permission = NativeNotification.permission;
    InterceptedNotification.requestPermission =
      NativeNotification.requestPermission.bind(NativeNotification);

    // Swap implementation
    Object.defineProperty(window, 'Notification', {
      value: InterceptedNotification,
      configurable: true,
      writable: false,
    });
  } catch (err) {
    // Best-effort only; do not break pages if interception fails
    console.error('[preload] Failed to hook Notification:', err);
  }
})();


