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

    init() {
        app.whenReady().then(() => {
            console.log('Versões do sistema:');
            console.log('Electron:', process.versions.electron);
            console.log('Chrome/Chromium:', process.versions.chrome);
            console.log('Node:', process.versions.node);
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
                    webSecurity: true
                }
            });

            this.browserViews.set(sessionId, view);
            
            // Set up event handlers for the browser view
            this.setupBrowserViewEvents(view, sessionId);
            
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

    setupBrowserViewEvents(view, sessionId) {
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
            // Send title update to renderer
            this.mainWindow.webContents.send('page-title-updated', { sessionId, title });
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
