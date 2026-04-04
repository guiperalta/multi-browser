// Combined preload entry point
// Electron only supports one preload script per WebContentsView,
// so this file loads both the notification interceptor and the AI assistant.

require('./notifications.js');
require('./ai-assistant.js');
