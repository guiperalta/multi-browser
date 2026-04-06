// Combined preload entry point
// Electron only supports one preload script per WebContentsView,
// so this file loads both the notification interceptor and the AI assistant.

try {
    require('./notifications.js');
} catch (err) {
    console.error('[preload] Failed to load notifications.js:', err);
}

try {
    require('./ai-assistant.js');
} catch (err) {
    console.error('[preload] Failed to load ai-assistant.js:', err);
}
