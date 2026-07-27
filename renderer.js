const { ipcRenderer } = require('electron');

// Inline stroke icons, matching the set used by the in-page AI overlay.
const ICONS = {
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5h6v6"/><path d="M19 5l-8 8"/><path d="M18.5 14.5V18a1.5 1.5 0 01-1.5 1.5H6A1.5 1.5 0 014.5 18V7A1.5 1.5 0 016 5.5h3.5"/></svg>',
    pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 4.5l3 3L8 19l-4 1 1-4L16.5 4.5z"/><path d="M14.5 6.5l3 3"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M9.5 7V5.5h5V7"/><path d="M6.5 7l.8 12.2a1.3 1.3 0 001.3 1.3h6.8a1.3 1.3 0 001.3-1.3L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5"/><path d="M12 16.2v.2"/></svg>'
};

class MultiBrowserUI {
    constructor() {
        this.activeTabs = new Map(); // sessionId -> tab element
        this.activeTabId = 'welcome';
        this.sessions = new Map(); // sessionId -> session data
        this.originalSessionNames = new Map(); // sessionId -> original user-defined name
        this.modalOpen = false;
        this.previousActiveTab = null;
        this.availableLanguages = [];        // spellchecker locales reported by Electron
        this.defaultLanguages = ['pt-BR', 'en-US']; // default selection for new sessions
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.loadAvailableLanguages();
        this.loadAppVersion();
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

        // Generic status messages from the main process
        ipcRenderer.on('app-message', (_e, { text, type }) => {
            this.showNotification(text, type || 'info');
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

        // New sessions default to PT + EN spellcheck (overridable per session).
        this.populateLanguageSelect(document.getElementById('sessionLanguages'), this.defaultLanguages);

        // Force all form inputs to be accessible
        const nameInput = document.getElementById('sessionName');
        const urlInput = document.getElementById('sessionUrl');
        const allInputs = [nameInput, urlInput].filter(Boolean);

        allInputs.forEach(input => {
            // Keep the fields reachable above the browser view; appearance is
            // left to the stylesheet.
            input.style.cssText = `
                z-index: 2147483647 !important;
                pointer-events: all !important;
                position: relative !important;
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
            const spellLanguages = this.getSelectedLanguages(document.getElementById('sessionLanguages'));

            const result = await ipcRenderer.invoke('create-browser-session', {
                name,
                url: url,
                spellLanguages: spellLanguages.length ? spellLanguages : this.defaultLanguages
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

    async loadAppVersion() {
        try {
            const version = await ipcRenderer.invoke('get-app-version');
            const label = document.getElementById('appVersionLabel');
            if (label && version) label.textContent = `Multi Browser v${version}`;
        } catch {
            // Label keeps its static fallback text.
        }
    }

    async loadSessions() {
        const container = document.getElementById('welcomeSessionsContainer');
        container.innerHTML = '<div class="loading">Loading sessions</div>';

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
        const countEl = document.getElementById('sessionCount');
        if (countEl) {
            countEl.textContent = sessions.length
                ? `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`
                : '';
        }

        if (sessions.length === 0) {
            const emptyState = `
                <div class="empty-state">
                    <h3>No sessions yet</h3>
                    <p>Create one to get an isolated browser with its own cookies and logins.</p>
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
        const welcomeHtml = sessions.map((session, i) => `
            <article class="welcome-session-item" style="--i:${i}">
                <div class="session-head">
                    <span class="session-avatar">${this.escapeHtml((session.name || '?').trim().charAt(0))}</span>
                    <div class="session-info">
                        <h4>${this.escapeHtml(session.name)}</h4>
                        <div class="session-url" title="${this.escapeHtml(session.url)}">${this.escapeHtml(this.prettyUrl(session.url))}</div>
                    </div>
                </div>
                <dl class="session-meta">
                    <div><dt>Created</dt><dd>${this.formatDate(session.created)}</dd></div>
                    <div><dt>Last used</dt><dd>${this.formatDate(session.lastAccessed)}</dd></div>
                </dl>
                <div class="session-actions">
                    <label class="auto-open-toggle" title="Automatically open this session on startup">
                        <input type="checkbox"
                            ${session.autoOpen ? 'checked' : ''}
                            onchange="ui.toggleAutoOpen('${session.id}', this.checked)">
                        <span class="track"></span>
                        Auto open
                    </label>
                    <span class="spacer"></span>
                    <button class="btn btn-primary btn-small" onclick="ui.openSessionTab('${session.id}')">
                        ${ICONS.open} Open
                    </button>
                    <button class="icon-btn" title="Rename" onclick="ui.showRenameModal('${session.id}')">
                        ${ICONS.pen}
                    </button>
                    <button class="icon-btn danger" title="Delete" onclick="ui.deleteSession('${session.id}')">
                        ${ICONS.trash}
                    </button>
                </div>
            </article>
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
            <button class="tab-close" onclick="ui.closeTab('${sessionData.id}')" title="Close tab">${ICONS.close}</button>
        `;

        tab.addEventListener('click', (e) => {
            // closest(): the close button holds an <svg>, so the click target
            // is usually a path inside it, not the button itself.
            if (!e.target.closest('.tab-close')) {
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
            <div class="view-placeholder">
                <div class="ph-mark">${ICONS.globe}</div>
                <div class="ph-name">${this.escapeHtml(sessionData.name)}</div>
                <div class="ph-sub">${this.escapeHtml(sessionData.url)}</div>
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
                <div class="view-placeholder">
                    <div class="ph-mark" style="color: var(--danger); border-color: rgba(226,112,95,.3);">${ICONS.alert}</div>
                    <div class="ph-name">Failed to load ${this.escapeHtml(sessionData.name)}</div>
                    <div class="ph-sub">${this.escapeHtml(String(result.error))}</div>
                    <button class="btn btn-secondary btn-small" style="margin-top:12px"
                        onclick="ui.retryBrowserView('${sessionData.id}')">Retry</button>
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
            ipcRenderer.send('status-bar-visibility', true);

            // After 3 seconds, show "Ready" for 2 seconds, then hide
            setTimeout(() => {
                statusBar.className = 'status-bar show';
                statusMessage.textContent = 'Ready';

                // Hide after 2 more seconds
                setTimeout(() => {
                    statusBar.className = 'status-bar';
                    ipcRenderer.send('status-bar-visibility', false);
                }, 2000);
            }, 3000);
        }
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // Cards show the host, not the whole URL — the full value stays in the title.
    prettyUrl(url) {
        try {
            const u = new URL(url);
            return (u.hostname + (u.pathname === '/' ? '' : u.pathname)).replace(/^www\./, '');
        } catch {
            return url || 'about:blank';
        }
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

        // Pre-fill the spellcheck languages for this session
        this.populateLanguageSelect(
            document.getElementById('renameLanguages'),
            sessionData.spellLanguages || this.defaultLanguages
        );

        // Store the session ID in the form
        renameForm.dataset.sessionId = sessionId;

        // Force modal visibility (styling comes from styles.css)
        renameModal.style.cssText = 'display: flex !important; position: fixed !important;';
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

        const spellLanguages = this.getSelectedLanguages(document.getElementById('renameLanguages'));

        try {
            const result = await ipcRenderer.invoke('rename-session', sessionId, newName);

            // Persist + apply the session's spellcheck languages (live, no reopen).
            const langs = spellLanguages.length ? spellLanguages : this.defaultLanguages;
            await ipcRenderer.invoke('update-session-languages', sessionId, langs);

            if (result.success) {
                this.showNotification(`Session renamed to "${newName}"`, 'success');
                this.hideRenameModal();

                // Update local session data
                const sessionData = this.sessions.get(sessionId);
                if (sessionData) {
                    sessionData.name = newName;
                    sessionData.spellLanguages = langs;
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

        // Key capture for shortcut field
        const shortcutInput = document.getElementById('aiShortcut');
        if (shortcutInput) {
            shortcutInput.addEventListener('keydown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Only accept single letter/number/F-keys
                let key = e.key;
                if (key.length === 1 && /[a-zA-Z0-9]/.test(key)) {
                    shortcutInput.value = `Alt+${key.toUpperCase()}`;
                } else if (key.startsWith('F') && key.length <= 3) {
                    shortcutInput.value = `Alt+${key}`;
                }
            });
        }
    }

    updateAIProviderFields(provider) {
        const claudeKeyGroup = document.getElementById('claudeApiKeyGroup');
        const claudeModelGroup = document.getElementById('claudeModelGroup');
        const openaiKeyGroup = document.getElementById('openaiApiKeyGroup');
        const openaiModelGroup = document.getElementById('openaiModelGroup');
        const openrouterKeyGroup = document.getElementById('openrouterApiKeyGroup');
        const openrouterModelGroup = document.getElementById('openrouterModelGroup');

        claudeKeyGroup.style.display = provider === 'claude-api' ? 'block' : 'none';
        claudeModelGroup.style.display = provider === 'claude-api' ? 'block' : 'none';
        openaiKeyGroup.style.display = provider === 'openai-api' ? 'block' : 'none';
        openaiModelGroup.style.display = provider === 'openai-api' ? 'block' : 'none';
        openrouterKeyGroup.style.display = provider === 'openrouter-api' ? 'block' : 'none';
        openrouterModelGroup.style.display = provider === 'openrouter-api' ? 'block' : 'none';
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
            document.getElementById('openrouterApiKey').value = settings.openrouterApiKey || '';
            document.getElementById('openrouterModel').value = settings.openrouterModel || 'openai/gpt-4o';
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
            openrouterApiKey: document.getElementById('openrouterApiKey').value,
            claudeModel: document.getElementById('claudeModel').value || 'claude-sonnet-4-6-20250514',
            openaiModel: document.getElementById('openaiModel').value || 'gpt-4o',
            openrouterModel: document.getElementById('openrouterModel').value || 'openai/gpt-4o',
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

    async loadAvailableLanguages() {
        try {
            const langs = await ipcRenderer.invoke('get-available-spellchecker-languages');
            if (Array.isArray(langs) && langs.length) {
                this.availableLanguages = langs;
            }
        } catch (error) {
            console.log('Could not load spellchecker languages:', error);
        }
    }

    languageLabel(code) {
        const names = {
            'pt-BR': 'Portuguese (Brazil)', 'pt-PT': 'Portuguese (Portugal)',
            'en-US': 'English (US)', 'en-GB': 'English (UK)', 'en-AU': 'English (Australia)',
            'en-CA': 'English (Canada)', 'es': 'Spanish', 'es-ES': 'Spanish (Spain)',
            'es-419': 'Spanish (Latin America)', 'fr': 'French', 'fr-FR': 'French (France)',
            'de': 'German', 'de-DE': 'German (Germany)', 'it': 'Italian', 'it-IT': 'Italian',
            'nl': 'Dutch', 'ru': 'Russian', 'pl': 'Polish', 'sv': 'Swedish', 'tr': 'Turkish',
            'ca': 'Catalan', 'cs': 'Czech', 'da': 'Danish', 'el': 'Greek', 'fa': 'Persian',
            'hr': 'Croatian', 'hu': 'Hungarian', 'id': 'Indonesian', 'ko': 'Korean',
            'lt': 'Lithuanian', 'lv': 'Latvian', 'nb': 'Norwegian', 'ro': 'Romanian',
            'sk': 'Slovak', 'sl': 'Slovenian', 'sq': 'Albanian', 'sr': 'Serbian',
            'ta': 'Tamil', 'uk': 'Ukrainian', 'vi': 'Vietnamese', 'hy': 'Armenian',
            'bg': 'Bulgarian', 'et': 'Estonian', 'he': 'Hebrew', 'af': 'Afrikaans',
            'cy': 'Welsh', 'fo': 'Faroese'
        };
        return names[code] ? `${names[code]} (${code})` : code;
    }

    populateLanguageSelect(selectEl, selected = []) {
        if (!selectEl) return;
        // Fall back to a common list if Electron reported nothing (e.g. macOS).
        const codes = (this.availableLanguages && this.availableLanguages.length)
            ? this.availableLanguages
            : ['en-US', 'en-GB', 'pt-BR', 'pt-PT', 'es', 'fr', 'de', 'it', 'nl', 'ru', 'pl', 'sv', 'tr'];
        selectEl.innerHTML = codes.map(code => {
            const isSel = selected.includes(code) ? 'selected' : '';
            return `<option value="${code}" ${isSel}>${this.escapeHtml(this.languageLabel(code))}</option>`;
        }).join('');
    }

    getSelectedLanguages(selectEl) {
        if (!selectEl) return [];
        return Array.from(selectEl.selectedOptions).map(o => o.value);
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