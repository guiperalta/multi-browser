# Multi Browser Manager

A desktop application for Windows that manages multiple isolated browser instances with persistent sessions.

## Features

- 🌐 **Multiple Isolated Sessions**: Each browser instance runs in complete isolation
- 💾 **Session Persistence**: Sessions, cookies, and browsing data are saved between app restarts
- 🚀 **Simple Interface**: Clean, fast UI for managing browser instances
- 🔒 **Privacy**: Each session maintains separate cookies, localStorage, and browsing data
- ⚡ **Quick Access**: Easily create, open, and manage multiple sessions

## Installation

1. **Install Node.js** (if not already installed):
   - Download from [nodejs.org](https://nodejs.org/)
   - Install the LTS version

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run the application**:
   ```bash
   npm start
   ```

## Building for Distribution

To create a Windows installer:

```bash
npm run build-win
```

The installer will be created in the `dist` folder.

## Requirements

- **Windows 10/11**
- **Google Chrome** (must be installed)
- **Node.js 16+**

## Usage

1. **Create a Session**:
   - Enter a name for your session (e.g., "Work Account", "Personal")
   - Optionally enter a starting URL
   - Click "Create Session"

2. **Open a Session**:
   - Click "Open Session" on any saved session
   - The browser will open with that session's data

3. **Session Isolation**:
   - Each session has its own cookies, localStorage, and browsing data
   - You can be logged into different accounts on the same website simultaneously
   - Sessions persist between app restarts

## Use Cases

- **Multiple Social Media Accounts**: Manage different Twitter, Instagram, or Facebook accounts
- **Work vs Personal**: Keep work and personal browsing completely separate
- **Testing**: Test websites with different user accounts or settings
- **Privacy**: Isolate different types of browsing activity

## Technical Details

- Built with Electron and Node.js
- Uses Chrome's `--user-data-dir` for session isolation
- Session data stored locally in `browser-sessions` folder
- Session metadata stored in JSON database

## Troubleshooting

**Chrome not found error**:
- Make sure Google Chrome is installed
- The app looks for Chrome in standard installation locations

**Session won't open**:
- Check if Chrome is already running with the same profile
- Restart the application

**Data not persisting**:
- Don't delete the `browser-sessions` folder
- Make sure the app has write permissions to its directory

**Linux Electron sandbox error**:
- If Electron fails with `chrome-sandbox is owned by root and has mode 4755`, run `npm run dev` or `./start.sh`; these use `--no-sandbox` for local development.
- To keep Chromium sandboxing enabled, fix the helper permissions after `npm install`:
  ```bash
  sudo chown root:root node_modules/electron/dist/chrome-sandbox
  sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
  npm run dev:sandbox
  ```
