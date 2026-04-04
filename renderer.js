const { ipcRenderer } = require('electron');

class MultiBrowserUI {
    constructor() {
        this.activeTabs = new Map(); // sessionId -> tab element
        this.activeTabId = 'welcome';
        this.sessions = new Map(); // sessionId -> session data
        this.originalSessionNames = new Map(); // sessionId -> original user-defined name
        this.modalOpen = false;
        this.previousActiveTab = null;
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.loadSessions();

        // Test if webview is supported
        console.log('Webview support:', typeof document.createElement('webview'));

        // Log any errors
        window.addEventListener('error', (e) => {
            console.error('Global error:', e.error);
        });

        // Listen for page title updates from main process
        ipcRenderer.on('page-title-updated', (event, { sessionId, title, unreadCount }) => {
            this.updateTabTitleWithUnreadCount(sessionId, title, unreadCount);
        });

        // Listen for favicon updates from main process
        ipcRenderer.on('page-favicon-updated', (event, { sessionId, favicon }) => {
            this.updateTabFavicon(sessionId, favicon);
        });

        // Listen for external link notifications
        ipcRenderer.on('external-link-opened', (event, { url }) => {
            const domain = new URL(url).hostname;
            this.showNotification(`Link opened in system browser: ${domain}`, 'info');
        });

        // Log any site notifications forwarded from main
        ipcRenderer.on('site-notification', (_e, { sessionId, title, options, url }) => {
            console.log(`[Site notification][${sessionId || 'unknown'}] ${title} | ${options?.body || ''} | ${url}`);
        });

        // Focus a specific session when a system notification is clicked
        ipcRenderer.on('focus-session', async (_e, { sessionId, source }) => {
            console.log(`🎯 Focus session request received: ${sessionId} (source: ${source || 'unknown'})`);

            if (!sessionId) {
                console.warn('No sessionId provided for focus-session');
                return;
            }

            try {
                // Check if session exists
                const sessionData = this.sessions.get(sessionId);
                if (!sessionData) {
                    console.warn(`Session ${sessionId} not found in active sessions`);
                    // Try to load sessions first
                    await this.loadSessions();
                }

                // Check if the tab is already open
                if (this.activeTabs.has(sessionId)) {
                    console.log(`📑 Session ${sessionId} tab already open, switching to it`);
                    await this.switchToTab(sessionId);
                } else {
                    console.log(`📑 Opening new tab for session ${sessionId}`);
                    await this.openSessionTab(sessionId);
                    await this.switchToTab(sessionId);
                }

                // Show a brief notification that we switched to the session
                const sessionName = this.originalSessionNames.get(sessionId) || sessionData?.name || 'Unknown Session';
                this.showNotification(`Switched to: ${sessionName}`, 'info');

                console.log(`✅ Successfully focused session ${sessionId}`);

            } catch (err) {
                console.error('Failed to focus session from notification click:', err);
                this.showNotification('Failed to switch to session', 'error');
            }
        });

        // Handle download completion notifications
        ipcRenderer.on('download-completed', (event, { sessionId, sessionName, fileName, filePath }) => {
            console.log(`📥 Download completed in session ${sessionId} (${sessionName}): ${fileName}`);
            const message = `File downloaded: ${fileName}`;
            this.showNotification(message, 'success');

            // Also log the full path for debugging
            console.log(`📂 File saved to: ${filePath}`);
        });
    }

    setupEventListeners() {
        // Modal controls
        const newTabBtn = document.getElementById('newTabBtn');
        const createFirstSession = document.getElementById('createFirstSession');
        const closeModal = document.getElementById('closeModal');
        const cancelSession = document.getElementById('cancelSession');
        const sessionModal = document.getElementById('sessionModal');

        newTabBtn.addEventListener('click', async () => {
            console.log('🔧 New Tab button clicked (tab bar)');
            await this.showCreateSessionModal();
        });
        createFirstSession.addEventListener('click', async () => {
            console.log('🔧 Create First Session button clicked (welcome)');
            await this.showCreateSessionModal();
        });
        closeModal.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('🔧 Close modal button clicked');
            await this.hideCreateSessionModal();
        });
        cancelSession.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('🔧 Cancel button clicked');
            await this.hideCreateSessionModal();
        });

        // Welcome tab click handler
        const welcomeTab = document.querySelector('.welcome-tab');
        if (welcomeTab) {
            welcomeTab.addEventListener('click', () => {
                this.switchToTab('welcome');
            });
        }

        // Close modal when clicking outside
        sessionModal.addEventListener('click', async (e) => {
            if (e.target === sessionModal) {
                await this.hideCreateSessionModal();
            }
        });

        // Form submission
        const form = document.getElementById('createSessionForm');
        form.addEventListener('submit', (e) => this.handleCreateSession(e));

        // ESC key to close modal
        document.addEventListener('keydown', async (e) => {
            if (e.key === 'Escape' && sessionModal.classList.contains('show')) {
                await this.hideCreateSessionModal();
            }
        });

        // Setup rename modal
        this.setupRenameModal();

        // AI Settings modal
        this.setupAISettingsModal();
    }

    async showCreateSessionModal() {
        console.log('🔧 Attempting to show create session modal');
        const modal = document.getElementById('sessionModal');
        if (!modal) {
            console.error('❌ Modal element not found!');
            return;
        }

        // Store current active tab and hide browser view
        this.previousActiveTab = this.activeTabId;
        this.modalOpen = true;

        console.log(`🔧 Current active tab: ${this.activeTabId}, storing as previous: ${this.previousActiveTab}`);

        // Hide any active browser view to prevent it from covering the modal
        if (this.activeTabId && this.activeTabId !== 'welcome') {
            console.log('🔧 Hiding browser view before showing modal');
            try {
                await ipcRenderer.invoke('hide-browser-view', this.activeTabId);
            } catch (error) {
                console.log('Error hiding browser view:', error);
            }
        } else {
            console.log('🔧 No browser view to hide (on welcome tab)');
        }

        console.log('✅ Modal element found, adding show class');
        modal.classList.add('show');

        // Force the modal to be on top with extreme z-index
        modal.style.zIndex = '999999999';
        modal.style.display = 'flex';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100vw';
        modal.style.height = '100vh';

        // Force all form inputs to be accessible
        const nameInput = document.getElementById('sessionName');
        const urlInput = document.getElementById('sessionUrl');
        const allInputs = [nameInput, urlInput].filter(Boolean);

        allInputs.forEach(input => {
            // Force maximum z-index and ensure accessibility
            input.style.cssText = `
                z-index: 2147483647 !important;
                pointer-events: all !important;
                position: relative !important;
                background: white !important;
                border: 2px solid #e1e5e9 !important;
                opacity: 1 !important;
                visibility: visible !important;
            `;
            input.disabled = false;
            input.readOnly = false;
            input.tabIndex = 0;
        });

        if (nameInput) {
            setTimeout(() => {
                nameInput.focus();
                nameInput.select();
                console.log('🔧 Input field focused and selected');
                console.log('🔧 Input computed style:', window.getComputedStyle(nameInput).pointerEvents);
                console.log('🔧 Input z-index:', window.getComputedStyle(nameInput).zIndex);
            }, 200);
        }

        console.log('✅ Modal should now be visible with maximum z-index');
    }

    async hideCreateSessionModal() {
        console.log('🔧 Hiding modal and restoring UI');
        const modal = document.getElementById('sessionModal');

        // Remove the show class and reset styles
        modal.classList.remove('show');
        modal.style.display = 'none';
        modal.style.zIndex = '';

        document.getElementById('createSessionForm').reset();

        this.modalOpen = false;

        // Restore the browser view if we had one active
        console.log(`🔧 Previous active tab was: ${this.previousActiveTab}`);
        if (this.previousActiveTab && this.previousActiveTab !== 'welcome') {
            console.log('🔧 Restoring browser view after hiding modal');
            try {
                await ipcRenderer.invoke('show-browser-view', this.previousActiveTab);
                console.log('✅ Browser view restored successfully');
            } catch (error) {
                console.log('Error restoring browser view:', error);
            }
        } else {
            console.log('🔧 No browser view to restore (was on welcome tab)');
        }

        this.previousActiveTab = null;
        console.log('✅ Modal hidden and UI restored');
    }

    async handleCreateSession(e) {
        e.preventDefault();

        const name = document.getElementById('sessionName').value.trim();
        let url = document.getElementById('sessionUrl').value.trim();

        if (!name) {
            this.showNotification('Please enter a session name', 'error');
            return;
        }

        // Validate and fix URL
        if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        if (!url) {
            url = 'https://www.google.com';
        }

        try {
            const result = await ipcRenderer.invoke('create-browser-session', {
                name,
                url: url
            });

            if (result.success) {
                // Hide modal first
                await this.hideCreateSessionModal();

                // Show success notification
                this.showNotification(`Session "${name}" created successfully!`, 'success');

                // Refresh sessions list
                await this.loadSessions();

                // Open the new session tab
                setTimeout(async () => {
                    await this.openSessionTab(result.sessionData);
                }, 200);
            } else {
                this.showNotification(`Error: ${result.error}`, 'error');
            }
        } catch (error) {
            this.showNotification(`Error creating session: ${error.message}`, 'error');
        }
    }

    async loadSessions() {
        const container = document.getElementById('welcomeSessionsContainer');
        container.innerHTML = '<div class="loading">Loading sessions...</div>';

        try {
            const sessions = await ipcRenderer.invoke('get-sessions');
            this.renderSessions(sessions);

            // Automatically open sessions marked for auto-open with a delay
            const sessionsToOpen = sessions.filter(s => s.autoOpen);
            if (sessionsToOpen.length > 0) {
                for (let i = 0; i < sessionsToOpen.length; i++) {
                    const session = sessionsToOpen[i];
                    try {
                        // Add a delay between opening each session to prevent overwhelming resources
                        await new Promise(resolve => setTimeout(resolve, 500 * i));
                        await this.openSessionTab(session);
                    } catch (error) {
                        console.error(`Error opening session ${session.name}:`, error);
                        this.showNotification(`Failed to open session "${session.name}": ${error.message}`, 'error');
                    }
                }
            }
        } catch (error) {
            container.innerHTML = '<div class="error">Error loading sessions</div>';
        }
    }

    renderSessions(sessions) {
        const welcomeContainer = document.getElementById('welcomeSessionsContainer');

        if (sessions.length === 0) {
            const emptyState = `
                <div class="empty-state">
                    <h3>No sessions yet</h3>
                    <p>Create your first browser session to get started!</p>
                </div>
            `;
            welcomeContainer.innerHTML = emptyState;
            return;
        }

        // Store sessions for easy access
        this.sessions.clear();
        this.originalSessionNames.clear(); // Clear original names
        sessions.forEach(session => {
            this.sessions.set(session.id, session);
            this.originalSessionNames.set(session.id, session.name); // Store original name
        });

        // Sort sessions by last accessed (most recent first)
        sessions.sort((a, b) => new Date(b.lastAccessed) - new Date(a.lastAccessed));

        // Generate welcome tab sessions (expanded view with more actions)
        const welcomeHtml = sessions.map(session => `
            <div class="welcome-session-item">
                <div class="session-info">
                    <h4>${this.escapeHtml(session.name)}</h4>
                    <div class="session-url">${this.escapeHtml(session.url)}</div>
                    <div class="session-meta">
                        Created: ${this.formatDate(session.created)} | Last accessed: ${this.formatDate(session.lastAccessed)}
                    </div>
                </div>
                <div class="session-actions">
                    <label class="auto-open-toggle" title="Automatically open this session on startup">
                        <input type="checkbox" 
                            ${session.autoOpen ? 'checked' : ''} 
                            onchange="ui.toggleAutoOpen('${session.id}', this.checked)">
                        Auto Open
                    </label>
                    <button class="btn btn-primary btn-small" onclick="ui.openSessionTab('${session.id}')">
                        🌐 Open
                    </button>
                    <button class="btn btn-secondary btn-small" onclick="ui.showRenameModal('${session.id}')">
                        ✏️ Rename
                    </button>
                    <button class="btn btn-danger btn-small" onclick="ui.deleteSession('${session.id}')">
                        🗑️ Delete
                    </button>
                </div>
            </div>
        `).join('');

        // Update both containers
        welcomeContainer.innerHTML = welcomeHtml;
    }

    async toggleAutoOpen(sessionId, isChecked) {
        try {
            const result = await ipcRenderer.invoke('update-session-auto-open', sessionId, isChecked);
            if (result.success) {
                // Update local session data
                const session = this.sessions.get(sessionId);
                if (session) {
                    session.autoOpen = isChecked;
                    this.sessions.set(sessionId, session);
                }
                console.log(`Auto-open for session ${sessionId} set to ${isChecked}`);
            } else {
                this.showNotification(`Failed to update auto-open: ${result.error}`, 'error');
                // Revert checkbox state
                this.loadSessions();
            }
        } catch (error) {
            console.error('Error toggling auto-open:', error);
            this.showNotification(`Error: ${error.message}`, 'error');
        }
    }

    async openSessionTab(sessionIdOrData) {
        let sessionData;

        if (typeof sessionIdOrData === 'string') {
            // It's a session ID
            sessionData = this.sessions.get(sessionIdOrData);
            if (!sessionData) {
                this.showNotification('Session not found', 'error');
                return;
            }
        } else {
            // It's session data object
            sessionData = sessionIdOrData;
        }

        // Check if tab is already open
        if (this.activeTabs.has(sessionData.id)) {
            this.switchToTab(sessionData.id);
            return;
        }

        try {
            // Create tab
            this.createTab(sessionData);

            // Create browser view
            await this.createBrowserViewTab(sessionData);

            // Switch to the new tab
            this.switchToTab(sessionData.id);

            this.showNotification(`Opened session: ${sessionData.name} `, 'success');
        } catch (error) {
            this.showNotification(`Error opening session: ${error.message} `, 'error');
        }
    }

    createTab(sessionData) {
        const tabsContainer = document.getElementById('tabsContainer');

        // Store original session name
        this.originalSessionNames.set(sessionData.id, sessionData.name);

        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.dataset.tabId = sessionData.id;
        tab.innerHTML = `
            <span class="tab-title">${this.escapeHtml(sessionData.name)}</span>
            <button class="tab-close" onclick="ui.closeTab('${sessionData.id}')" title="Close tab">×</button>
        `;

        tab.addEventListener('click', (e) => {
            if (!e.target.classList.contains('tab-close')) {
                this.switchToTab(sessionData.id);
            }
        });

        tabsContainer.appendChild(tab);
        this.activeTabs.set(sessionData.id, tab);
    }

    async createBrowserViewTab(sessionData) {
        const contentArea = document.querySelector('.content-area');

        const tabContent = document.createElement('div');
        tabContent.className = 'tab-content';
        tabContent.id = `tab-${sessionData.id}`;

        // Create a placeholder div for the browser view
        const browserContainer = document.createElement('div');
        browserContainer.className = 'browser-container';
        browserContainer.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; background: #f5f5f5;">
                <div style="font-size: 24px; margin-bottom: 10px;">🌐</div>
                <div>${sessionData.name}</div>
                <div style="font-size: 12px; color: #666; margin-top: 5px;">${sessionData.url}</div>
            </div>
        `;

        tabContent.appendChild(browserContainer);
        contentArea.appendChild(tabContent);

        console.log('Creating browser view for:', sessionData.name, 'URL:', sessionData.url);

        // Create the browser view in the main process
        const result = await ipcRenderer.invoke('create-browser-view', sessionData.id);

        if (result.success) {
            console.log(`✅ Browser view created for session: ${sessionData.name} `);
        } else {
            console.error(`❌ Failed to create browser view: `, result.error);
            browserContainer.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; background: #f5f5f5;">
                    <div style="font-size: 24px; margin-bottom: 10px;">⚠️</div>
                    <div>Failed to load ${sessionData.name}</div>
                    <div style="font-size: 12px; color: #666; margin-top: 5px;">Error: ${result.error}</div>
                    <button onclick="ui.retryBrowserView('${sessionData.id}')" style="margin-top: 10px; padding: 8px 16px; background: #667eea; color: white; border: none; border-radius: 4px; cursor: pointer;">Retry</button>
                </div>
            `;
        }
    }

    async updateSessionUrl(sessionId, url) {
        try {
            // Update the session data
            const sessionData = this.sessions.get(sessionId);
            if (sessionData) {
                sessionData.url = url;
                sessionData.lastAccessed = new Date().toISOString();

                // Update in database (we'll need to add this IPC handler)
                // For now, we'll just update locally
                this.sessions.set(sessionId, sessionData);
            }
        } catch (error) {
            console.error('Error updating session URL:', error);
        }
    }

    async switchToTab(tabId) {
        // Remove active class from all tabs and content
        document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

        // Remove active class from session items
        document.querySelectorAll('.session-item').forEach(item => item.classList.remove('active'));

        // Hide current browser view
        if (this.activeTabId && this.activeTabId !== 'welcome' && this.activeTabId !== tabId) {
            await ipcRenderer.invoke('hide-browser-view', this.activeTabId);
        }

        // Add active class to selected tab and content
        const selectedTab = document.querySelector(`[data-tab-id="${tabId}"]`);
        const selectedContent = document.getElementById(`tab-${tabId}`);

        if (selectedTab) {
            selectedTab.classList.add('active');
        }

        if (selectedContent) {
            selectedContent.classList.add('active');
        }

        // Show browser view for this tab (if it's not welcome)
        if (tabId !== 'welcome') {
            await ipcRenderer.invoke('show-browser-view', tabId);
        } else {
            // When switching to welcome, make sure no browser view is shown
            console.log('Switching to welcome tab - hiding all browser views');
            // Hide any active browser view when switching to welcome
            if (this.activeTabId && this.activeTabId !== 'welcome') {
                try {
                    await ipcRenderer.invoke('hide-browser-view', this.activeTabId);
                } catch (error) {
                    console.log('Error hiding browser view:', error);
                }
            }
        }

        this.activeTabId = tabId;
    }

    async closeTab(sessionId) {
        // Don't allow closing the welcome tab
        if (sessionId === 'welcome') {
            return;
        }

        const tab = this.activeTabs.get(sessionId);
        const tabContent = document.getElementById(`tab-${sessionId}`);

        // Close browser view
        await ipcRenderer.invoke('close-browser-view', sessionId);

        if (tab) {
            tab.remove();
            this.activeTabs.delete(sessionId);
        }

        if (tabContent) {
            tabContent.remove();
        }

        // If this was the active tab, switch to welcome or another tab
        if (this.activeTabId === sessionId) {
            if (this.activeTabs.size > 0) {
                // Switch to the first available tab
                const firstTabId = this.activeTabs.keys().next().value;
                await this.switchToTab(firstTabId);
            } else {
                // Switch to welcome tab
                await this.switchToTab('welcome');
            }
        }

        // Remove active state from session item
        const sessionItem = document.querySelector(`[data-session-id="${sessionId}"]`);
        if (sessionItem) {
            sessionItem.classList.remove('active');
        }
    }

    async deleteSession(sessionId) {
        if (!confirm('Are you sure you want to delete this session? This will remove all associated data and cannot be undone.')) {
            return;
        }

        try {
            const result = await ipcRenderer.invoke('delete-session', sessionId);

            if (result.success) {
                this.showNotification('Session deleted successfully', 'success');

                // Close the tab if it's open
                if (this.activeTabs.has(sessionId)) {
                    await this.closeTab(sessionId);
                }

                // Remove from sessions map
                this.sessions.delete(sessionId);

                // Refresh the sessions list
                this.loadSessions();
            } else {
                this.showNotification(`Error deleting session: ${result.error} `, 'error');
            }
        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
        }
    }

    showNotification(message, type = 'info') {
        const statusBar = document.getElementById('status-bar');
        const statusMessage = document.getElementById('status-message');

        if (statusBar && statusMessage) {
            // Show the message
            statusMessage.textContent = message;
            statusBar.className = `status-bar show ${type}`;

            // After 3 seconds, show "Ready" for 2 seconds, then hide
            setTimeout(() => {
                statusBar.className = 'status-bar show';
                statusMessage.textContent = 'Ready';

                // Hide after 2 more seconds
                setTimeout(() => {
                    statusBar.className = 'status-bar';
                }, 2000);
            }, 3000);
        }
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    async retryBrowserView(sessionId) {
        const sessionData = this.sessions.get(sessionId);

        if (sessionData) {
            console.log(`🔄 Retrying browser view for ${sessionData.name}`);

            // Close existing browser view
            await ipcRenderer.invoke('close-browser-view', sessionId);

            // Create new browser view
            const result = await ipcRenderer.invoke('create-browser-view', sessionId);

            if (result.success) {
                console.log(`✅ Browser view recreated for ${sessionData.name}`);
                // Show the browser view if this tab is active
                if (this.activeTabId === sessionId) {
                    await ipcRenderer.invoke('show-browser-view', sessionId);
                }
            }
        }
    }

    updateTabTitleWithUnreadCount(sessionId, title, unreadCount) {
        const tab = this.activeTabs.get(sessionId);
        if (tab) {
            const titleSpan = tab.querySelector('.tab-title');
            if (titleSpan) {
                // Get original session name
                const sessionData = this.sessions.get(sessionId);
                const originalName = this.originalSessionNames.get(sessionId) || sessionData?.name || 'Session';

                // Build display title with unread count
                let displayTitle = originalName;
                if (unreadCount && unreadCount !== 0 && unreadCount !== '0') {
                    displayTitle = `(${unreadCount}) ${originalName} `;
                }

                // Preserve favicon if it exists
                const existingFavicon = titleSpan.querySelector('.tab-favicon');

                const truncatedTitle = displayTitle.length > 20 ? displayTitle.substring(0, 20) + '...' : displayTitle;

                if (existingFavicon) {
                    titleSpan.innerHTML = '';
                    titleSpan.appendChild(existingFavicon);
                    titleSpan.appendChild(document.createTextNode(truncatedTitle));
                } else {
                    titleSpan.textContent = truncatedTitle;
                }

                console.log(`📄 Updated tab title for ${sessionId}: ${displayTitle} (from original: ${originalName})`);
            }
        }
    }

    // Keep original function for backwards compatibility
    updateTabTitle(sessionId, title) {
        this.updateTabTitleWithUnreadCount(sessionId, title, 0);
    }

    updateTabFavicon(sessionId, favicon) {
        const tab = this.activeTabs.get(sessionId);
        if (tab) {
            const titleSpan = tab.querySelector('.tab-title');
            if (titleSpan) {
                // Remove any existing favicon
                const existingFavicon = titleSpan.querySelector('.tab-favicon');
                if (existingFavicon) {
                    existingFavicon.remove();
                }

                // Add new favicon
                const faviconImg = document.createElement('img');
                faviconImg.src = favicon;
                faviconImg.className = 'tab-favicon';
                faviconImg.style.cssText = 'width: 16px; height: 16px; margin-right: 6px; border-radius: 2px;';

                // Handle favicon load error
                faviconImg.onerror = () => {
                    faviconImg.remove();
                };

                titleSpan.insertBefore(faviconImg, titleSpan.firstChild);
                console.log(`🎯 Updated favicon for ${sessionId}: ${favicon} `);
            }
        }
    }

    setupContextMenu() {
        const contextMenu = document.getElementById('contextMenu');
        const renameBtn = document.getElementById('renameSession');
        const deleteBtn = document.getElementById('deleteSessionContext');

        console.log('🔧 Setting up context menu...', { contextMenu, renameBtn, deleteBtn });

        if (!contextMenu || !renameBtn || !deleteBtn) {
            console.error('❌ Context menu elements not found!');
            return;
        }

        // Context menu item handlers with multiple event types
        const handleRename = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('🔧 Rename button clicked, target:', this.contextMenuTarget);
            await this.hideContextMenu();
            this.showRenameModal();
        };

        const handleDelete = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('🔧 Delete button clicked, target:', this.contextMenuTarget);
            await this.hideContextMenu();
            if (this.contextMenuTarget) {
                await this.deleteSession(this.contextMenuTarget);
            }
        };

        // Add multiple event listeners for better compatibility
        renameBtn.addEventListener('click', handleRename);
        renameBtn.addEventListener('mousedown', handleRename);

        deleteBtn.addEventListener('click', handleDelete);
        deleteBtn.addEventListener('mousedown', handleDelete);

        // Add hover effects for debugging
        renameBtn.addEventListener('mouseenter', () => {
            console.log('🖱️ Hovering over rename button');
            renameBtn.style.backgroundColor = '#f8f9fa';
        });

        renameBtn.addEventListener('mouseleave', () => {
            console.log('🖱️ Left rename button');
            renameBtn.style.backgroundColor = '';
        });

        deleteBtn.addEventListener('mouseenter', () => {
            console.log('🖱️ Hovering over delete button');
            deleteBtn.style.backgroundColor = '#f8d7da';
        });

        deleteBtn.addEventListener('mouseleave', () => {
            console.log('🖱️ Left delete button');
            deleteBtn.style.backgroundColor = '';
        });

        // Hide context menu when clicking outside
        document.addEventListener('click', async (e) => {
            if (this.contextMenuOpen && !contextMenu.contains(e.target)) {
                console.log('🔧 Clicking outside context menu, hiding...');
                await this.hideContextMenu();
            }
        });
    }

    setupRenameModal() {
        const renameModal = document.getElementById('renameModal');
        const closeRenameModal = document.getElementById('closeRenameModal');
        const cancelRename = document.getElementById('cancelRename');
        const renameForm = document.getElementById('renameSessionForm');

        if (!renameModal || !closeRenameModal || !cancelRename || !renameForm) {
            console.error('❌ Rename modal elements not found during setup');
            return;
        }

        closeRenameModal.addEventListener('click', async () => {
            await this.hideRenameModal();
        });

        cancelRename.addEventListener('click', async () => {
            await this.hideRenameModal();
        });

        renameForm.addEventListener('submit', async (e) => {
            await this.handleRenameSession(e);
        });

        // Close rename modal when clicking outside
        renameModal.addEventListener('click', async (e) => {
            if (e.target === renameModal) {
                await this.hideRenameModal();
            }
        });

        // ESC key to close modal
        document.addEventListener('keydown', async (e) => {
            if (e.key === 'Escape' && renameModal.classList.contains('show')) {
                await this.hideRenameModal();
            }
        });
    }

    async showContextMenu(event, sessionId) {
        event.preventDefault();
        event.stopPropagation();

        const sessionData = this.sessions.get(sessionId);
        if (!sessionData) return;

        this.contextMenuTarget = sessionId;
        this.contextMenuOpen = true;

        const contextMenu = document.getElementById('contextMenu');
        const contextMenuHeader = document.getElementById('contextMenuHeader');

        // Update header with session name
        contextMenuHeader.textContent = sessionData.name;

        // Position context menu
        const x = event.clientX;
        const y = event.clientY;

        // Ensure menu doesn't go off screen
        const menuWidth = 200;
        const menuHeight = 120;
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        const finalX = (x + menuWidth > windowWidth) ? windowWidth - menuWidth - 10 : x;
        const finalY = (y + menuHeight > windowHeight) ? windowHeight - menuHeight - 10 : y;

        // Force maximum z-index and positioning
        contextMenu.style.cssText = `
        position: fixed!important;
        left: ${finalX} px!important;
        top: ${finalY} px!important;
        z - index: 2147483647!important;
        pointer - events: all!important;
        background: white!important;
        `;
        contextMenu.classList.add('show');

        console.log(`🖱️ Context menu opened for session: ${sessionData.name} `);
    }

    async hideContextMenu() {
        const contextMenu = document.getElementById('contextMenu');
        contextMenu.classList.remove('show');
        this.contextMenuOpen = false;
        this.contextMenuTarget = null;
    }

    async showRenameModal(sessionId) {
        console.log('🔧 Opening rename modal for session:', sessionId);

        if (!sessionId) {
            console.error('❌ No session ID provided');
            return;
        }

        const sessionData = this.sessions.get(sessionId);
        if (!sessionData) {
            console.error('❌ Session data not found for:', sessionId);
            return;
        }

        const renameModal = document.getElementById('renameModal');
        const newSessionNameInput = document.getElementById('newSessionName');
        const renameForm = document.getElementById('renameSessionForm');

        if (!renameModal || !newSessionNameInput || !renameForm) {
            console.error('❌ Rename modal elements not found');
            return;
        }

        // Store current active tab and hide browser view
        this.previousActiveTab = this.activeTabId;

        // Hide any active browser view to prevent it from covering the modal
        if (this.activeTabId && this.activeTabId !== 'welcome') {
            try {
                await ipcRenderer.invoke('hide-browser-view', this.activeTabId);
            } catch (error) {
                console.log('Error hiding browser view:', error);
            }
        }

        // Pre-fill with current name
        newSessionNameInput.value = sessionData.name;

        // Store the session ID in the form
        renameForm.dataset.sessionId = sessionId;

        // Force modal visibility
        renameModal.style.cssText = `
        display: flex!important;
        position: fixed!important;
        z - index: 2147483647!important;
        pointer - events: all!important;
        background: rgba(0, 0, 0, 0.5)!important;
        `;
        renameModal.classList.add('show');

        console.log('🔧 Rename modal should be visible now');

        setTimeout(() => {
            newSessionNameInput.focus();
            newSessionNameInput.select();
        }, 100);
    }

    async hideRenameModal() {
        const renameModal = document.getElementById('renameModal');
        renameModal.classList.remove('show');
        document.getElementById('renameSessionForm').reset();

        // Clear all inline styles from the modal
        renameModal.style.cssText = '';
        renameModal.style.display = 'none';

        // Restore the browser view if we had one active
        if (this.previousActiveTab && this.previousActiveTab !== 'welcome') {
            try {
                await ipcRenderer.invoke('show-browser-view', this.previousActiveTab);
            } catch (error) {
                console.error('Error restoring browser view:', error);
            }
        }

        this.previousActiveTab = null;
    }

    async handleRenameSession(e) {
        e.preventDefault();

        const sessionId = e.target.dataset.sessionId;
        if (!sessionId) return;

        const newName = document.getElementById('newSessionName').value.trim();
        if (!newName) {
            this.showNotification('Please enter a session name', 'error');
            return;
        }

        try {
            const result = await ipcRenderer.invoke('rename-session', sessionId, newName);

            if (result.success) {
                this.showNotification(`Session renamed to "${newName}"`, 'success');
                this.hideRenameModal();

                // Update local session data
                const sessionData = this.sessions.get(sessionId);
                if (sessionData) {
                    sessionData.name = newName;
                    this.sessions.set(sessionId, sessionData);
                }

                // Update stored original name
                this.originalSessionNames.set(sessionId, newName);

                // Update tab title (this will reset to show just the new name without unread count)
                this.updateTabTitleWithUnreadCount(sessionId, newName, 0);

                // Refresh sessions list
                await this.loadSessions();
            } else {
                this.showNotification(`Error renaming session: ${result.error} `, 'error');
            }
        } catch (error) {
            this.showNotification(`Error: ${error.message} `, 'error');
        }
    }

    // ── AI Settings Modal ──

    setupAISettingsModal() {
        const modal = document.getElementById('aiSettingsModal');
        const openBtn = document.getElementById('openAISettings');
        const closeBtn = document.getElementById('closeAISettings');
        const cancelBtn = document.getElementById('cancelAISettings');
        const form = document.getElementById('aiSettingsForm');
        const providerSelect = document.getElementById('aiProvider');

        if (!modal || !openBtn) return;

        openBtn.addEventListener('click', () => this.showAISettingsModal());
        closeBtn.addEventListener('click', () => this.hideAISettingsModal());
        cancelBtn.addEventListener('click', () => this.hideAISettingsModal());

        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideAISettingsModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('show')) {
                this.hideAISettingsModal();
            }
        });

        // Toggle API key fields based on provider
        providerSelect.addEventListener('change', () => {
            this.updateAIProviderFields(providerSelect.value);
        });

        form.addEventListener('submit', (e) => this.handleSaveAISettings(e));
    }

    updateAIProviderFields(provider) {
        const claudeKeyGroup = document.getElementById('claudeApiKeyGroup');
        const claudeModelGroup = document.getElementById('claudeModelGroup');
        const openaiKeyGroup = document.getElementById('openaiApiKeyGroup');
        const openaiModelGroup = document.getElementById('openaiModelGroup');

        claudeKeyGroup.style.display = provider === 'claude-api' ? 'block' : 'none';
        claudeModelGroup.style.display = provider === 'claude-api' ? 'block' : 'none';
        openaiKeyGroup.style.display = provider === 'openai-api' ? 'block' : 'none';
        openaiModelGroup.style.display = provider === 'openai-api' ? 'block' : 'none';
    }

    async showAISettingsModal() {
        const modal = document.getElementById('aiSettingsModal');

        // Store current tab and hide browser view
        this.previousActiveTab = this.activeTabId;
        if (this.activeTabId && this.activeTabId !== 'welcome') {
            try {
                await ipcRenderer.invoke('hide-browser-view', this.activeTabId);
            } catch (error) {
                console.log('Error hiding browser view:', error);
            }
        }

        // Load current settings
        try {
            const settings = await ipcRenderer.invoke('ai-get-settings');
            document.getElementById('aiProvider').value = settings.provider || 'claude-cli';
            document.getElementById('claudeApiKey').value = settings.claudeApiKey || '';
            document.getElementById('claudeModel').value = settings.claudeModel || 'claude-sonnet-4-6-20250514';
            document.getElementById('openaiApiKey').value = settings.openaiApiKey || '';
            document.getElementById('openaiModel').value = settings.openaiModel || 'gpt-4o';
            document.getElementById('aiTargetLanguage').value = settings.targetLanguage || 'English';
            document.getElementById('aiShortcut').value = settings.shortcut || 'Alt+H';
            this.updateAIProviderFields(settings.provider || 'claude-cli');
        } catch (err) {
            console.log('Could not load AI settings:', err);
        }

        modal.classList.add('show');
        modal.style.zIndex = '999999999';
        modal.style.display = 'flex';
    }

    async hideAISettingsModal() {
        const modal = document.getElementById('aiSettingsModal');
        modal.classList.remove('show');
        modal.style.display = 'none';
        modal.style.zIndex = '';

        // Restore browser view
        if (this.previousActiveTab && this.previousActiveTab !== 'welcome') {
            try {
                await ipcRenderer.invoke('show-browser-view', this.previousActiveTab);
            } catch (error) {
                console.log('Error restoring browser view:', error);
            }
        }
        this.previousActiveTab = null;
    }

    async handleSaveAISettings(e) {
        e.preventDefault();

        const settings = {
            provider: document.getElementById('aiProvider').value,
            claudeApiKey: document.getElementById('claudeApiKey').value,
            openaiApiKey: document.getElementById('openaiApiKey').value,
            claudeModel: document.getElementById('claudeModel').value || 'claude-sonnet-4-6-20250514',
            openaiModel: document.getElementById('openaiModel').value || 'gpt-4o',
            targetLanguage: document.getElementById('aiTargetLanguage').value || 'English',
            shortcut: document.getElementById('aiShortcut').value || 'Alt+H'
        };

        try {
            const result = await ipcRenderer.invoke('ai-save-settings', settings);
            if (result.success) {
                this.showNotification('AI settings saved successfully', 'success');
                this.hideAISettingsModal();
            } else {
                this.showNotification(`Error saving settings: ${result.error}`, 'error');
            }
        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize the UI
const ui = new MultiBrowserUI();
window.multiBrowserApp = ui;

// Global test functions for debugging
window.testContextMenu = (sessionId) => {
    console.log('🔧 Testing context menu for session:', sessionId);
    const app = window.multiBrowserApp;
    if (app) {
        // Simulate a right-click event
        const fakeEvent = {
            preventDefault: () => { },
            stopPropagation: () => { },
            clientX: 400,
            clientY: 300
        };
        app.contextMenuTarget = sessionId || 'session_test';
        app.contextMenuOpen = true;
        app.showContextMenu(fakeEvent, sessionId || 'session_test');
    } else {
        console.error('❌ App instance not found');
    }
};

window.testRename = () => {
    console.log('🔧 Testing rename modal...');
    const app = window.multiBrowserApp;
    if (app && app.sessions.size > 0) {
        const firstSessionId = Array.from(app.sessions.keys())[0];
        app.contextMenuTarget = firstSessionId;
        app.showRenameModal();
    } else {
        console.error('❌ App instance not found or no sessions');
    }
};