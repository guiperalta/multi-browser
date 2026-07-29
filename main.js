const { app, BrowserWindow, ipcMain, dialog, shell, session, WebContentsView, Notification, nativeImage, nativeTheme, Menu, MenuItem } = require('electron');

// Default spellchecker languages for new sessions. Multi-language: each session
// can override this with its own list (sessionData.spellLanguages).
const DEFAULT_SPELL_LANGUAGES = ['pt-BR', 'en-US'];
const path = require('path');
const fs = require('fs');
const { JsonDB, Config } = require('node-json-db');
const { createProvider } = require('./ai-provider');
const updater = require('./updater');

const LINUX_DESKTOP_NAME = 'multi-browser.desktop';
const LINUX_WM_CLASS = path.basename(LINUX_DESKTOP_NAME, '.desktop');

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('class', LINUX_WM_CLASS);

    // On Wayland, an app can only raise/focus itself when it holds an
    // xdg-activation token (e.g. one handed to it by a notification click).
    // That mechanism only exists in native Wayland mode — under XWayland the
    // compositor refuses the raise and just flashes the icon. Prefer native
    // Wayland when the session is Wayland so notification-click can focus the
    // window; fall back to X11 automatically otherwise.
    if (process.env.XDG_SESSION_TYPE === 'wayland') {
        app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
    }
}

// Get icon path - ensure absolute path for better reliability
function getIconPath() {
    const candidatePaths = [];
    const iconFileNames = ['icon-512x512.png', 'icon.png'];

    const addCandidates = (basePath) => {
        if (!basePath) {
            return;
        }

        for (const iconFileName of iconFileNames) {
            candidatePaths.push(path.join(basePath, 'assets', iconFileName));
        }
    };

    if (app.isPackaged) {
        addCandidates(process.resourcesPath);
    }

    try {
        addCandidates(app.getAppPath());
    } catch (e) {
        // app.getAppPath() might not be available yet
    }

    addCandidates(__dirname);

    for (const iconPath of candidatePaths) {
        if (fs.existsSync(iconPath)) {
            return path.resolve(iconPath);
        }
    }

    // If icon doesn't exist, return undefined (Electron will use default)
    console.warn('⚠️ Icon not found. Tried:', candidatePaths);
    return undefined;
}

// Get icon as nativeImage for better Linux support
function getIconNativeImage() {
    const iconPath = getIconPath();
    if (!iconPath) {
        return undefined;
    }
    try {
        const icon = nativeImage.createFromPath(iconPath);
        if (icon.isEmpty()) {
            console.warn('⚠️ Icon image is empty');
            return undefined;
        }
        return icon;
    } catch (error) {
        console.error('⚠️ Error loading icon:', error);
        return undefined;
    }
}

// Session metadata lives in the per-user app data directory. Older builds used
// a relative path, which wrote sessions.json into whatever the working
// directory happened to be (the repo in dev, $HOME for an installed .deb), so
// the first run here adopts any file left in those places.
function resolveDatabasePath() {
    const target = path.join(app.getPath('userData'), 'sessions.json');
    if (fs.existsSync(target)) return target;

    const legacyPaths = [
        path.join(process.cwd(), 'sessions.json'),
        path.join(__dirname, 'sessions.json'),
        path.join(app.getPath('home'), 'sessions.json')
    ];

    for (const legacy of legacyPaths) {
        if (legacy !== target && fs.existsSync(legacy)) {
            try {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(legacy, target);
                console.log(`📦 Migrated session data from ${legacy} to ${target}`);
                return target;
            } catch (error) {
                console.warn(`⚠️ Could not migrate ${legacy}: ${error.message}`);
            }
        }
    }
    return target;
}

// Initialize database for storing sessions (path without the .json suffix)
const db = new JsonDB(new Config(resolveDatabasePath().replace(/\.json$/, ''), true, false, '/'));

// Parse a WhatsApp link in any of its public forms and convert it to the
// equivalent WhatsApp Web URL, or return null if it isn't a WhatsApp link:
//   whatsapp://send/?phone=55...&text=...   (the "Open app" deep link)
//   https://wa.me/5511999999999?text=...
//   https://api.whatsapp.com/send/?phone=55...&text=...
function parseWhatsAppLink(rawUrl) {
    if (typeof rawUrl !== 'string') return null;

    let url;
    try {
        url = new URL(rawUrl.trim());
    } catch {
        return null;
    }

    let phone = null;
    let text = null;

    if (url.protocol === 'whatsapp:') {
        phone = url.searchParams.get('phone');
        text = url.searchParams.get('text');
    } else if (url.protocol === 'https:' || url.protocol === 'http:') {
        const host = url.hostname.replace(/^www\./, '');
        const pathname = url.pathname.replace(/\/+$/, '');

        if (host === 'wa.me') {
            if (/^\/\+?\d[\d\-\s]*$/.test(pathname)) {
                phone = pathname.slice(1);
            } else if (pathname === '/send' || pathname === '') {
                phone = url.searchParams.get('phone');
            } else {
                return null; // wa.me/message/<code> etc. — can't map to web.whatsapp.com
            }
            text = url.searchParams.get('text');
        } else if (host === 'api.whatsapp.com' || host === 'whatsapp.com') {
            if (pathname !== '/send') return null;
            phone = url.searchParams.get('phone');
            text = url.searchParams.get('text');
        } else {
            return null;
        }
    } else {
        return null;
    }

    phone = (phone || '').replace(/\D/g, '');
    if (phone.length < 5) return null;

    const target = new URL('https://web.whatsapp.com/send');
    target.searchParams.set('phone', phone);
    if (text) target.searchParams.set('text', text);
    return target.toString();
}

class MultiBrowserApp {
    constructor() {
        this.mainWindow = null;
        this.sessionCounter = 0;
        this.browserViews = new Map(); // sessionId -> WebContentsView
        this.activeBrowserView = null;
        this.activeNotifications = new Map(); // sessionId -> notification objects
        this.recentlyOpenedFolders = new Set(); // Track folders that were recently opened
        this.pendingSessionNavigations = new Map(); // sessionId -> URL to load once the view is created
        this.pendingUpdate = null; // release info from the last successful update check
        this.init();
    }

    // Resolve a sessionId from a WebContents reference
    getSessionIdByWebContents(webContents) {
        for (const [sid, view] of this.browserViews) {
            if (view && view.webContents === webContents) {
                return sid;
            }
        }
        return null;
    }

    init() {
        // Single instance: clicking a whatsapp:// link while the app is running
        // launches a second instance with the URL in argv — forward it to the
        // running instance instead of opening a second window.
        const gotLock = app.requestSingleInstanceLock();
        if (!gotLock) {
            app.quit();
            return;
        }

        app.on('second-instance', (_event, argv) => {
            const link = argv.find(arg => parseWhatsAppLink(arg));
            console.log(`📲 second-instance received${link ? ` with WhatsApp link: ${link}` : ''}`);
            if (link) {
                this.handleWhatsAppLink(link);
            } else if (this.mainWindow) {
                if (this.mainWindow.isMinimized()) this.mainWindow.restore();
                this.mainWindow.show();
                this.mainWindow.focus();
            }
        });

        // macOS delivers protocol URLs via open-url instead of argv
        app.on('open-url', (event, url) => {
            event.preventDefault();
            this.handleWhatsAppLink(url);
        });

        app.whenReady().then(() => {
            // Register as the OS handler for whatsapp:// deep links so the
            // "Open app" button on wa.me / api.whatsapp.com pages opens us.
            // (On Linux this needs the packaged .desktop file — see CLAUDE.md.)
            try {
                if (process.defaultApp) {
                    // Dev mode: point the handler at "electron <app path>"
                    if (process.argv.length >= 2) {
                        app.setAsDefaultProtocolClient('whatsapp', process.execPath, [path.resolve(process.argv[1])]);
                    }
                } else {
                    app.setAsDefaultProtocolClient('whatsapp');
                }
            } catch (error) {
                console.warn('⚠️ Could not register whatsapp:// protocol handler:', error.message);
            }

            // Ensure proper Windows notification activation routing
            try {
                app.setAppUserModelId('com.multibrowser.app');
            } catch { }

            // Restore the saved UI theme so native chrome (menus, dialogs,
            // form controls) matches the shell.
            this.getUITheme().then(theme => { nativeTheme.themeSource = theme; }).catch(() => { });

            // Set app icon (important for Linux taskbar/dock)
            const icon = getIconNativeImage();
            const iconPath = getIconPath();
            console.log('🖼️ App icon path:', iconPath);
            
            if (icon) {
                console.log('✅ Icon file found and loaded as nativeImage');
                // Set icon on app (works on Linux for taskbar/dock)
                if (process.platform === 'linux') {
                    // On Linux, the app icon is typically set via the window icon
                    // but we can also try setting it here
                    try {
                        app.dock?.setIcon(icon); // macOS
                    } catch (e) {
                        // Not macOS, continue
                    }
                }
            } else if (iconPath && fs.existsSync(iconPath)) {
                console.log('✅ Icon file found at path');
            } else {
                console.warn('⚠️ Icon file not found, using default Electron icon');
            }

            // Check and log notification support
            console.log('🔔 Notification support:', Notification.isSupported());

            console.log('Electron version:', process.versions.electron);
            console.log('Chrome/Chromium version:', process.versions.chrome);
            console.log('Node version:', process.versions.node);
            this.createMainWindow();
            this.loadSavedSessions();

            // Cold start from a WhatsApp link click: the URL arrives in argv.
            // Wait for the shell to load so the renderer can open the tab.
            const startupLink = process.argv.find(arg => parseWhatsAppLink(arg));
            if (startupLink) {
                console.log(`📲 Launched with WhatsApp link: ${startupLink}`);
                this.mainWindow.webContents.once('did-finish-load', () => {
                    setTimeout(() => this.handleWhatsAppLink(startupLink), 800);
                });
            }
        });

        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                this.cleanup();
                app.quit();
            }
        });

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                this.createMainWindow();
            }
        });

        this.setupIPC();

        // Notification IPC: map notifications back to sessions and log
        ipcMain.on('site-notification', (event, { title, options, url }) => {
            const sessionId = this.getSessionIdByWebContents(event.sender);
            console.log(`[Site notification] session=${sessionId || 'unknown'} title="${title}" body="${options?.body || ''}" url=${url}`);
            if (this.mainWindow) {
                this.mainWindow.webContents.send('site-notification', { sessionId, title, options, url });
            }
        });

        // The site's own notification was clicked: bring its window/tab to the
        // front. The page keeps showing the real notification and handles
        // conversation navigation itself; we only focus the right session.
        ipcMain.on('focus-session-from-notification', (event) => {
            const sessionId = this.getSessionIdByWebContents(event.sender);
            console.log(`🔔 Notification clicked for session ${sessionId}`);
            if (sessionId) {
                this.handleNotificationClick(sessionId);
            } else {
                console.warn('🔔 Could not resolve session for clicked notification');
            }
        });
    }

    // Test notification functionality
    testNotification() {
        console.log('🧪 Creating test notification...');

        try {
            // Get first available session for testing
            const firstSessionId = Array.from(this.browserViews.keys())[0];

            if (!firstSessionId) {
                console.log('🧪 No active sessions found for testing');
                return;
            }

            // Main-process notification used only for the Ctrl+T self-test.
            const { Notification } = require('electron');
            const notification = new Notification({
                title: 'Test Notification',
                body: `Click to focus session: ${firstSessionId}`,
                icon: getIconPath()
            });

            notification.on('click', () => {
                console.log(`🧪 Test notification clicked - focusing session ${firstSessionId}`);
                this.handleNotificationClick(firstSessionId);
                this.activeNotifications.delete(firstSessionId);
            });

            notification.on('close', () => {
                console.log('🧪 Test notification closed');
                this.activeNotifications.delete(firstSessionId);
            });

            this.activeNotifications.set(firstSessionId, notification);
            notification.show();

            console.log(`🧪 Test notification created for session ${firstSessionId}`);

        } catch (error) {
            console.error('🧪 Error creating test notification:', error);
        }
    }

    // Handle notification click events
    handleNotificationClick(sessionId) {
        console.log(`🎯 ========== NOTIFICATION CLICK HANDLER ==========`);
        console.log(`🎯 Session ID: ${sessionId}`);
        console.log(`🎯 Main window exists: ${!!this.mainWindow}`);
        console.log(`🎯 Main window destroyed: ${this.mainWindow ? this.mainWindow.isDestroyed() : 'N/A'}`);

        if (!this.mainWindow) {
            console.warn('Main window not available for notification click');
            return;
        }

        try {
            console.log(`🎯 Current window state:`);
            console.log(`   - Minimized: ${this.mainWindow.isMinimized()}`);
            console.log(`   - Visible: ${this.mainWindow.isVisible()}`);
            console.log(`   - Focused: ${this.mainWindow.isFocused()}`);

            // Bring window to front and focus it. Order matters and every step
            // runs unconditionally: an already-visible-but-occluded window still
            // needs show()/moveTop() — focus() alone is ignored by most Linux WMs.
            if (this.mainWindow.isMinimized()) {
                this.mainWindow.restore();
                console.log('🔄 Window restored from minimized state');
            }

            this.mainWindow.setAlwaysOnTop(true);
            this.mainWindow.show();   // re-maps + raises even when already visible
            this.mainWindow.focus();
            try { this.mainWindow.moveTop(); } catch { /* not supported on some WMs */ }
            console.log('🎯 Window shown, focused and raised');

            // Remove always on top shortly after so it doesn't stay pinned.
            setTimeout(() => {
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.setAlwaysOnTop(false);
                    console.log('🎯 Always on top removed');
                }
            }, 500);

            console.log('🎯 Window focused and brought to front');

            // Send focus command to renderer to switch to the correct session
            this.mainWindow.webContents.send('focus-session', {
                sessionId,
                source: 'notification-click'
            });

            console.log(`📨 Sent focus-session command for ${sessionId}`);
            console.log(`🎯 ===============================================`);

        } catch (error) {
            console.error('Error handling notification click:', error);
        }
    }

    // Route a WhatsApp link (whatsapp://, wa.me, api.whatsapp.com) to the
    // WhatsApp session's tab: convert it to a web.whatsapp.com/send URL,
    // navigate the session there and bring its tab to the front.
    async handleWhatsAppLink(rawUrl) {
        const targetUrl = parseWhatsAppLink(rawUrl);
        console.log(`📲 WhatsApp link: ${rawUrl} → ${targetUrl || 'not parseable'}`);
        if (!targetUrl) return false;

        const sessionId = await this.findWhatsAppSessionId();
        if (!sessionId) {
            console.warn('📲 No WhatsApp session found to receive the link');
            if (this.mainWindow) {
                this.mainWindow.show();
                this.mainWindow.focus();
                this.mainWindow.webContents.send('app-message', {
                    text: 'WhatsApp link received, but no WhatsApp session exists. Create one pointing to web.whatsapp.com.',
                    type: 'error'
                });
            }
            return false;
        }

        const view = this.browserViews.get(sessionId);
        if (view) {
            view.webContents.loadURL(targetUrl);
        } else {
            // Tab not open yet: remember the URL; createBrowserView will load
            // it instead of the session's start URL when the tab opens below.
            this.pendingSessionNavigations.set(sessionId, targetUrl);
        }

        // Raises the window and tells the renderer to open/switch to the tab
        this.handleNotificationClick(sessionId);
        return true;
    }

    // Pick the session that should receive WhatsApp links: the active view if
    // it's on WhatsApp Web, then any open WhatsApp view, then the most
    // recently used saved session whose URL points at WhatsApp.
    async findWhatsAppSessionId() {
        const isWhatsAppView = (view) => {
            try {
                return view.webContents.getURL().includes('web.whatsapp.com');
            } catch {
                return false;
            }
        };

        if (this.activeBrowserView && isWhatsAppView(this.activeBrowserView)) {
            return this.getSessionIdByWebContents(this.activeBrowserView.webContents);
        }

        for (const [sessionId, view] of this.browserViews) {
            if (isWhatsAppView(view)) return sessionId;
        }

        const sessions = await this.getSessions();
        sessions.sort((a, b) => new Date(b.lastAccessed) - new Date(a.lastAccessed));
        const match = sessions.find(s => (s.url || '').includes('whatsapp.com'));
        return match ? match.id : null;
    }

    createMainWindow() {
        // Get icon as nativeImage for better cross-platform support
        const icon = getIconNativeImage();
        const iconPath = getIconPath();
        
        if (icon) {
            console.log('✅ Using nativeImage icon:', iconPath);
            // Log icon size for debugging
            const size = icon.getSize();
            console.log(`📐 Icon size: ${size.width}x${size.height}`);
        } else {
            console.warn('⚠️ Using default icon');
        }

        this.mainWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                webSecurity: false,
                webviewTag: true // Enable webview tag
            },
            icon: icon || iconPath, // Use nativeImage if available, fallback to path
            title: `Multi Browser v${app.getVersion()}`,
            show: false // Don't show until ready
        });

        // Keep the version in the window title — otherwise index.html's <title>
        // would overwrite it once the shell loads.
        const windowTitle = `Multi Browser v${app.getVersion()}`;
        this.mainWindow.on('page-title-updated', (event) => {
            event.preventDefault();
            this.mainWindow.setTitle(windowTitle);
        });

        // Set icon explicitly (important for Linux)
        if (icon) {
            this.mainWindow.setIcon(icon);
            console.log('🖼️ Icon set explicitly on window');
        }

        this.mainWindow.loadFile(path.join(__dirname, 'index.html'));
        
        // Show window after icon is set
        this.mainWindow.once('ready-to-show', () => {
            this.mainWindow.show();
        });

        // Remove menu bar for cleaner look
        this.mainWindow.setMenuBarVisibility(false);

        // Open DevTools in development
        if (process.env.NODE_ENV === 'development') {
            this.mainWindow.webContents.openDevTools();
        }

        // Add keyboard shortcut to test notifications (Ctrl+T)
        this.mainWindow.webContents.on('before-input-event', (event, input) => {
            if (input.control && input.key.toLowerCase() === 't' && input.type === 'keyDown') {
                console.log('🧪 Testing notification...');
                this.testNotification();
            }
        });

        // Handle window resize to update browser view bounds
        this.statusBarVisible = false;

        this.updateBrowserViewBounds = () => {
            if (this.activeBrowserView) {
                const bounds = this.mainWindow.getContentBounds();
                const tabBarHeight = 45;
                const statusBarHeight = this.statusBarVisible ? 30 : 0;

                this.activeBrowserView.setBounds({
                    x: 0,
                    y: tabBarHeight,
                    width: bounds.width,
                    height: bounds.height - tabBarHeight - statusBarHeight
                });
            }
        };

        this.mainWindow.on('resize', this.updateBrowserViewBounds);
        this.mainWindow.on('maximize', this.updateBrowserViewBounds);
        this.mainWindow.on('unmaximize', this.updateBrowserViewBounds);
        this.mainWindow.on('restore', this.updateBrowserViewBounds);
    }

    setupIPC() {
        ipcMain.on('status-bar-visibility', (event, visible) => {
            this.statusBarVisible = visible;
            this.updateBrowserViewBounds();
        });

        ipcMain.handle('create-browser-session', async (event, config) => {
            return await this.createBrowserSession(config);
        });

        ipcMain.handle('get-sessions', async () => {
            return this.getSessions();
        });

        ipcMain.handle('delete-session', async (event, sessionId) => {
            return this.deleteSession(sessionId);
        });

        ipcMain.handle('get-session-partition', async (event, sessionId) => {
            return `persist:session-${sessionId}`;
        });

        ipcMain.handle('create-browser-view', async (event, sessionId) => {
            return await this.createBrowserView(sessionId);
        });

        ipcMain.handle('show-browser-view', async (event, sessionId) => {
            return this.showBrowserView(sessionId);
        });

        ipcMain.handle('hide-browser-view', async (event, sessionId) => {
            return this.hideBrowserView(sessionId);
        });

        ipcMain.handle('close-browser-view', async (event, sessionId) => {
            return this.closeBrowserView(sessionId);
        });

        ipcMain.handle('navigate-browser-view', async (event, sessionId, url) => {
            return this.navigateBrowserView(sessionId, url);
        });

        ipcMain.handle('rename-session', async (event, sessionId, newName) => {
            return this.renameSession(sessionId, newName);
        });

        ipcMain.handle('update-session-auto-open', async (event, sessionId, autoOpen) => {
            return this.updateSessionAutoOpen(sessionId, autoOpen);
        });

        ipcMain.handle('update-session-languages', async (event, sessionId, languages) => {
            return this.updateSessionLanguages(sessionId, languages);
        });

        ipcMain.handle('get-available-spellchecker-languages', async () => {
            try {
                return session.defaultSession.availableSpellCheckerLanguages || [];
            } catch {
                return [];
            }
        });

        ipcMain.handle('get-app-version', () => app.getVersion());

        // ── Updates (GitHub Releases) ──
        ipcMain.handle('updates-check', async () => {
            try {
                const info = await updater.checkForUpdate(await this.getGithubToken());
                this.pendingUpdate = info.installable ? info : null;
                return { success: true, ...info };
            } catch (error) {
                console.error('Update check failed:', error.message);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle('updates-download', async (event) => {
            if (!this.pendingUpdate) return { success: false, error: 'No update to download.' };
            try {
                const filePath = await updater.downloadAsset(this.pendingUpdate.asset, (progress) => {
                    try {
                        event.sender.send('updates-progress', progress);
                    } catch { }
                }, await this.getGithubToken());
                this.pendingUpdate.filePath = filePath;
                return { success: true, filePath };
            } catch (error) {
                console.error('Update download failed:', error.message);
                return { success: false, error: error.message };
            }
        });

        ipcMain.handle('updates-install', async () => {
            if (!this.pendingUpdate || !this.pendingUpdate.filePath) {
                return { success: false, error: 'Nothing downloaded yet.' };
            }
            return updater.installUpdate(this.pendingUpdate.filePath, this.pendingUpdate.format);
        });

        ipcMain.handle('updates-open-release', async () => {
            const url = this.pendingUpdate?.releaseUrl || updater.releasesUrl();
            await shell.openExternal(url);
            return { success: true };
        });

        // UI theme: 'system' | 'light' | 'dark'
        ipcMain.handle('get-ui-theme', async () => this.getUITheme());

        ipcMain.handle('save-ui-theme', async (event, theme) => this.saveUITheme(theme));

        // AI Assistant IPC handlers
        ipcMain.handle('ai-get-settings', async () => {
            return this.getAISettings();
        });

        ipcMain.handle('ai-save-settings', async (event, settings) => {
            return this.saveAISettings(settings);
        });

        ipcMain.handle('ai-request', async (event, { action, text }) => {
            return this.handleAIRequest(action, text);
        });

        // Floating AI button position (shared by every session view)
        ipcMain.handle('ai-get-fab-position', async () => {
            return this.getAIFabPosition();
        });

        ipcMain.handle('ai-save-fab-position', async (event, pos) => {
            return this.saveAIFabPosition(pos, event.sender);
        });
    }

    async createBrowserSession(config) {
        try {
            const sessionId = config.sessionId || `session_${Date.now()}_${++this.sessionCounter}`;

            // Create isolated session partition
            const partitionName = `persist:session-${sessionId}`;
            const sessionInstance = session.fromPartition(partitionName);

            // Configure session settings for better isolation
            sessionInstance.setPermissionRequestHandler((webContents, permission, callback) => {
                // Auto-grant basic permissions, you can customize this
                const allowedPermissions = ['notifications', 'geolocation', 'media'];
                callback(allowedPermissions.includes(permission));
            });

            // Save session info
            const sessionData = {
                id: sessionId,
                name: config.name || `Session ${this.sessionCounter}`,
                url: config.url || 'about:blank',
                autoOpen: false,
                created: new Date().toISOString(),
                lastAccessed: new Date().toISOString(),
                partition: partitionName,
                spellLanguages: Array.isArray(config.spellLanguages) && config.spellLanguages.length
                    ? config.spellLanguages
                    : DEFAULT_SPELL_LANGUAGES
            };

            await db.push(`/sessions/${sessionId}`, sessionData);

            return { success: true, sessionId, sessionData };
        } catch (error) {
            console.error('Error creating browser session:', error);
            return { success: false, error: error.message };
        }
    }

    async getSessions() {
        try {
            const sessions = await db.getData('/sessions');
            return Object.values(sessions || {});
        } catch (error) {
            return [];
        }
    }

    async deleteSession(sessionId) {
        try {
            // Remove from database
            await db.delete(`/sessions/${sessionId}`);

            // Clear the session partition data
            const partitionName = `persist:session-${sessionId}`;
            try {
                const sessionInstance = session.fromPartition(partitionName);
                await sessionInstance.clearStorageData();
            } catch (error) {
                console.log(`Could not clear session data for ${sessionId}:`, error.message);
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async loadSavedSessions() {
        // Initialize session partitions for existing sessions
        try {
            const sessions = await this.getSessions();
            for (const sessionData of sessions) {
                // Pre-initialize session partitions
                session.fromPartition(sessionData.partition || `persist:session-${sessionData.id}`);
            }
        } catch (error) {
            console.log('Error loading saved sessions:', error.message);
        }
    }

    async createBrowserView(sessionId) {
        try {
            const sessionData = await db.getData(`/sessions/${sessionId}`);
            const partitionName = sessionData.partition || `persist:session-${sessionId}`;

            // Apply this session's spellchecker languages to its partition before
            // the view loads, so the redline matches the language the user types in.
            this.applySpellCheckerLanguages(session.fromPartition(partitionName), sessionData.spellLanguages);

            const preloadPath = path.join(__dirname, 'preload', 'index.js');
            console.log('[ai] Creating browser view with preload:', preloadPath);

            const view = new WebContentsView({
                webPreferences: {
                    partition: partitionName,
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: false, // Required for preload require() in Electron 20+
                    webSecurity: true,
                    preload: preloadPath
                }
            });

            this.browserViews.set(sessionId, view);

            // Set up event handlers for the browser view
            this.setupBrowserViewEvents(view, sessionId, sessionData.name);

            // Configurar User Agent do Chrome para compatibilidade com WhatsApp Web
            const chromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
            view.webContents.setUserAgent(chromeUserAgent);

            // Load the URL (a routed WhatsApp link takes precedence over the
            // session's start URL — see handleWhatsAppLink)
            const pendingUrl = this.pendingSessionNavigations.get(sessionId);
            this.pendingSessionNavigations.delete(sessionId);
            view.webContents.loadURL(pendingUrl || sessionData.url);

            return { success: true, sessionId };
        } catch (error) {
            console.error('Error creating browser view:', error);
            return { success: false, error: error.message };
        }
    }

    showBrowserView(sessionId) {
        try {
            console.log('🔧 [main] showBrowserView called for', sessionId);
            const view = this.browserViews.get(sessionId);
            if (!view) {
                return { success: false, error: 'Browser view not found' };
            }

            // Hide current view first
            if (this.activeBrowserView && this.activeBrowserView !== view) {
                this.mainWindow.contentView.removeChildView(this.activeBrowserView);
            }

            // Add the new view
            this.mainWindow.contentView.addChildView(view);
            this.activeBrowserView = view;

            // Set bounds to content area
            const bounds = this.mainWindow.getContentBounds();
            const tabBarHeight = 45;
            const statusBarHeight = this.statusBarVisible ? 30 : 0;

            view.setBounds({
                x: 0,
                y: tabBarHeight,
                width: bounds.width,
                height: bounds.height - tabBarHeight - statusBarHeight
            });

            // Ensure the view is visible but not intercepting all events
            view.webContents.setZoomFactor(1.0);

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    hideBrowserView(sessionId) {
        try {
            console.log('🔧 [main] hideBrowserView called for', sessionId);
            const view = this.browserViews.get(sessionId);
            if (view && this.activeBrowserView === view) {
                this.mainWindow.contentView.removeChildView(view);
                this.activeBrowserView = null;
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    closeBrowserView(sessionId) {
        try {
            const view = this.browserViews.get(sessionId);
            if (view) {
                if (this.activeBrowserView === view) {
                    this.mainWindow.contentView.removeChildView(view);
                    this.activeBrowserView = null;
                }
                view.webContents.destroy();
                this.browserViews.delete(sessionId);
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    navigateBrowserView(sessionId, url) {
        try {
            const view = this.browserViews.get(sessionId);
            if (view) {
                // Configurar User Agent antes de navegar
                const chromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
                view.webContents.setUserAgent(chromeUserAgent);

                view.webContents.loadURL(url);
                return { success: true };
            }
            return { success: false, error: 'Browser view not found' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }


    async renameSession(sessionId, newName) {
        try {
            const sessionData = await db.getData(`/sessions/${sessionId}`);
            sessionData.name = newName;
            sessionData.lastAccessed = new Date().toISOString();

            await db.push(`/sessions/${sessionId}`, sessionData);

            console.log(`📝 Session ${sessionId} renamed to: ${newName}`);
            return { success: true, sessionData };
        } catch (error) {
            console.error('Error renaming session:', error);
            return { success: false, error: error.message };
        }
    }

    async updateSessionAutoOpen(sessionId, autoOpen) {
        try {
            const sessionData = await db.getData(`/sessions/${sessionId}`);
            sessionData.autoOpen = autoOpen;

            await db.push(`/sessions/${sessionId}`, sessionData);

            console.log(`📝 Session ${sessionId} auto-open set to: ${autoOpen}`);
            return { success: true, sessionData };
        } catch (error) {
            console.error('Error updating session auto-open:', error);
            return { success: false, error: error.message };
        }
    }

    // Set the Hunspell/spellchecker languages on a session partition. Multiple
    // languages are checked simultaneously (Linux/Windows). Unsupported codes are
    // dropped; macOS uses the OS spellchecker and ignores this entirely.
    applySpellCheckerLanguages(sessionInstance, languages) {
        try {
            const available = sessionInstance.availableSpellCheckerLanguages || [];
            const requested = (Array.isArray(languages) && languages.length) ? languages : DEFAULT_SPELL_LANGUAGES;
            let langs = requested.filter(l => available.includes(l));
            if (!langs.length) {
                langs = DEFAULT_SPELL_LANGUAGES.filter(l => available.includes(l));
            }
            if (langs.length) {
                sessionInstance.setSpellCheckerLanguages(langs);
                console.log(`🔤 Spellchecker languages set: ${langs.join(', ')}`);
            }
        } catch (error) {
            console.log('Could not set spellchecker languages:', error.message);
        }
    }

    async updateSessionLanguages(sessionId, languages) {
        try {
            const sessionData = await db.getData(`/sessions/${sessionId}`);
            sessionData.spellLanguages = Array.isArray(languages) && languages.length
                ? languages
                : DEFAULT_SPELL_LANGUAGES;

            await db.push(`/sessions/${sessionId}`, sessionData);

            // Apply live so the change takes effect without reopening the session.
            const partitionName = sessionData.partition || `persist:session-${sessionId}`;
            this.applySpellCheckerLanguages(session.fromPartition(partitionName), sessionData.spellLanguages);

            console.log(`📝 Session ${sessionId} languages set to: ${sessionData.spellLanguages.join(', ')}`);
            return { success: true, sessionData };
        } catch (error) {
            console.error('Error updating session languages:', error);
            return { success: false, error: error.message };
        }
    }

    setupBrowserViewEvents(view, sessionId, sessionName) {
        // Intercept AI Assistant keyboard shortcut at the Electron level
        // This fires before the page gets the event, so it can't be blocked
        view.webContents.on('before-input-event', async (event, input) => {
            if (input.type !== 'keyDown' || !input.alt || input.control || input.meta) return;

            // Read configured shortcut key (default 'H')
            let targetKey = 'h';
            try {
                const settings = await this.getAISettings();
                if (settings.shortcut) {
                    const parts = settings.shortcut.split('+');
                    targetKey = (parts[parts.length - 1] || 'h').toLowerCase();
                }
            } catch { }

            const codeMatch = input.code === `Key${targetKey.toUpperCase()}`;
            const keyMatch = input.key.toLowerCase() === targetKey;

            if (codeMatch || keyMatch) {
                console.log(`[ai] Alt+${targetKey.toUpperCase()} intercepted for session ${sessionId}`);
                event.preventDefault();
                view.webContents.send('ai-toggle-toolbar');
            }
        });

        // Native right-click menu: spelling suggestions for the misspelled word
        // under the cursor, plus standard editing actions. Without this handler
        // there is no context menu at all (Electron ships none by default).
        view.webContents.on('context-menu', (event, params) => {
            const menu = new Menu();

            if (params.misspelledWord) {
                for (const suggestion of params.dictionarySuggestions.slice(0, 6)) {
                    menu.append(new MenuItem({
                        label: suggestion,
                        click: () => view.webContents.replaceMisspelling(suggestion)
                    }));
                }
                if (params.dictionarySuggestions.length === 0) {
                    menu.append(new MenuItem({ label: 'No spelling suggestions', enabled: false }));
                }
                menu.append(new MenuItem({
                    label: `Add "${params.misspelledWord}" to dictionary`,
                    click: () => view.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
                }));
                menu.append(new MenuItem({ type: 'separator' }));
            }

            const ef = params.editFlags;
            if (params.isEditable || params.selectionText) {
                menu.append(new MenuItem({ role: 'cut', enabled: ef.canCut }));
                menu.append(new MenuItem({ role: 'copy', enabled: ef.canCopy }));
                menu.append(new MenuItem({ role: 'paste', enabled: ef.canPaste }));
                menu.append(new MenuItem({ type: 'separator' }));
                menu.append(new MenuItem({ role: 'selectAll' }));
            }

            if (menu.items.length > 0) {
                menu.popup({ window: this.mainWindow });
            }
        });

        // Handle new window requests (target="_blank" links)
        view.webContents.setWindowOpenHandler(({ url, frameName, features, disposition }) => {
            console.log(`🔗 New window requested: ${url}`);
            console.log(`🔗 Disposition: ${disposition}`);

            // WhatsApp links open in the WhatsApp tab, not the system browser
            if (parseWhatsAppLink(url)) {
                this.handleWhatsAppLink(url);
                return { action: 'deny' };
            }

            // Open external links in system browser
            if (disposition === 'new-window' || disposition === 'foreground-tab' || disposition === 'background-tab') {
                console.log(`🌐 Opening ${url} in system browser`);
                shell.openExternal(url);

                // Notify user that link opened externally
                this.mainWindow.webContents.send('external-link-opened', { url });

                return { action: 'deny' }; // Prevent opening in app
            }

            // For other cases, allow opening in app
            return { action: 'allow' };
        });

        // Handle navigation events
        view.webContents.on('will-navigate', (event, navigationUrl) => {
            console.log(`🧭 Navigation to: ${navigationUrl}`);

            // Route WhatsApp links to the WhatsApp tab (web.whatsapp.com
            // itself doesn't match, so the WhatsApp session navigates freely)
            if (parseWhatsAppLink(navigationUrl)) {
                event.preventDefault();
                this.handleWhatsAppLink(navigationUrl);
            }
        });

        // Handle external protocol requests (like mailto:, tel:, etc.)
        view.webContents.on('will-redirect', (event, redirectUrl) => {
            console.log(`🔄 Redirect to: ${redirectUrl}`);

            if (parseWhatsAppLink(redirectUrl)) {
                event.preventDefault();
                this.handleWhatsAppLink(redirectUrl);
                return;
            }

            // Check if it's an external protocol
            if (redirectUrl.startsWith('mailto:') ||
                redirectUrl.startsWith('tel:') ||
                redirectUrl.startsWith('sms:') ||
                redirectUrl.startsWith('skype:')) {
                event.preventDefault();
                shell.openExternal(redirectUrl);
                console.log(`📱 Opened external protocol: ${redirectUrl}`);
            }
        });

        // Handle file downloads
        view.webContents.session.on('will-download', (event, item, webContents) => {
            console.log(`📥 Download started: ${item.getFilename()}`);
            console.log(`📥 Original URL: ${item.getURL()}`);
            console.log(`📥 File size: ${item.getTotalBytes()} bytes`);

            // Set download path to user's Downloads folder
            const os = require('os');
            const downloadsPath = path.join(os.homedir(), 'Downloads');
            const fileName = item.getFilename();

            // Ensure Downloads directory exists
            try {
                if (!fs.existsSync(downloadsPath)) {
                    fs.mkdirSync(downloadsPath, { recursive: true });
                }
            } catch (dirError) {
                console.error('Error creating downloads directory:', dirError);
            }

            // Get a unique filename if the file already exists
            const fullPath = this.getUniqueFilePath(downloadsPath, fileName);
            const finalFileName = path.basename(fullPath);
            item.setSavePath(fullPath);
            console.log(`📥 Download will be saved to: ${fullPath}`);

            // Handle download completion
            item.once('done', (event, state) => {
                if (state === 'completed') {
                    console.log(`✅ Download completed: ${fullPath}`);

                    // Show file in Explorer with highlight
                    this.showFileInExplorer(fullPath);

                    // Notify user
                    if (this.mainWindow) {
                        this.mainWindow.webContents.send('download-completed', {
                            sessionId: sessionId,
                            sessionName: sessionName,
                            fileName: finalFileName,
                            filePath: fullPath
                        });
                    }
                } else if (state === 'cancelled') {
                    console.log(`❌ Download cancelled: ${fileName}`);
                } else if (state === 'interrupted') {
                    console.log(`⚠️ Download interrupted: ${fileName}`);
                }
            });

            // Handle download progress (optional)
            item.on('updated', (event, state) => {
                if (state === 'progressing') {
                    if (item.isPaused()) {
                        console.log(`⏸️ Download paused: ${fileName}`);
                    } else {
                        const progress = Math.round((item.getReceivedBytes() / item.getTotalBytes()) * 100);
                        if (progress % 25 === 0) { // Log every 25%
                            console.log(`📥 Download progress: ${fileName} - ${progress}%`);
                        }
                    }
                }
            });
        });

        // Handle page title updates
        view.webContents.on('page-title-updated', (event, title) => {
            console.log(`📄 Page title updated for session ${sessionId}: ${title}`);

            // Extract unread message count from title
            const unreadCount = this.extractUnreadCount(title);

            // Send title update to renderer with unread count
            this.mainWindow.webContents.send('page-title-updated', {
                sessionId,
                title,
                unreadCount
            });
        });

        // Handle favicon updates
        view.webContents.on('page-favicon-updated', (event, favicons) => {
            if (favicons.length > 0) {
                console.log(`🎯 Favicon updated for session ${sessionId}: ${favicons[0]}`);
                // Send favicon update to renderer
                this.mainWindow.webContents.send('page-favicon-updated', { sessionId, favicon: favicons[0] });
                // Remember it so the home screen can show it before the
                // session has been opened again.
                this.saveSessionFavicon(sessionId, favicons[0]);
            }
        });

        // Handle crashes
        view.webContents.on('crashed', (event, killed) => {
            console.error(`💥 WebContents crashed for session ${sessionId}. Killed: ${killed}`);
        });

        // Handle unresponsive pages
        view.webContents.on('unresponsive', () => {
            console.warn(`⏳ WebContents unresponsive for session ${sessionId}`);
        });

        view.webContents.on('responsive', () => {
            console.log(`✅ WebContents responsive again for session ${sessionId}`);
        });
    }

    // Function to extract unread message count from page title
    extractUnreadCount(title) {
        if (!title) return 0;

        // WhatsApp Web patterns:
        // "(5) WhatsApp" - 5 unread messages
        // "WhatsApp" - no unread messages
        // "(99+) WhatsApp" - 99+ unread messages

        // Look for pattern like "(number)" or "(number+)" at the beginning
        const match = title.match(/^\((\d+\+?)\)/);

        if (match) {
            const count = match[1];
            // Return the count as string to preserve "+" if present
            return count;
        }

        // Also check for other common patterns like "5 WhatsApp" or "WhatsApp (5)"
        const altMatch = title.match(/(\d+\+?)\s+\w+/) || title.match(/\w+\s+\((\d+\+?)\)/);
        if (altMatch) {
            return altMatch[1];
        }

        return 0; // No unread messages found
    }

    // Function to get a unique file path by appending (1), (2), etc. if file exists
    getUniqueFilePath(directory, fileName) {
        const filePath = path.join(directory, fileName);
        
        // If file doesn't exist, return the original path
        if (!fs.existsSync(filePath)) {
            return filePath;
        }

        // Parse filename and extension
        const ext = path.extname(fileName);
        const baseName = path.basename(fileName, ext);
        
        // Try appending (1), (2), etc. until we find a unique name
        let counter = 1;
        let newFileName;
        let newFilePath;
        
        do {
            newFileName = `${baseName} (${counter})${ext}`;
            newFilePath = path.join(directory, newFileName);
            counter++;
        } while (fs.existsSync(newFilePath));
        
        console.log(`📁 File already exists, using: ${newFileName}`);
        return newFilePath;
    }

    // Function to show file in file manager (cross-platform) with file highlighting
    showFileInExplorer(filePath) {
        try {
            // Verify file exists before trying to show it
            if (!fs.existsSync(filePath)) {
                console.warn(`File does not exist: ${filePath}`);
                return;
            }

            // Get the directory path
            const dirPath = path.dirname(filePath);
            
            // Check if we've recently opened this folder (within last 2 seconds)
            // This prevents re-opening if a file manager is already open
            if (this.recentlyOpenedFolders.has(dirPath)) {
                console.log(`📂 Folder already opened recently, skipping: ${dirPath}`);
                return;
            }

            const { spawn } = require('child_process');
            const platform = process.platform;

            // Use platform-specific commands to ensure file is highlighted
            if (platform === 'win32') {
                // Windows: Use explorer with /select to highlight the file
                const proc = spawn('explorer', ['/select,', filePath], {
                    detached: true,
                    stdio: 'ignore'
                });
                proc.unref();
                console.log(`📂 Opened Explorer with file highlighted: ${filePath}`);
            } else if (platform === 'darwin') {
                // macOS: Use open -R to reveal and highlight the file
                const proc = spawn('open', ['-R', filePath], {
                    detached: true,
                    stdio: 'ignore'
                });
                proc.unref();
                console.log(`📂 Opened Finder with file highlighted: ${filePath}`);
            } else {
                // Linux: Try file manager-specific commands for highlighting
                // Try common file managers with --select flag
                const fileManagers = [
                    { cmd: 'nautilus', args: ['--select', filePath] },      // GNOME
                    { cmd: 'dolphin', args: ['--select', filePath] },      // KDE
                    { cmd: 'thunar', args: ['--select', filePath] },       // XFCE
                    { cmd: 'pcmanfm', args: ['--select', filePath] },      // LXDE
                    { cmd: 'nemo', args: ['--select', filePath] }           // Cinnamon
                ];

                // Try each file manager sequentially
                let opened = false;
                for (const fm of fileManagers) {
                    try {
                        const proc = spawn(fm.cmd, fm.args, {
                            detached: true,
                            stdio: 'ignore'
                        });
                        
                        // Check if process started successfully
                        proc.on('error', (err) => {
                            // File manager not found, will try next one
                            if (!opened) {
                                // Only log if we haven't opened one yet
                            }
                        });
                        
                        // If no immediate error, assume it worked
                        // (spawn doesn't wait for process to actually start)
                        proc.unref();
                        opened = true;
                        console.log(`📂 Opened ${fm.cmd} with file highlighted: ${filePath}`);
                        break;
                    } catch (e) {
                        // Continue to next file manager if spawn fails
                        continue;
                    }
                }

                // Fallback to Electron's API if no specific file manager worked
                // shell.showItemInFolder should highlight on most Linux systems
                if (!opened) {
                    shell.showItemInFolder(filePath);
                    console.log(`📂 Opened file manager (fallback) for: ${filePath}`);
                }
            }
            
            // Track that we opened this folder
            this.recentlyOpenedFolders.add(dirPath);
            
            // Remove from tracking after 2 seconds to allow reopening if needed
            setTimeout(() => {
                this.recentlyOpenedFolders.delete(dirPath);
            }, 2000);
        } catch (error) {
            console.error('Error opening file manager:', error);

            // Fallback: use Electron's API
            try {
                shell.showItemInFolder(filePath);
                console.log(`📂 Opened file manager (fallback) for: ${filePath}`);
            } catch (fallbackError) {
                console.error('Fallback also failed:', fallbackError);
            }
        }
    }

    // ── AI Assistant Methods ──

    async getAISettings() {
        try {
            return await db.getData('/ai-settings');
        } catch {
            // Return defaults if not yet configured
            return {
                provider: 'claude-cli',
                claudeApiKey: '',
                openaiApiKey: '',
                openrouterApiKey: '',
                claudeModel: 'claude-sonnet-4-6-20250514',
                openaiModel: 'gpt-4o',
                openrouterModel: 'openai/gpt-4o',
                targetLanguage: 'English',
                shortcut: 'Alt+H'
            };
        }
    }

    async saveAISettings(settings) {
        try {
            await db.push('/ai-settings', settings);

            // Notify all browser views about updated shortcut
            for (const [, view] of this.browserViews) {
                try {
                    view.webContents.send('ai-update-shortcut', settings.shortcut);
                } catch { }
            }

            console.log('AI settings saved');
            return { success: true };
        } catch (error) {
            console.error('Error saving AI settings:', error);
            return { success: false, error: error.message };
        }
    }

    async saveSessionFavicon(sessionId, favicon) {
        try {
            const current = await db.getData(`/sessions/${sessionId}/favicon`).catch(() => null);
            if (current === favicon) return;
            await db.push(`/sessions/${sessionId}/favicon`, favicon);
        } catch (error) {
            console.log(`Could not store favicon for ${sessionId}: ${error.message}`);
        }
    }

    async getUITheme() {
        try {
            return await db.getData('/ui-theme');
        } catch {
            return 'system';
        }
    }

    async saveUITheme(theme) {
        const allowed = ['system', 'light', 'dark'];
        const clean = allowed.includes(theme) ? theme : 'system';
        try {
            await db.push('/ui-theme', clean);
            nativeTheme.themeSource = clean;
            return { success: true, theme: clean };
        } catch (error) {
            console.error('Error saving UI theme:', error);
            return { success: false, error: error.message };
        }
    }

    // Optional: only needed while the repo is private.
    async getGithubToken() {
        try {
            const settings = await this.getAISettings();
            return (settings.githubToken || '').trim() || null;
        } catch {
            return null;
        }
    }

    async getAIFabPosition() {
        try {
            return await db.getData('/ai-fab-position');
        } catch {
            // Default: clinging to the right edge, low on the screen.
            return { side: 'right', yRatio: 0.8 };
        }
    }

    async saveAIFabPosition(pos, sender) {
        try {
            const clean = {
                side: pos && pos.side === 'left' ? 'left' : 'right',
                yRatio: Math.min(1, Math.max(0, Number(pos && pos.yRatio) || 0))
            };
            await db.push('/ai-fab-position', clean);

            // Keep the button in the same spot across every open session view.
            for (const [, view] of this.browserViews) {
                try {
                    if (sender && view.webContents.id === sender.id) continue;
                    view.webContents.send('ai-fab-position-changed', clean);
                } catch { }
            }

            return { success: true };
        } catch (error) {
            console.error('Error saving AI button position:', error);
            return { success: false, error: error.message };
        }
    }

    async handleAIRequest(action, text) {
        try {
            const settings = await this.getAISettings();
            const provider = createProvider(settings);
            const result = await provider.sendRequest(action, text, {
                targetLanguage: settings.targetLanguage || 'English'
            });
            return { success: true, text: result };
        } catch (error) {
            console.error('AI request error:', error);
            return { success: false, error: error.message };
        }
    }

    cleanup() {
        // Clean up browser views
        for (const [sessionId, view] of this.browserViews) {
            try {
                view.webContents.destroy();
            } catch (error) {
                console.log(`Could not destroy view for session ${sessionId}`);
            }
        }
        this.browserViews.clear();

        // Clean up active notifications
        for (const [sessionId, notification] of this.activeNotifications) {
            try {
                notification.close();
            } catch (error) {
                console.log(`Could not close notification for session ${sessionId}`);
            }
        }
        this.activeNotifications.clear();

        console.log('Cleaning up Multi Browser Manager...');
    }
}

new MultiBrowserApp();
