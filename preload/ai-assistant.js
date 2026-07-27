const { ipcRenderer } = require('electron');

(() => {
    console.log('[ai-assistant] Preload script starting...');

    // ── Layout constants ──
    const FAB_SIZE = 52;
    const MARGIN = 18;
    const DRAG_THRESHOLD = 4;      // px before a press becomes a drag
    const IDLE_DIM_DELAY = 2600;   // ms of no interaction before the FAB fades back

    // ── State ──
    let toolbarVisible = false;
    let shortcutKey = 'h'; // default: Alt+H
    let shortcutLabel = 'Alt+H';
    let toolbar = null;
    let resultCard = null;
    let initialized = false;
    let currentActionText = null; // clean text for Copy/Use (no changes explanation)

    // Position of the floating button: which edge it clings to, and where along
    // that edge (0 = top of the usable track, 1 = bottom). Ratios survive window
    // resizes; raw pixels do not.
    let fabPos = { side: 'right', yRatio: 0.8 };
    let dragging = false;
    let suppressNextClick = false;
    let cardMoved = false;         // user dragged the result card away from its anchor
    let idleTimer = null;

    // ── Register IPC listeners IMMEDIATELY (before DOM is ready) ──
    // This ensures we can receive 'ai-toggle-toolbar' from main process at any time.
    ipcRenderer.on('ai-toggle-toolbar', () => {
        console.log('[ai-assistant] Received ai-toggle-toolbar IPC');
        if (initialized) {
            toggleMenu();
        } else {
            console.log('[ai-assistant] Toolbar not yet initialized, queuing toggle');
            // Retry after initialization
            const check = setInterval(() => {
                if (initialized) {
                    clearInterval(check);
                    toggleMenu();
                }
            }, 200);
            setTimeout(() => clearInterval(check), 5000);
        }
    });

    ipcRenderer.on('ai-update-shortcut', (_e, newShortcut) => {
        if (newShortcut) {
            const parts = newShortcut.split('+');
            shortcutKey = parts[parts.length - 1] || 'h';
            shortcutLabel = newShortcut;
            updateShortcutLabel();
        }
    });

    // Position changed in another session view — keep every view in sync.
    ipcRenderer.on('ai-fab-position-changed', (_e, pos) => {
        if (!pos || dragging) return;
        fabPos = normalizePos(pos);
        applyFabPosition(true);
    });

    console.log('[ai-assistant] IPC listeners registered');

    // ── Styles ──
    // Aesthetic: "obsidian console" — a dark, low-glare glass slab with a single
    // warm amber accent. Deliberately not the host page's look: it should read as
    // a tool laid on top of the site, never as part of it.
    const STYLES = `
        #ai-assistant-toolbar, #ai-result-card {
            --mb-panel: rgba(20, 20, 24, 0.86);
            --mb-panel-solid: #16161a;
            --mb-hairline: rgba(255, 255, 255, 0.10);
            --mb-hairline-soft: rgba(255, 255, 255, 0.05);
            --mb-ink: #ece7de;
            --mb-ink-dim: rgba(236, 231, 222, 0.52);
            --mb-ink-faint: rgba(236, 231, 222, 0.30);
            --mb-accent: #e2a44b;
            --mb-accent-soft: rgba(226, 164, 75, 0.16);
            --mb-danger: #e2705f;
            --mb-shadow: 0 18px 44px -12px rgba(0, 0, 0, 0.62), 0 2px 8px rgba(0, 0, 0, 0.34);
            --mb-sans: "Avenir Next", "Segoe UI Variable Display", Optima, Cantarell, Ubuntu, system-ui, sans-serif;
            --mb-mono: "JetBrains Mono", "Cascadia Code", "Ubuntu Mono", ui-monospace, monospace;
            --mb-ease: cubic-bezier(0.16, 0.9, 0.28, 1);
        }

        #ai-assistant-toolbar, #ai-assistant-toolbar *,
        #ai-result-card, #ai-result-card * {
            box-sizing: border-box;
            margin: 0;
            font-family: var(--mb-sans);
        }

        #ai-assistant-toolbar {
            position: fixed;
            left: 0;
            top: 0;
            width: ${FAB_SIZE}px;
            height: ${FAB_SIZE}px;
            z-index: 2147483640;
            touch-action: none;
        }

        #ai-assistant-toolbar.settling {
            transition: transform 0.42s var(--mb-ease);
        }

        /* ── The button ── */
        #ai-assistant-fab {
            position: relative;
            width: ${FAB_SIZE}px;
            height: ${FAB_SIZE}px;
            border-radius: 17px;
            border: 1px solid var(--mb-hairline);
            background:
                radial-gradient(120% 120% at 30% 0%, rgba(226, 164, 75, 0.22) 0%, transparent 58%),
                linear-gradient(180deg, #23232a 0%, #121216 100%);
            color: var(--mb-accent);
            cursor: grab;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            outline: none;
            box-shadow: var(--mb-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.07);
            opacity: 0.42;
            transition: opacity 0.3s ease, transform 0.22s var(--mb-ease),
                        box-shadow 0.22s ease, border-color 0.22s ease;
            -webkit-app-region: no-drag;
        }

        #ai-assistant-toolbar.awake #ai-assistant-fab,
        #ai-assistant-fab:hover,
        #ai-assistant-fab:focus-visible {
            opacity: 1;
        }

        #ai-assistant-fab:hover {
            transform: translateY(-2px);
            border-color: rgba(226, 164, 75, 0.42);
            box-shadow: var(--mb-shadow), 0 0 0 4px var(--mb-accent-soft),
                        inset 0 1px 0 rgba(255, 255, 255, 0.09);
        }

        #ai-assistant-fab svg {
            width: 21px;
            height: 21px;
            display: block;
            transition: transform 0.35s var(--mb-ease);
        }

        #ai-assistant-fab.active {
            opacity: 1;
            border-color: rgba(226, 164, 75, 0.55);
            box-shadow: var(--mb-shadow), 0 0 0 5px var(--mb-accent-soft);
        }

        #ai-assistant-fab.active svg {
            transform: rotate(90deg) scale(0.92);
        }

        #ai-assistant-toolbar.dragging #ai-assistant-fab {
            cursor: grabbing;
            opacity: 1;
            transform: scale(1.08);
            border-color: rgba(226, 164, 75, 0.6);
            box-shadow: 0 26px 50px -14px rgba(0, 0, 0, 0.7), 0 0 0 6px var(--mb-accent-soft);
        }

        /* Grip dots appear while dragging so the button reads as movable */
        #ai-assistant-fab::after {
            content: "";
            position: absolute;
            inset: 0;
            border-radius: inherit;
            background-image: radial-gradient(rgba(236, 231, 222, 0.5) 1px, transparent 1px);
            background-size: 5px 5px;
            background-position: center;
            opacity: 0;
            transition: opacity 0.2s ease;
            pointer-events: none;
        }

        #ai-assistant-toolbar.dragging #ai-assistant-fab::after { opacity: 0.5; }
        #ai-assistant-toolbar.dragging #ai-assistant-fab svg { opacity: 0; }

        /* Hover tag next to the button */
        #ai-assistant-hint {
            position: absolute;
            top: 50%;
            transform: translateY(-50%) scale(0.94);
            white-space: nowrap;
            padding: 5px 9px;
            border-radius: 8px;
            background: var(--mb-panel);
            border: 1px solid var(--mb-hairline);
            color: var(--mb-ink-dim);
            font-size: 11px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            font-family: var(--mb-mono);
            box-shadow: var(--mb-shadow);
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.18s ease, transform 0.18s var(--mb-ease);
            backdrop-filter: blur(14px);
        }

        #ai-assistant-toolbar.pos-right #ai-assistant-hint { right: ${FAB_SIZE + 10}px; }
        #ai-assistant-toolbar.pos-left  #ai-assistant-hint { left: ${FAB_SIZE + 10}px; }

        #ai-assistant-toolbar:hover #ai-assistant-hint {
            opacity: 1;
            transform: translateY(-50%) scale(1);
        }

        #ai-assistant-toolbar.dragging #ai-assistant-hint,
        #ai-assistant-toolbar.menu-open #ai-assistant-hint { opacity: 0; }

        /* ── Menu ── */
        #ai-assistant-menu {
            position: absolute;
            width: 232px;
            padding: 7px;
            border-radius: 16px;
            background: var(--mb-panel);
            border: 1px solid var(--mb-hairline);
            box-shadow: var(--mb-shadow);
            backdrop-filter: blur(22px) saturate(140%);
            -webkit-backdrop-filter: blur(22px) saturate(140%);
            display: none;
            flex-direction: column;
            gap: 1px;
            overflow: hidden;
        }

        #ai-assistant-menu::before {
            content: "";
            position: absolute;
            inset: 0 0 auto 0;
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.22), transparent);
        }

        #ai-assistant-menu.visible { display: flex; }

        #ai-assistant-toolbar.open-up #ai-assistant-menu   { bottom: ${FAB_SIZE + 10}px; }
        #ai-assistant-toolbar.open-down #ai-assistant-menu { top: ${FAB_SIZE + 10}px; }
        #ai-assistant-toolbar.pos-right #ai-assistant-menu { right: 0; }
        #ai-assistant-toolbar.pos-left  #ai-assistant-menu { left: 0; }

        .ai-menu-header {
            display: flex;
            align-items: center;
            gap: 7px;
            padding: 8px 10px 9px;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--mb-ink-faint);
            font-family: var(--mb-mono);
        }

        .ai-menu-header .ai-dot {
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: var(--mb-accent);
            box-shadow: 0 0 8px var(--mb-accent);
            flex: none;
        }

        .ai-menu-header .ai-rule {
            flex: 1;
            height: 1px;
            background: var(--mb-hairline-soft);
        }

        .ai-menu-item {
            display: flex;
            align-items: center;
            gap: 11px;
            width: 100%;
            padding: 9px 10px;
            border: none;
            border-radius: 11px;
            background: none;
            cursor: pointer;
            font-size: 13.5px;
            color: var(--mb-ink);
            text-align: left;
            white-space: nowrap;
            position: relative;
            transition: background 0.16s ease, color 0.16s ease;
            animation: ai-item-in 0.34s var(--mb-ease) backwards;
        }

        #ai-assistant-menu.visible .ai-menu-item:nth-child(2) { animation-delay: 0.02s; }
        #ai-assistant-menu.visible .ai-menu-item:nth-child(3) { animation-delay: 0.05s; }
        #ai-assistant-menu.visible .ai-menu-item:nth-child(4) { animation-delay: 0.08s; }
        #ai-assistant-menu.visible .ai-menu-item:nth-child(5) { animation-delay: 0.11s; }

        @keyframes ai-item-in {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
        }

        .ai-menu-item:hover { background: rgba(255, 255, 255, 0.06); }

        .ai-menu-item .ai-icon {
            width: 27px;
            height: 27px;
            flex: none;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 9px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--mb-hairline-soft);
            color: var(--mb-ink-dim);
            transition: color 0.16s ease, background 0.16s ease, border-color 0.16s ease;
        }

        .ai-menu-item .ai-icon svg { width: 14px; height: 14px; display: block; }

        .ai-menu-item:hover .ai-icon {
            color: var(--mb-accent);
            background: var(--mb-accent-soft);
            border-color: rgba(226, 164, 75, 0.3);
        }

        .ai-menu-item .ai-label { flex: 1; }

        .ai-menu-item .ai-menu-shortcut {
            font-family: var(--mb-mono);
            font-size: 9.5px;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: var(--mb-ink-faint);
        }

        .ai-menu-divider {
            height: 1px;
            margin: 5px 8px;
            background: var(--mb-hairline-soft);
        }

        .ai-menu-foot {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 7px 10px 6px;
            border: none;
            background: none;
            cursor: pointer;
            border-radius: 9px;
            font-family: var(--mb-mono);
            font-size: 10px;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: var(--mb-ink-faint);
            transition: color 0.16s ease, background 0.16s ease;
        }

        .ai-menu-foot:hover { color: var(--mb-ink-dim); background: rgba(255, 255, 255, 0.05); }
        .ai-menu-foot svg { width: 12px; height: 12px; flex: none; }

        /* ── Result card ── */
        #ai-result-card {
            position: fixed;
            width: 384px;
            max-height: 60vh;
            border-radius: 18px;
            background: var(--mb-panel);
            border: 1px solid var(--mb-hairline);
            box-shadow: var(--mb-shadow);
            backdrop-filter: blur(24px) saturate(140%);
            -webkit-backdrop-filter: blur(24px) saturate(140%);
            z-index: 2147483641;
            display: none;
            flex-direction: column;
            overflow: hidden;
            animation: ai-card-in 0.26s var(--mb-ease);
        }

        #ai-result-card.visible { display: flex; }

        @keyframes ai-card-in {
            from { opacity: 0; transform: translateY(10px) scale(0.985); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
        }

        .ai-result-header {
            display: flex;
            align-items: center;
            gap: 9px;
            padding: 13px 14px 12px;
            border-bottom: 1px solid var(--mb-hairline-soft);
            cursor: grab;
            user-select: none;
        }

        .ai-result-header.grabbing { cursor: grabbing; }

        .ai-result-header .ai-dot {
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: var(--mb-accent);
            box-shadow: 0 0 8px var(--mb-accent);
            flex: none;
        }

        .ai-result-title {
            flex: 1;
            font-family: var(--mb-mono);
            font-size: 10.5px;
            font-weight: 600;
            letter-spacing: 0.16em;
            text-transform: uppercase;
            color: var(--mb-ink-dim);
        }

        .ai-result-close {
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: none;
            border: 1px solid transparent;
            border-radius: 7px;
            cursor: pointer;
            color: var(--mb-ink-faint);
            padding: 0;
            transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
        }

        .ai-result-close svg { width: 11px; height: 11px; }

        .ai-result-close:hover {
            color: var(--mb-ink);
            background: rgba(255, 255, 255, 0.07);
            border-color: var(--mb-hairline-soft);
        }

        .ai-result-body {
            padding: 15px 16px 17px;
            overflow-y: auto;
            flex: 1;
            font-size: 13.5px;
            line-height: 1.66;
            color: var(--mb-ink);
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .ai-result-body::-webkit-scrollbar { width: 9px; }
        .ai-result-body::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.13);
            border-radius: 9px;
            border: 3px solid transparent;
            background-clip: content-box;
        }
        .ai-result-body::-webkit-scrollbar-track { background: transparent; }

        .ai-result-actions {
            display: flex;
            gap: 7px;
            padding: 11px 14px 13px;
            border-top: 1px solid var(--mb-hairline-soft);
        }

        .ai-result-btn {
            flex: 1;
            padding: 9px 14px;
            border-radius: 10px;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.05em;
            cursor: pointer;
            transition: background 0.16s ease, color 0.16s ease,
                        border-color 0.16s ease, transform 0.16s var(--mb-ease);
        }

        .ai-result-btn:active { transform: translateY(1px); }

        .ai-btn-copy {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--mb-hairline);
            color: var(--mb-ink-dim);
        }

        .ai-btn-copy:hover { background: rgba(255, 255, 255, 0.09); color: var(--mb-ink); }

        .ai-btn-use {
            background: linear-gradient(180deg, #eeb35c 0%, #d9963c 100%);
            border: 1px solid rgba(255, 255, 255, 0.16);
            color: #1b1408;
        }

        .ai-btn-use:hover { filter: brightness(1.07); }

        /* Loading state */
        .ai-loading {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 26px 4px;
            color: var(--mb-ink-dim);
            font-family: var(--mb-mono);
            font-size: 11px;
            letter-spacing: 0.14em;
            text-transform: uppercase;
        }

        .ai-spinner {
            width: 16px;
            height: 16px;
            border: 1.5px solid rgba(255, 255, 255, 0.12);
            border-top-color: var(--mb-accent);
            border-radius: 50%;
            animation: ai-spin 0.7s linear infinite;
            flex: none;
        }

        @keyframes ai-spin { to { transform: rotate(360deg); } }

        .ai-error {
            display: flex;
            gap: 9px;
            font-size: 13px;
            line-height: 1.55;
            color: var(--mb-danger);
        }

        .ai-error svg { width: 15px; height: 15px; flex: none; margin-top: 2px; }

        @media (prefers-reduced-motion: reduce) {
            #ai-assistant-toolbar, #ai-assistant-toolbar *,
            #ai-result-card, #ai-result-card * {
                animation-duration: 0.01ms !important;
                transition-duration: 0.01ms !important;
            }
        }
    `;

    // ── Inline icons (stroke-based, 24×24 viewBox) ──
    const ICONS = {
        spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.4L19.5 10l-5.6 1.6L12 17l-1.9-5.4L4.5 10l5.6-1.6L12 3z"/><path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"/></svg>',
        pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 4.5l3 3L8 19l-4 1 1-4L16.5 4.5z"/><path d="M14.5 6.5l3 3"/></svg>',
        globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z"/></svg>',
        reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 8L4.5 12 9 16"/><path d="M4.5 12h9a6 6 0 016 6v1.5"/></svg>',
        lines: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15"/><path d="M4.5 12h11"/><path d="M4.5 17h7"/></svg>',
        target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>',
        alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5"/><path d="M12 16.2v.2"/></svg>'
    };

    // ── Inject styles ──
    function injectStyles() {
        if (document.getElementById('ai-assistant-styles')) return;
        const style = document.createElement('style');
        style.id = 'ai-assistant-styles';
        style.textContent = STYLES;
        (document.head || document.documentElement).appendChild(style);
    }

    // ── Position helpers ──
    function clamp(v, lo, hi) {
        return Math.min(hi, Math.max(lo, v));
    }

    function normalizePos(pos) {
        return {
            side: pos.side === 'left' ? 'left' : 'right',
            yRatio: clamp(typeof pos.yRatio === 'number' ? pos.yRatio : 0.8, 0, 1)
        };
    }

    function trackHeight() {
        return Math.max(0, window.innerHeight - FAB_SIZE - MARGIN * 2);
    }

    function currentXY() {
        const x = fabPos.side === 'left'
            ? MARGIN
            : Math.max(MARGIN, window.innerWidth - FAB_SIZE - MARGIN);
        const y = MARGIN + fabPos.yRatio * trackHeight();
        return { x, y };
    }

    // Move the toolbar to `fabPos`. `animate` runs the snap transition.
    function applyFabPosition(animate = false) {
        if (!toolbar) return;
        const { x, y } = currentXY();
        toolbar.classList.toggle('settling', !!animate);
        toolbar.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
        toolbar.classList.toggle('pos-left', fabPos.side === 'left');
        toolbar.classList.toggle('pos-right', fabPos.side !== 'left');
        // Menu opens toward the roomier half of the viewport.
        const openUp = y + FAB_SIZE / 2 > window.innerHeight / 2;
        toolbar.classList.toggle('open-up', openUp);
        toolbar.classList.toggle('open-down', !openUp);
        if (animate) {
            setTimeout(() => toolbar && toolbar.classList.remove('settling'), 460);
        }
        if (resultCard && resultCard.classList.contains('visible') && !cardMoved) {
            positionResultCard();
        }
    }

    function savePosition() {
        ipcRenderer.invoke('ai-save-fab-position', fabPos).catch(() => { });
    }

    // ── Idle dimming: the button fades back when it is not being used ──
    function wake() {
        if (!toolbar) return;
        toolbar.classList.add('awake');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (toolbar && !toolbarVisible && !dragging) toolbar.classList.remove('awake');
        }, IDLE_DIM_DELAY);
    }

    // ── Drag ──
    function setupDrag(fab) {
        let startX = 0, startY = 0, originX = 0, originY = 0, pointerId = null;

        fab.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            pointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            const pos = currentXY();
            originX = pos.x;
            originY = pos.y;
            dragging = false;
            fab.setPointerCapture(pointerId);
            wake();
        });

        fab.addEventListener('pointermove', (e) => {
            if (pointerId === null || e.pointerId !== pointerId) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

            if (!dragging) {
                dragging = true;
                toolbar.classList.add('dragging');
                toolbar.classList.remove('settling');
                hideMenu();
            }

            const x = clamp(originX + dx, MARGIN, Math.max(MARGIN, window.innerWidth - FAB_SIZE - MARGIN));
            const y = clamp(originY + dy, MARGIN, Math.max(MARGIN, window.innerHeight - FAB_SIZE - MARGIN));
            toolbar.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
            toolbar.dataset.dragX = String(x);
            toolbar.dataset.dragY = String(y);
        });

        const endDrag = (e) => {
            if (pointerId === null || (e && e.pointerId !== pointerId)) return;
            try { fab.releasePointerCapture(pointerId); } catch { }
            pointerId = null;

            if (!dragging) return;

            const x = parseFloat(toolbar.dataset.dragX || '0');
            const y = parseFloat(toolbar.dataset.dragY || '0');
            // Snap to the nearer vertical edge, keep the vertical spot.
            fabPos = {
                side: (x + FAB_SIZE / 2) < window.innerWidth / 2 ? 'left' : 'right',
                yRatio: trackHeight() > 0 ? clamp((y - MARGIN) / trackHeight(), 0, 1) : 0
            };
            dragging = false;
            suppressNextClick = true;
            toolbar.classList.remove('dragging');
            applyFabPosition(true);
            savePosition();
            wake();
        };

        fab.addEventListener('pointerup', endDrag);
        fab.addEventListener('pointercancel', endDrag);
    }

    // ── Create toolbar DOM ──
    function createToolbar() {
        if (document.getElementById('ai-assistant-toolbar')) return;

        toolbar = document.createElement('div');
        toolbar.id = 'ai-assistant-toolbar';
        toolbar.innerHTML = `
            <div id="ai-assistant-menu" role="menu" aria-label="AI Assistant">
                <div class="ai-menu-header"><span class="ai-dot"></span>Assistant<span class="ai-rule"></span></div>
                <button class="ai-menu-item" role="menuitem" data-action="review">
                    <span class="ai-icon">${ICONS.pen}</span>
                    <span class="ai-label">Review</span>
                    <span class="ai-menu-shortcut">Grammar</span>
                </button>
                <button class="ai-menu-item" role="menuitem" data-action="translate">
                    <span class="ai-icon">${ICONS.globe}</span>
                    <span class="ai-label">Translate</span>
                    <span class="ai-menu-shortcut">Language</span>
                </button>
                <button class="ai-menu-item" role="menuitem" data-action="reply">
                    <span class="ai-icon">${ICONS.reply}</span>
                    <span class="ai-label">Reply</span>
                    <span class="ai-menu-shortcut">Suggest</span>
                </button>
                <button class="ai-menu-item" role="menuitem" data-action="summarize">
                    <span class="ai-icon">${ICONS.lines}</span>
                    <span class="ai-label">Summarize</span>
                    <span class="ai-menu-shortcut">Digest</span>
                </button>
                <div class="ai-menu-divider"></div>
                <button class="ai-menu-foot" id="ai-reset-position">${ICONS.target}<span>Reset position</span></button>
            </div>
            <span id="ai-assistant-hint">Drag to move</span>
            <button id="ai-assistant-fab" aria-label="AI Assistant">${ICONS.spark}</button>
        `;

        // Result card
        resultCard = document.createElement('div');
        resultCard.id = 'ai-result-card';
        resultCard.innerHTML = `
            <div class="ai-result-header">
                <span class="ai-dot"></span>
                <span class="ai-result-title">AI Result</span>
                <button class="ai-result-close" aria-label="Close">${ICONS.close}</button>
            </div>
            <div class="ai-result-body"></div>
            <div class="ai-result-actions">
                <button class="ai-result-btn ai-btn-copy">Copy</button>
                <button class="ai-result-btn ai-btn-use">Use</button>
            </div>
        `;

        document.body.appendChild(toolbar);
        document.body.appendChild(resultCard);

        applyFabPosition(false);

        // Event listeners
        const fab = toolbar.querySelector('#ai-assistant-fab');
        setupDrag(fab);

        fab.addEventListener('click', (e) => {
            e.stopPropagation();
            if (suppressNextClick) { // the press was a drag, not a tap
                suppressNextClick = false;
                return;
            }
            toggleMenu();
        });

        toolbar.addEventListener('pointerenter', wake);

        // Menu item clicks
        toolbar.querySelectorAll('.ai-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                handleAction(item.dataset.action);
            });
        });

        toolbar.querySelector('#ai-reset-position').addEventListener('click', (e) => {
            e.stopPropagation();
            fabPos = { side: 'right', yRatio: 0.8 };
            hideMenu();
            applyFabPosition(true);
            savePosition();
        });

        // Result card close
        resultCard.querySelector('.ai-result-close').addEventListener('click', () => {
            hideResultCard();
        });

        setupCardDrag();

        // Copy button
        resultCard.querySelector('.ai-btn-copy').addEventListener('click', () => {
            const text = currentActionText || resultCard.querySelector('.ai-result-body').textContent;
            navigator.clipboard.writeText(text).then(() => {
                const btn = resultCard.querySelector('.ai-btn-copy');
                btn.textContent = 'Copied';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            });
        });

        // Use button - paste into WhatsApp input
        resultCard.querySelector('.ai-btn-use').addEventListener('click', () => {
            const text = currentActionText || resultCard.querySelector('.ai-result-body').textContent;
            pasteIntoInput(text);
            hideResultCard();
        });

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (toolbar && !toolbar.contains(e.target)) {
                hideMenu();
            }
        });

        window.addEventListener('resize', () => {
            applyFabPosition(false);
            if (resultCard.classList.contains('visible')) positionResultCard();
        });

        wake();
        console.log('[ai-assistant] Toolbar DOM created and appended to body');
    }

    function updateShortcutLabel() {
        const fab = document.querySelector('#ai-assistant-fab');
        if (fab) fab.setAttribute('aria-label', `AI Assistant (${shortcutLabel})`);
        const hint = document.querySelector('#ai-assistant-hint');
        if (hint) hint.textContent = `${shortcutLabel} · drag to move`;
    }

    // ── Menu toggle ──
    function toggleMenu() {
        if (!toolbar) {
            console.warn('[ai-assistant] toggleMenu called but toolbar is null');
            return;
        }
        const menu = toolbar.querySelector('#ai-assistant-menu');
        const fab = toolbar.querySelector('#ai-assistant-fab');
        toolbarVisible = !toolbarVisible;

        if (toolbarVisible) {
            menu.classList.add('visible');
            fab.classList.add('active');
            toolbar.classList.add('menu-open', 'awake');
        } else {
            menu.classList.remove('visible');
            fab.classList.remove('active');
            toolbar.classList.remove('menu-open');
            wake();
        }
        if (resultCard.classList.contains('visible') && !cardMoved) positionResultCard();
        console.log('[ai-assistant] Menu toggled, visible:', toolbarVisible);
    }

    function hideMenu() {
        if (!toolbarVisible) return;
        toolbar.querySelector('#ai-assistant-menu').classList.remove('visible');
        toolbar.querySelector('#ai-assistant-fab').classList.remove('active');
        toolbar.classList.remove('menu-open');
        toolbarVisible = false;
        if (resultCard.classList.contains('visible') && !cardMoved) positionResultCard();
        wake();
    }

    // ── Result card ──
    // Anchored beside the button, on the side that has room, unless the user
    // dragged the card somewhere else.
    function positionResultCard() {
        // offsetWidth/Height, not getBoundingClientRect: the entrance animation
        // scales the card, which would skew a rect-based measurement.
        const w = resultCard.offsetWidth || 384;
        const h = resultCard.offsetHeight || 300;
        const { x, y } = currentXY();

        let left = fabPos.side === 'left'
            ? x + FAB_SIZE + 12
            : x - w - 12;
        if (left < MARGIN || left + w > window.innerWidth - MARGIN) {
            left = clamp(left, MARGIN, Math.max(MARGIN, window.innerWidth - w - MARGIN));
        }

        // Centred on the button, unless the menu is open — then sit on the
        // opposite side of the button so the two panels don't stack.
        let top = toolbarVisible
            ? (toolbar.classList.contains('open-up') ? y + FAB_SIZE + 12 : y - h - 12)
            : y + FAB_SIZE / 2 - h / 2;
        top = clamp(top, MARGIN, Math.max(MARGIN, window.innerHeight - h - MARGIN));

        // Near the top or bottom edge there may be no room above/below the menu;
        // step the card sideways past the menu instead of letting them overlap.
        if (toolbarVisible) {
            const menu = toolbar.querySelector('#ai-assistant-menu').getBoundingClientRect();
            const hits = (l, t) => l < menu.right && l + w > menu.left && t < menu.bottom && t + h > menu.top;
            if (hits(left, top)) {
                const alt = clamp(
                    fabPos.side === 'left' ? menu.right + 12 : menu.left - w - 12,
                    MARGIN,
                    Math.max(MARGIN, window.innerWidth - w - MARGIN)
                );
                if (!hits(alt, top)) left = alt;
            }
        }

        resultCard.style.left = `${Math.round(left)}px`;
        resultCard.style.top = `${Math.round(top)}px`;
    }

    function setupCardDrag() {
        const header = resultCard.querySelector('.ai-result-header');
        let pointerId = null, startX = 0, startY = 0, originLeft = 0, originTop = 0;

        header.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('.ai-result-close')) return;
            pointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            const rect = resultCard.getBoundingClientRect();
            originLeft = rect.left;
            originTop = rect.top;
            header.classList.add('grabbing');
            header.setPointerCapture(pointerId);
        });

        header.addEventListener('pointermove', (e) => {
            if (pointerId === null || e.pointerId !== pointerId) return;
            const rect = resultCard.getBoundingClientRect();
            const left = clamp(originLeft + (e.clientX - startX), 0, Math.max(0, window.innerWidth - rect.width));
            const top = clamp(originTop + (e.clientY - startY), 0, Math.max(0, window.innerHeight - rect.height));
            resultCard.style.left = `${Math.round(left)}px`;
            resultCard.style.top = `${Math.round(top)}px`;
            cardMoved = true;
        });

        const end = (e) => {
            if (pointerId === null || (e && e.pointerId !== pointerId)) return;
            try { header.releasePointerCapture(pointerId); } catch { }
            pointerId = null;
            header.classList.remove('grabbing');
        };

        header.addEventListener('pointerup', end);
        header.addEventListener('pointercancel', end);
    }

    function showResultCard(title, content, isLoading = false) {
        const titleEl = resultCard.querySelector('.ai-result-title');
        const bodyEl = resultCard.querySelector('.ai-result-body');
        const actionsEl = resultCard.querySelector('.ai-result-actions');

        titleEl.textContent = title;

        if (isLoading) {
            bodyEl.innerHTML = '<div class="ai-loading"><div class="ai-spinner"></div><span>Thinking</span></div>';
            actionsEl.style.display = 'none';
        } else {
            bodyEl.textContent = content;
            actionsEl.style.display = 'flex';
        }

        const wasVisible = resultCard.classList.contains('visible');
        resultCard.classList.add('visible');
        if (!wasVisible || !cardMoved) positionResultCard();
    }

    function showResultError(message) {
        const bodyEl = resultCard.querySelector('.ai-result-body');
        const actionsEl = resultCard.querySelector('.ai-result-actions');
        bodyEl.innerHTML = `<div class="ai-error">${ICONS.alert}<span>${escapeHtml(message)}</span></div>`;
        actionsEl.style.display = 'none';
        if (!cardMoved) positionResultCard();
    }

    function hideResultCard() {
        resultCard.classList.remove('visible');
        cardMoved = false;
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
            inputBox.textContent = '';
            document.execCommand('insertText', false, text);
            inputBox.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    // ── Handle AI action ──
    async function handleAction(action) {
        hideMenu();

        const text = getSelectedOrInputText();
        if (!text) {
            showResultCard('No Text', '');
            showResultError('Select some text or type a message in the input box first.');
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
                if (action === 'review') {
                    // Extract only the reviewed text (before "Changes:" line) for Copy/Use
                    const changesMatch = result.text.match(/^([\s\S]*?)(\n+changes:[\s\S]*)$/i);
                    currentActionText = changesMatch ? changesMatch[1].trim() : result.text;
                } else {
                    currentActionText = result.text;
                }
                showResultCard(actionLabels[action] || 'AI Result', result.text);
            } else {
                currentActionText = null;
                showResultError(result.error || 'An unknown error occurred.');
            }
        } catch (err) {
            currentActionText = null;
            showResultError(`Request failed: ${err.message}`);
        }
    }

    // ── Keyboard shortcut (DOM-level, secondary mechanism) ──
    function setupKeyboardShortcut() {
        document.addEventListener('keydown', (e) => {
            // Alt + configured key (default H)
            const codeMatch = e.code === `Key${shortcutKey.toUpperCase()}`;
            const keyMatch = e.key.toLowerCase() === shortcutKey.toLowerCase();
            if (e.altKey && (codeMatch || keyMatch)) {
                e.preventDefault();
                e.stopPropagation();
                toggleMenu();
            }

            // ESC to close
            if (e.key === 'Escape') {
                if (toolbarVisible) hideMenu();
                if (resultCard && resultCard.classList.contains('visible')) hideResultCard();
            }
        }, true); // capture phase
    }

    // ── Load initial settings ──
    async function loadSettings() {
        try {
            const settings = await ipcRenderer.invoke('ai-get-settings');
            if (settings && settings.shortcut) {
                const parts = settings.shortcut.split('+');
                shortcutKey = parts[parts.length - 1] || 'h';
                shortcutLabel = settings.shortcut;
                updateShortcutLabel();
            }
        } catch (err) {
            console.log('[ai-assistant] Could not load settings:', err.message);
        }

        try {
            const pos = await ipcRenderer.invoke('ai-get-fab-position');
            if (pos) {
                fabPos = normalizePos(pos);
                applyFabPosition(false);
            }
        } catch (err) {
            console.log('[ai-assistant] Could not load button position:', err.message);
        }
    }

    // ── Utility ──
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ── Initialize DOM elements ──
    function setup() {
        try {
            injectStyles();
            createToolbar();
            updateShortcutLabel();
            setupKeyboardShortcut();
            loadSettings();
            initialized = true;
            console.log('[ai-assistant] AI Assistant fully initialized');
        } catch (err) {
            console.error('[ai-assistant] Error during setup:', err);
        }
    }

    // Wait for body to exist, then inject
    function waitForBody() {
        if (document.body) {
            setup();
        } else {
            // Body not ready yet, observe until it is
            const observer = new MutationObserver(() => {
                if (document.body) {
                    observer.disconnect();
                    setup();
                }
            });
            observer.observe(document.documentElement, { childList: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForBody);
    } else {
        waitForBody();
    }
})();
