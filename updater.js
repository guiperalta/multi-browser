// Update checker / installer backed by GitHub Releases.
//
// electron-updater is the usual answer, but it cannot install a .deb (that
// needs root), which is the format this app is normally installed from. So we
// talk to the Releases API directly and hand the downloaded artifact to the
// right installer per format:
//
//   nsis      → run the installer silently, then quit
//   appimage  → swap the running AppImage on the way out, then relaunch
//   deb / rpm → pkexec (one password prompt), then relaunch
//   dmg / dev → just open the release page
//
// Requests are unauthenticated by default. While the repository is private the
// API answers 404 to anonymous callers, so a GitHub token can be supplied
// (AI/Update settings → stored locally); it is sent only to api.github.com and
// the release download host, and only needs `repo` read access. Once the repo
// is public the token becomes unnecessary.

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, shell } = require('electron');

const REPO = 'guiperalta/multi-browser';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const USER_AGENT = 'multi-browser-updater';

// ── HTTP helpers ──────────────────────────────────────────────────────────

function get(url, { headers = {}, redirects = 5 } = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, ...headers } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirects <= 0) return reject(new Error('Too many redirects'));
                return resolve(get(res.headers.location, { headers, redirects: redirects - 1 }));
            }
            resolve(res);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('Request timed out')));
    });
}

function authHeaders(token) {
    return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getJson(url, token) {
    const res = await get(url, { headers: { Accept: 'application/vnd.github+json', ...authHeaders(token) } });
    if (res.statusCode !== 200) {
        res.resume();
        if (res.statusCode === 404) {
            throw new Error(token
                ? 'Release not found — check the token has access to the repository.'
                : 'No public release found. If the repository is private, add a GitHub token in AI settings.');
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
            throw new Error('GitHub rejected the token (401/403).');
        }
        throw new Error(`GitHub API returned ${res.statusCode}`);
    }
    let body = '';
    for await (const chunk of res) body += chunk;
    return JSON.parse(body);
}

// ── Version compare (tags are plain x.y.z) ────────────────────────────────

function parseVersion(v) {
    return String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}

function isNewer(candidate, current) {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] || 0) - (b[i] || 0);
        if (d !== 0) return d > 0;
    }
    return false;
}

// ── Which artifact do we want? ────────────────────────────────────────────

function detectFormat() {
    if (!app.isPackaged) return 'dev';
    if (process.platform === 'win32') return 'nsis';
    if (process.platform === 'darwin') return 'dmg';
    if (process.env.APPIMAGE) return 'appimage';
    // Packaged Linux without APPIMAGE: installed from a system package.
    return fs.existsSync('/etc/debian_version') ? 'deb' : 'rpm';
}

const ASSET_SUFFIX = {
    nsis: '.exe',
    appimage: '.AppImage',
    deb: '.deb',
    rpm: '.rpm',
    dmg: '.dmg'
};

function pickAsset(release, format) {
    const suffix = ASSET_SUFFIX[format];
    if (!suffix) return null;
    return release.assets.find(a => a.name.toLowerCase().endsWith(suffix.toLowerCase())) || null;
}

// ── Public API ────────────────────────────────────────────────────────────

async function checkForUpdate(token) {
    const format = detectFormat();
    const currentVersion = app.getVersion();

    const release = await getJson(API_LATEST, token);
    const latestVersion = String(release.tag_name || '').replace(/^v/, '');
    const available = isNewer(latestVersion, currentVersion);
    const asset = available ? pickAsset(release, format) : null;

    return {
        available,
        currentVersion,
        latestVersion,
        format,
        releaseUrl: release.html_url,
        notes: (release.body || '').slice(0, 4000),
        // 'dev' and 'dmg' can be told about an update but not install one.
        installable: available && !!asset && format !== 'dev' && format !== 'dmg',
        asset: asset && {
            name: asset.name,
            size: asset.size,
            // Private repos can only be downloaded through the API asset URL;
            // the browser URL is fine (and CDN-backed) once public.
            url: token ? asset.url : asset.browser_download_url,
            // Present on newer releases, e.g. "sha256:abc…". Verified when there.
            digest: asset.digest || null
        }
    };
}

async function downloadAsset(asset, onProgress, token) {
    const dir = path.join(os.tmpdir(), 'multi-browser-update');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, asset.name);

    const res = await get(asset.url, { headers: { Accept: 'application/octet-stream', ...authHeaders(token) } });
    if (res.statusCode !== 200) {
        res.resume();
        throw new Error(`Download failed with status ${res.statusCode}`);
    }

    const total = Number(res.headers['content-length']) || asset.size || 0;
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastReport = 0;

    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(filePath);
        res.on('data', (chunk) => {
            received += chunk.length;
            hash.update(chunk);
            // Report at most ~every 200KB so IPC isn't flooded.
            if (onProgress && (received - lastReport > 200 * 1024 || received === total)) {
                lastReport = received;
                onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 });
            }
        });
        res.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        res.pipe(out);
    });

    if (asset.digest && asset.digest.startsWith('sha256:')) {
        const actual = hash.digest('hex');
        const expected = asset.digest.slice('sha256:'.length);
        if (actual !== expected) {
            fs.unlinkSync(filePath);
            throw new Error('Downloaded file failed its checksum — update aborted.');
        }
    }

    return filePath;
}

// Runs `pkexec <cmd> <args>`: one graphical password prompt, no sudoers setup.
function runPrivileged(cmd, args) {
    return new Promise((resolve) => {
        const child = spawn('pkexec', [cmd, ...args], { stdio: 'ignore' });
        child.on('error', (err) => resolve({ ok: false, error: err.message }));
        child.on('exit', (code) => {
            if (code === 0) return resolve({ ok: true });
            // 126 = user dismissed the prompt, 127 = pkexec/agent missing.
            if (code === 126) return resolve({ ok: false, error: 'Authorization was cancelled.' });
            if (code === 127) return resolve({ ok: false, error: 'pkexec is not available on this system.' });
            resolve({ ok: false, error: `Installer exited with code ${code}.` });
        });
    });
}

async function installUpdate(filePath, format) {
    switch (format) {
        case 'nsis': {
            // electron-builder's NSIS installer updates in place with /S and
            // relaunches the app itself.
            spawn(filePath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
            setTimeout(() => app.quit(), 400);
            return { success: true, quitting: true };
        }

        case 'appimage': {
            const target = process.env.APPIMAGE;
            if (!target) return { success: false, error: 'APPIMAGE path is not set.' };
            // Overwriting the image we are running from is only safe once this
            // process is gone, so hand the swap to a detached shell.
            const script = `sleep 2; cp -f "${filePath}" "${target}"; chmod +x "${target}"; "${target}" >/dev/null 2>&1 &`;
            spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
            setTimeout(() => app.quit(), 400);
            return { success: true, quitting: true };
        }

        case 'deb': {
            const result = await runPrivileged('dpkg', ['-i', filePath]);
            if (!result.ok) return { success: false, error: result.error };
            app.relaunch();
            setTimeout(() => app.quit(), 400);
            return { success: true, quitting: true };
        }

        case 'rpm': {
            const result = await runPrivileged('rpm', ['-U', '--force', filePath]);
            if (!result.ok) return { success: false, error: result.error };
            app.relaunch();
            setTimeout(() => app.quit(), 400);
            return { success: true, quitting: true };
        }

        default:
            // dmg / dev builds: leave it to the user.
            await shell.openPath(filePath);
            return { success: true, quitting: false };
    }
}

module.exports = { checkForUpdate, downloadAsset, installUpdate, detectFormat, isNewer };
