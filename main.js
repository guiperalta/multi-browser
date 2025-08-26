const { app, BrowserWindow, ipcMain, dialog, shell, session, WebContentsView } = require('electron');
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
            } catch {}
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
            try {
                const body = options?.body || '';
                new Notification({ title, body, silent: options?.silent === true }).show();
            } catch (err) {
                console.error('Failed to show native notification:', err);
            }
            // Track sender to focus on click via a single-use channel
            this._lastNotificationSessionId = sessionId;
        });

        ipcMain.on('site-notification-click', (event) => {
            // Prefer explicit mapping stored when we showed the native notification
            const sessionId = this._lastNotificationSessionId || this.getSessionIdByWebContents(event.sender);
            if (!sessionId) return;
            // Bring window to front and ask renderer to focus the session tab
            if (this.mainWindow) {
                // On Windows ensure the window is restored and focused
                if (this.mainWindow.isMinimized()) this.mainWindow.restore();
                this.mainWindow.show();
                this.mainWindow.focus();
                this.mainWindow.webContents.send('focus-session', { sessionId });
            }
            this._lastNotificationSessionId = undefined;
        });
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
            
            view.setBounds({ 
                x: 0,
                y: tabBarHeight,
                width: bounds.width, 
                height: bounds.height - tabBarHeight
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
        console.log('Cleaning up Multi Browser Manager...');
    }
}

new MultiBrowserApp();
