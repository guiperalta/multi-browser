const { ipcRenderer, contextBridge } = require('electron');

// Expose AI assistant API to the page via contextBridge
// Note: since notifications.js already uses ipcRenderer directly (nodeIntegration-like pattern),
// we follow the same pattern here for consistency.

(() => {
    // ── State ──
    let toolbarVisible = false;
    let shortcutKey = 'h'; // default: Alt+H
    let toolbar = null;
    let resultCard = null;

    // ── Styles ──
    const STYLES = `
        #ai-assistant-toolbar {
            position: fixed;
            bottom: 80px;
            right: 20px;
            z-index: 2147483640;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }

        #ai-assistant-fab {
            width: 48px;
            height: 48px;
            border-radius: 50%;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            transition: transform 0.2s ease, box-shadow 0.2s ease;
            color: white;
            font-size: 22px;
            outline: none;
        }

        #ai-assistant-fab:hover {
            transform: scale(1.1);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
        }

        #ai-assistant-fab.active {
            transform: rotate(45deg);
        }

        #ai-assistant-menu {
            position: absolute;
            bottom: 58px;
            right: 0;
            background: white;
            border-radius: 12px;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
            padding: 8px;
            display: none;
            flex-direction: column;
            gap: 4px;
            min-width: 180px;
            animation: ai-menu-fade-in 0.15s ease;
        }

        #ai-assistant-menu.visible {
            display: flex;
        }

        @keyframes ai-menu-fade-in {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .ai-menu-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            border: none;
            background: none;
            cursor: pointer;
            border-radius: 8px;
            font-size: 14px;
            color: #333;
            transition: background 0.15s ease;
            text-align: left;
            white-space: nowrap;
        }

        .ai-menu-item:hover {
            background: #f0f2ff;
        }

        .ai-menu-item .ai-icon {
            font-size: 18px;
            width: 24px;
            text-align: center;
        }

        .ai-menu-header {
            padding: 6px 14px 4px;
            font-size: 11px;
            font-weight: 600;
            color: #999;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .ai-menu-shortcut {
            margin-left: auto;
            font-size: 11px;
            color: #aaa;
            background: #f5f5f5;
            padding: 2px 6px;
            border-radius: 4px;
        }

        /* Result card */
        #ai-result-card {
            position: fixed;
            bottom: 140px;
            right: 20px;
            width: 380px;
            max-height: 400px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
            z-index: 2147483641;
            display: none;
            flex-direction: column;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            animation: ai-menu-fade-in 0.2s ease;
        }

        #ai-result-card.visible {
            display: flex;
        }

        .ai-result-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            border-bottom: 1px solid #eee;
        }

        .ai-result-title {
            font-size: 14px;
            font-weight: 600;
            color: #333;
        }

        .ai-result-close {
            background: none;
            border: none;
            font-size: 18px;
            cursor: pointer;
            color: #999;
            padding: 2px 6px;
            border-radius: 4px;
        }

        .ai-result-close:hover {
            background: #f5f5f5;
            color: #333;
        }

        .ai-result-body {
            padding: 16px;
            overflow-y: auto;
            flex: 1;
            font-size: 14px;
            line-height: 1.6;
            color: #333;
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .ai-result-actions {
            display: flex;
            gap: 8px;
            padding: 12px 16px;
            border-top: 1px solid #eee;
        }

        .ai-result-btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s ease;
        }

        .ai-btn-copy {
            background: #f0f2ff;
            color: #667eea;
        }

        .ai-btn-copy:hover {
            background: #e0e4ff;
        }

        .ai-btn-use {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .ai-btn-use:hover {
            opacity: 0.9;
        }

        /* Loading state */
        .ai-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 30px;
            gap: 8px;
            color: #667eea;
        }

        .ai-spinner {
            width: 20px;
            height: 20px;
            border: 2px solid #e0e4ff;
            border-top-color: #667eea;
            border-radius: 50%;
            animation: ai-spin 0.6s linear infinite;
        }

        @keyframes ai-spin {
            to { transform: rotate(360deg); }
        }

        .ai-error {
            color: #dc3545;
            padding: 16px;
            font-size: 14px;
        }
    `;

    // ── Inject styles ──
    function injectStyles() {
        const style = document.createElement('style');
        style.id = 'ai-assistant-styles';
        style.textContent = STYLES;
        document.head.appendChild(style);
    }

    // ── Create toolbar DOM ──
    function createToolbar() {
        toolbar = document.createElement('div');
        toolbar.id = 'ai-assistant-toolbar';
        toolbar.innerHTML = `
            <div id="ai-assistant-menu">
                <div class="ai-menu-header">AI Assistant</div>
                <button class="ai-menu-item" data-action="review">
                    <span class="ai-icon">&#9998;</span>
                    <span>Review</span>
                    <span class="ai-menu-shortcut">Grammar</span>
                </button>
                <button class="ai-menu-item" data-action="translate">
                    <span class="ai-icon">&#127760;</span>
                    <span>Translate</span>
                    <span class="ai-menu-shortcut">Language</span>
                </button>
                <button class="ai-menu-item" data-action="reply">
                    <span class="ai-icon">&#128172;</span>
                    <span>Reply</span>
                    <span class="ai-menu-shortcut">Suggest</span>
                </button>
                <button class="ai-menu-item" data-action="summarize">
                    <span class="ai-icon">&#128221;</span>
                    <span>Summarize</span>
                    <span class="ai-menu-shortcut">Digest</span>
                </button>
            </div>
            <button id="ai-assistant-fab" title="AI Assistant (Alt+H)">&#10024;</button>
        `;

        // Result card
        resultCard = document.createElement('div');
        resultCard.id = 'ai-result-card';
        resultCard.innerHTML = `
            <div class="ai-result-header">
                <span class="ai-result-title">AI Result</span>
                <button class="ai-result-close">&times;</button>
            </div>
            <div class="ai-result-body"></div>
            <div class="ai-result-actions">
                <button class="ai-result-btn ai-btn-copy">Copy</button>
                <button class="ai-result-btn ai-btn-use">Use</button>
            </div>
        `;

        document.body.appendChild(toolbar);
        document.body.appendChild(resultCard);

        // Event listeners
        const fab = toolbar.querySelector('#ai-assistant-fab');
        fab.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMenu();
        });

        // Menu item clicks
        toolbar.querySelectorAll('.ai-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = item.dataset.action;
                handleAction(action);
            });
        });

        // Result card close
        resultCard.querySelector('.ai-result-close').addEventListener('click', () => {
            hideResultCard();
        });

        // Copy button
        resultCard.querySelector('.ai-btn-copy').addEventListener('click', () => {
            const text = resultCard.querySelector('.ai-result-body').textContent;
            navigator.clipboard.writeText(text).then(() => {
                const btn = resultCard.querySelector('.ai-btn-copy');
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            });
        });

        // Use button - paste into WhatsApp input
        resultCard.querySelector('.ai-btn-use').addEventListener('click', () => {
            const text = resultCard.querySelector('.ai-result-body').textContent;
            pasteIntoInput(text);
            hideResultCard();
        });

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (toolbar && !toolbar.contains(e.target)) {
                hideMenu();
            }
        });
    }

    // ── Menu toggle ──
    function toggleMenu() {
        const menu = toolbar.querySelector('#ai-assistant-menu');
        const fab = toolbar.querySelector('#ai-assistant-fab');
        toolbarVisible = !toolbarVisible;

        if (toolbarVisible) {
            menu.classList.add('visible');
            fab.classList.add('active');
        } else {
            menu.classList.remove('visible');
            fab.classList.remove('active');
        }
    }

    function hideMenu() {
        if (!toolbarVisible) return;
        const menu = toolbar.querySelector('#ai-assistant-menu');
        const fab = toolbar.querySelector('#ai-assistant-fab');
        menu.classList.remove('visible');
        fab.classList.remove('active');
        toolbarVisible = false;
    }

    // ── Result card ──
    function showResultCard(title, content, isLoading = false) {
        const titleEl = resultCard.querySelector('.ai-result-title');
        const bodyEl = resultCard.querySelector('.ai-result-body');
        const actionsEl = resultCard.querySelector('.ai-result-actions');

        titleEl.textContent = title;

        if (isLoading) {
            bodyEl.innerHTML = '<div class="ai-loading"><div class="ai-spinner"></div><span>Thinking...</span></div>';
            actionsEl.style.display = 'none';
        } else {
            bodyEl.textContent = content;
            actionsEl.style.display = 'flex';
        }

        resultCard.classList.add('visible');
    }

    function showResultError(message) {
        const bodyEl = resultCard.querySelector('.ai-result-body');
        const actionsEl = resultCard.querySelector('.ai-result-actions');
        bodyEl.innerHTML = `<div class="ai-error">${escapeHtml(message)}</div>`;
        actionsEl.style.display = 'none';
    }

    function hideResultCard() {
        resultCard.classList.remove('visible');
    }

    // ── Text capture ──
    function getSelectedOrInputText() {
        // First try: window selection
        const selection = window.getSelection();
        if (selection && selection.toString().trim()) {
            return selection.toString().trim();
        }

        // Second try: WhatsApp message input box (contenteditable div)
        const inputBox = document.querySelector('div[contenteditable="true"][data-tab]')
            || document.querySelector('footer div[contenteditable="true"]')
            || document.querySelector('div[contenteditable="true"][role="textbox"]');

        if (inputBox && inputBox.textContent.trim()) {
            return inputBox.textContent.trim();
        }

        return null;
    }

    // ── Paste into WhatsApp input ──
    function pasteIntoInput(text) {
        const inputBox = document.querySelector('div[contenteditable="true"][data-tab]')
            || document.querySelector('footer div[contenteditable="true"]')
            || document.querySelector('div[contenteditable="true"][role="textbox"]');

        if (inputBox) {
            inputBox.focus();
            // Clear existing content
            inputBox.textContent = '';
            // Insert new text
            document.execCommand('insertText', false, text);
            // Trigger input event so WhatsApp recognizes the change
            inputBox.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    // ── Handle AI action ──
    async function handleAction(action) {
        hideMenu();

        const text = getSelectedOrInputText();
        if (!text) {
            showResultCard('No Text', '');
            showResultError('Please select some text or type a message in the input box first.');
            return;
        }

        const actionLabels = {
            review: 'Review',
            translate: 'Translate',
            reply: 'Reply Suggestion',
            summarize: 'Summary'
        };

        showResultCard(actionLabels[action] || 'AI Result', '', true);

        try {
            const result = await ipcRenderer.invoke('ai-request', { action, text });

            if (result.success) {
                showResultCard(actionLabels[action] || 'AI Result', result.text);
            } else {
                showResultError(result.error || 'An unknown error occurred.');
            }
        } catch (err) {
            showResultError(`Request failed: ${err.message}`);
        }
    }

    // ── Keyboard shortcut ──
    function setupKeyboardShortcut() {
        // DOM-level listener as a secondary mechanism
        // The primary trigger is 'before-input-event' in main.js -> 'ai-toggle-toolbar' IPC
        document.addEventListener('keydown', (e) => {
            // Alt + configured key (default H) — check both key and code for reliability
            const keyMatch = e.key.toLowerCase() === shortcutKey.toLowerCase();
            const codeMatch = e.code === `Key${shortcutKey.toUpperCase()}`;
            if (e.altKey && (keyMatch || codeMatch)) {
                e.preventDefault();
                e.stopPropagation();
                toggleMenu();
            }

            // ESC to close
            if (e.key === 'Escape') {
                if (toolbarVisible) {
                    hideMenu();
                }
                if (resultCard && resultCard.classList.contains('visible')) {
                    hideResultCard();
                }
            }
        }, true); // Use capture phase to get events before the page
    }

    // ── Listen for shortcut updates from main process ──
    function listenForSettingsUpdates() {
        ipcRenderer.on('ai-update-shortcut', (_e, newShortcut) => {
            if (newShortcut) {
                // Parse shortcut like "Alt+H" to extract the key
                const parts = newShortcut.split('+');
                shortcutKey = parts[parts.length - 1] || 'h';

                // Update tooltip
                const fab = document.querySelector('#ai-assistant-fab');
                if (fab) {
                    fab.title = `AI Assistant (${newShortcut})`;
                }
            }
        });

        // Listen for toolbar toggle from main process (global shortcut)
        ipcRenderer.on('ai-toggle-toolbar', () => {
            toggleMenu();
        });
    }

    // ── Load initial settings ──
    async function loadSettings() {
        try {
            const settings = await ipcRenderer.invoke('ai-get-settings');
            if (settings && settings.shortcut) {
                const parts = settings.shortcut.split('+');
                shortcutKey = parts[parts.length - 1] || 'h';

                const fab = document.querySelector('#ai-assistant-fab');
                if (fab) {
                    fab.title = `AI Assistant (${settings.shortcut})`;
                }
            }
        } catch (err) {
            console.log('[ai-assistant] Could not load settings:', err.message);
        }
    }

    // ── Utility ──
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ── Initialize ──
    function init() {
        // Wait for DOM to be ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setup);
        } else {
            setup();
        }
    }

    function setup() {
        // Small delay to ensure page content is loaded (WhatsApp Web loads dynamically)
        setTimeout(() => {
            injectStyles();
            createToolbar();
            setupKeyboardShortcut();
            listenForSettingsUpdates();
            loadSettings();
            console.log('[ai-assistant] AI Assistant toolbar injected');
        }, 2000);
    }

    init();
})();
