const { app, BrowserWindow, ipcMain, dialog, shell, session, WebContentsView, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { JsonDB, Config } = require('node-json-db');

// Initialize database for storing sessions
const db = new JsonDB(new Config("sessions", true, false, '/'));

class MultiBrowserApp {
    constructor() {
        this.mainWindow = null;
        this.sessionCounter = 0;
        this.browserViews = new Map(); // sessionId -> WebContentsView
        this.activeBrowserView = null;
        this.activeNotifications = new Map(); // sessionId -> notification objects
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
        app.whenReady().then(() => {
            // Ensure proper Windows notification activation routing
            try {
                app.setAppUserModelId('com.multibrowser.app');
            } catch { }

            // Check and log notification support
            console.log('🔔 Notification support:', Notification.isSupported());

            console.log('Electron version:', process.versions.electron);
            console.log('Chrome/Chromium version:', process.versions.chrome);
            console.log('Node version:', process.versions.node);
            this.createMainWindow();
            this.loadSavedSessions();
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

        // Show a first-class native notification we can handle clicks for
        ipcMain.on('show-native-notification', (event, payload) => {
            const sessionId = this.getSessionIdByWebContents(event.sender);
            const { title, options, url } = payload || {};

            console.log(`🔔 Creating native notification for session ${sessionId}: "${title}"`);
            console.log(`🔔 Notification options:`, options);
            console.log(`🔔 URL: ${url}`);

            try {
                const body = options?.body || '';
                const notification = new Notification({
                    title,
                    body,
                    silent: options?.silent === true,
                    icon: path.join(__dirname, 'assets', 'icon.png') // Add app icon to notification
                });

                // Handle notification click
                notification.on('click', () => {
                    console.log(`🔔 REAL NOTIFICATION CLICKED for session ${sessionId}`);
                    console.log(`🔔 Will focus session: ${sessionId}`);
                    this.handleNotificationClick(sessionId);

                    // Remove this notification from active notifications
                    this.activeNotifications.delete(sessionId);
                });

                // Handle notification close
                notification.on('close', () => {
                    console.log(`🔔 REAL NOTIFICATION CLOSED for session ${sessionId}`);
                    // Remove this notification from active notifications
                    this.activeNotifications.delete(sessionId);
                });

                // Store the notification for this session
                this.activeNotifications.set(sessionId, notification);

                notification.show();

                console.log(`🔔 REAL notification shown and tracked for session ${sessionId}`);

            } catch (err) {
                console.error('Failed to show native notification:', err);
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

            // Use the same Notification constructor that works in the show-native-notification handler
            const { Notification } = require('electron');
            const notification = new Notification({
                title: 'Test Notification',
                body: `Click to focus session: ${firstSessionId}`,
                icon: path.join(__dirname, 'assets', 'icon.png')
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

            // Bring window to front and focus it
            if (this.mainWindow.isMinimized()) {
                this.mainWindow.restore();
                console.log('🔄 Window restored from minimized state');
            }

            if (!this.mainWindow.isVisible()) {
                this.mainWindow.show();
                console.log('👁️ Window shown');
            }

            this.mainWindow.focus();
            this.mainWindow.setAlwaysOnTop(true);
            console.log('🎯 Window focused and set to always on top');

            // Remove always on top after a short delay to ensure focus
            setTimeout(() => {
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.setAlwaysOnTop(false);
                    console.log('🎯 Always on top removed');
                }
            }, 1000);

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

    createMainWindow() {
        this.mainWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                webSecurity: false,
                webviewTag: true // Enable webview tag
            },
            icon: path.join(__dirname, 'assets', 'icon.png'),
            title: 'Multi Browser Manager'
        });

        this.mainWindow.loadFile('index.html');

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
        this.mainWindow.on('resize', () => {
            if (this.activeBrowserView) {
                const bounds = this.mainWindow.getContentBounds();
                const tabBarHeight = 45;

                this.activeBrowserView.setBounds({
                    x: 0,
                    y: tabBarHeight,
                    width: bounds.width,
                    height: bounds.height - tabBarHeight
                });
            }
        });
    }

    setupIPC() {
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
                partition: partitionName
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

            const view = new WebContentsView({
                webPreferences: {
                    partition: partitionName,
                    nodeIntegration: false,
                    contextIsolation: true,
                    webSecurity: true,
                    preload: path.join(__dirname, 'preload', 'notifications.js')
                }
            });

            this.browserViews.set(sessionId, view);

            // Set up event handlers for the browser view
            this.setupBrowserViewEvents(view, sessionId, sessionData.name);

            // Configurar User Agent do Chrome para compatibilidade com WhatsApp Web
            const chromeUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
            view.webContents.setUserAgent(chromeUserAgent);

            // Load the URL
            view.webContents.loadURL(sessionData.url);

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

            // Set bounds to content area with more conservative positioning
            const bounds = this.mainWindow.getContentBounds();
            const tabBarHeight = 45; // Ensure tab bar is not covered
            const statusBarHeight = 30; // Ensure status bar is not covered

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

    setupBrowserViewEvents(view, sessionId, sessionName) {
        // Handle new window requests (target="_blank" links)
        view.webContents.setWindowOpenHandler(({ url, frameName, features, disposition }) => {
            console.log(`🔗 New window requested: ${url}`);
            console.log(`🔗 Disposition: ${disposition}`);

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
            // Allow normal navigation within the same view
        });

        // Handle external protocol requests (like mailto:, tel:, etc.)
        view.webContents.on('will-redirect', (event, redirectUrl) => {
            console.log(`🔄 Redirect to: ${redirectUrl}`);

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
            const fullPath = path.join(downloadsPath, fileName);

            // Ensure Downloads directory exists
            try {
                if (!require('fs').existsSync(downloadsPath)) {
                    require('fs').mkdirSync(downloadsPath, { recursive: true });
                }
            } catch (dirError) {
                console.error('Error creating downloads directory:', dirError);
            }

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
                            fileName: fileName,
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

    // Function to show file in Windows Explorer with highlight
    showFileInExplorer(filePath) {
        try {
            // Verify file exists before trying to show it
            if (!require('fs').existsSync(filePath)) {
                console.warn(`File does not exist: ${filePath}`);
                return;
            }

            // Use Windows shell command to show file in Explorer
            // /select flag highlights the specific file
            const { spawn } = require('child_process');
            const process = spawn('explorer', ['/select,', filePath], {
                detached: true,
                stdio: 'ignore'
            });

            process.unref(); // Allow the parent process to exit independently
            console.log(`📂 Opened Explorer for: ${filePath}`);
        } catch (error) {
            console.error('Error opening Explorer:', error);

            // Fallback: just open the directory
            try {
                const dirPath = require('path').dirname(filePath);
                shell.openPath(dirPath);
                console.log(`📂 Opened directory as fallback: ${dirPath}`);
            } catch (fallbackError) {
                console.error('Fallback also failed:', fallbackError);
            }
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
