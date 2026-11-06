/**
 * Rie Context — VS Code & Antigravity Extension
 *
 * Streams active workspace, file path, language, git branch, and file change diffs to Rie AI.
 * 
 * Rules:
 * - Does NOT capture keystrokes.
 * - Does NOT capture the entire editor content continuously.
 * - Only captures context + meaningful changes (save events).
 */

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

// In-memory state
let statusBarItem;
let isEnabled = true;
let totalEventsSent = 0;
let lastSentEvent = { file: null, time: 0 };
let fileSnapshots = new Map(); // uri -> { lineCount, linesSet }
let offlineQueue = [];
const MAX_OFFLINE_QUEUE = 30;

let remoteConfig = {
  workstream: true,
  sensors: { ide: true },
  privacy: { track_file_changes: true },
};
let lastRemoteConfigSync = 0;

/**
 * Periodically syncs sensor enablement state with the local Rie backend.
 */
function syncRemoteConfig() {
  const now = Date.now();
  if (now - lastRemoteConfigSync < 10000) {
    return Promise.resolve(remoteConfig);
  }
  const config = vscode.workspace.getConfiguration('rie');
  const endpointUrl = config.get('endpoint', 'http://localhost:14300/workstream/events');
  const configUrl = endpointUrl.replace(/\/workstream\/events\/?$/, '') + '/workstream/config';

  return new Promise((resolve) => {
    try {
      const url = new URL(configUrl);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.get({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        timeout: 1500
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              remoteConfig = JSON.parse(data);
              lastRemoteConfigSync = now;
              const isRemotelyDisabled = !remoteConfig.workstream || (remoteConfig.sensors && remoteConfig.sensors.ide === false);
              if (isRemotelyDisabled) {
                updateStatusBar('paused');
              } else if (isEnabled) {
                updateStatusBar('connected');
              }
            } catch (e) {}
          }
          resolve(remoteConfig);
        });
      });
      req.on('error', () => resolve(remoteConfig));
      req.on('timeout', () => { req.destroy(); resolve(remoteConfig); });
    } catch (err) {
      resolve(remoteConfig);
    }
  });
}

/**
 * Detects whether running inside Antigravity, VS Code, Cursor, or VSCodium.
 */
function getIdeName() {
  const appName = vscode.env.appName || '';
  const lower = appName.toLowerCase();
  if (lower.includes('antigravity')) return 'Antigravity';
  if (lower.includes('cursor')) return 'Cursor';
  if (lower.includes('codium')) return 'VSCodium';
  if (lower.includes('visual studio code')) return 'VS Code';
  return appName || 'Antigravity';
}

/**
 * Capitalizes programming language ID nicely (e.g. python -> Python).
 */
function formatLanguage(langId) {
  if (!langId) return 'Plain Text';
  const specialMap = {
    python: 'Python',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    javascriptreact: 'React JSX',
    typescriptreact: 'React TSX',
    rust: 'Rust',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    html: 'HTML',
    css: 'CSS',
    json: 'JSON',
    markdown: 'Markdown',
    go: 'Go',
    java: 'Java',
    shellscript: 'Shell',
    powershell: 'PowerShell',
  };
  return specialMap[langId.toLowerCase()] || (langId.charAt(0).toUpperCase() + langId.slice(1));
}

/**
 * Retrieves current Git branch and status using VS Code's built-in Git extension or fallback.
 */
function getGitInfo(uri) {
  try {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension && gitExtension.isActive) {
      const git = gitExtension.exports.getAPI(1);
      if (git && git.repositories && git.repositories.length > 0) {
        const repo = uri ? (git.getRepository(uri) || git.repositories[0]) : git.repositories[0];
        if (repo && repo.state) {
          const branch = repo.state.HEAD?.name || 'HEAD';
          const isDirty = (repo.state.workingTreeChanges?.length || 0) > 0;
          return {
            branch: branch,
            status: isDirty ? 'modified' : 'clean'
          };
        }
      }
    }
  } catch (e) {
    // Git API unavailable
  }

  // Fallback: Check .git/HEAD in workspace root
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const headPath = path.join(workspaceFolders[0].uri.fsPath, '.git', 'HEAD');
      if (fs.existsSync(headPath)) {
        const content = fs.readFileSync(headPath, 'utf8').trim();
        if (content.startsWith('ref: refs/heads/')) {
          return { branch: content.replace('ref: refs/heads/', ''), status: 'unknown' };
        }
      }
    }
  } catch (e) {
    // Ignore fallback errors
  }

  return { branch: null, status: null };
}

/**
 * Dispatches JSON payload to Rie endpoint via native HTTP/HTTPS.
 */
async function sendToBackend(payload) {
  if (!isEnabled) return false;

  const rConfig = await syncRemoteConfig();
  if (!rConfig.workstream || (rConfig.sensors && rConfig.sensors.ide === false)) {
    updateStatusBar('paused');
    return false;
  }

  const config = vscode.workspace.getConfiguration('rie');
  const endpointUrl = config.get('endpoint', 'http://localhost:14300/workstream/events');

  return new Promise((resolve) => {
    try {
      const url = new URL(endpointUrl);
      const postData = JSON.stringify(payload);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 3000
      }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          totalEventsSent++;
          updateStatusBar('connected');
          
          // Flush offline queue if needed
          if (offlineQueue.length > 0) {
            flushOfflineQueue(endpointUrl);
          }
          resolve(true);
        } else {
          handleOffline(payload);
          resolve(false);
        }
      });

      req.on('error', () => {
        handleOffline(payload);
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        handleOffline(payload);
        resolve(false);
      });

      req.write(postData);
      req.end();
    } catch (err) {
      handleOffline(payload);
      resolve(false);
    }
  });
}

function handleOffline(payload) {
  updateStatusBar('offline');
  if (offlineQueue.length >= MAX_OFFLINE_QUEUE) {
    offlineQueue.shift();
  }
  offlineQueue.push(payload);
}

function flushOfflineQueue(endpointUrl) {
  if (offlineQueue.length === 0) return;
  const toFlush = [...offlineQueue];
  offlineQueue = [];

  try {
    const url = new URL(endpointUrl);
    const postData = JSON.stringify(toFlush);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 3000
    });
    req.on('error', () => {
      offlineQueue = [...toFlush, ...offlineQueue].slice(-MAX_OFFLINE_QUEUE);
    });
    req.write(postData);
    req.end();
  } catch (e) {
    offlineQueue = [...toFlush, ...offlineQueue].slice(-MAX_OFFLINE_QUEUE);
  }
}

/**
 * Updates status bar item with current state.
 */
function updateStatusBar(status) {
  if (!statusBarItem) return;

  if (!isEnabled) {
    statusBarItem.text = `$(debug-pause) Rie: Paused`;
    statusBarItem.tooltip = `Rie Context: Tracking is paused. Click to resume.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (status === 'connected') {
    statusBarItem.text = `$(zap) Rie: Active`;
    statusBarItem.tooltip = `Rie Context: Connected • ${totalEventsSent} events sent. Click to test.`;
    statusBarItem.backgroundColor = undefined;
  } else if (status === 'offline') {
    statusBarItem.text = `$(circle-slash) Rie: Offline`;
    statusBarItem.tooltip = `Rie Context: Server unreachable. Buffering events locally.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }
  statusBarItem.show();
}

/**
 * Handles active text editor focus shift.
 */
let debounceTimer = null;
async function handleActiveEditorChange(editor) {
  if (!editor || !editor.document) return;

  const doc = editor.document;
  // Ignore internal non-file editors (output, git diffs, settings)
  if (doc.uri.scheme !== 'file') return;

  // Remote Sensor Control: Halt if Workstream or IDE sensor is disabled
  const rConfig = await syncRemoteConfig();
  if (!isEnabled || !rConfig.workstream || (rConfig.sensors && rConfig.sensors.ide === false)) {
    updateStatusBar('paused');
    return;
  }

  const config = vscode.workspace.getConfiguration('rie');
  const debounceSecs = config.get('debounceSeconds', 1);

  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(async () => {
    const rConfigNow = await syncRemoteConfig();
    if (!isEnabled || !rConfigNow.workstream || (rConfigNow.sensors && rConfigNow.sensors.ide === false)) {
      return;
    }

    const filePath = doc.uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(doc.uri, false);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const workspaceName = workspaceFolder ? workspaceFolder.name : (vscode.workspace.name || path.basename(filePath));
    const language = formatLanguage(doc.languageId);
    const gitInfo = getGitInfo(doc.uri);

    const now = Date.now();
    // Skip redundant duplicate pulse within 1.5 seconds
    if (lastSentEvent.file === relativePath && now - lastSentEvent.time < 1500) {
      return;
    }

    lastSentEvent = { file: relativePath, time: now };

    const payload = {
      event_type: 'ide_context',
      ide: getIdeName(),
      workspace: workspaceName,
      file: relativePath,
      language: language,
      git_branch: gitInfo.branch,
      git_status: gitInfo.status,
      timestamp: new Date().toISOString()
    };

    // Prime snapshot for diff calculation
    if (!fileSnapshots.has(doc.uri.toString())) {
      fileSnapshots.set(doc.uri.toString(), doc.lineCount);
    }

    await sendToBackend(payload);
  }, debounceSecs * 1000);
}

/**
 * Handles file save event — computes lines added / lines removed diff stats without reading continuous contents.
 */
async function handleFileSave(document) {
  if (document.uri.scheme !== 'file') return;

  // Remote Sensor Control: Halt if Workstream or IDE sensor is disabled
  const rConfig = await syncRemoteConfig();
  if (!isEnabled || !rConfig.workstream || (rConfig.sensors && rConfig.sensors.ide === false)) {
    return;
  }
  // Privacy setting: do not track file change diffs if disabled
  if (rConfig.privacy && rConfig.privacy.track_file_changes === false) {
    return;
  }

  const config = vscode.workspace.getConfiguration('rie');
  if (!config.get('trackFileChanges', true)) return;

  const uriStr = document.uri.toString();
  const currentLines = document.lineCount;
  const previousLines = fileSnapshots.get(uriStr) || currentLines;

  let linesAdded = 0;
  let linesRemoved = 0;

  if (currentLines > previousLines) {
    linesAdded = currentLines - previousLines;
  } else if (previousLines > currentLines) {
    linesRemoved = previousLines - currentLines;
  }

  // Update snapshot
  fileSnapshots.set(uriStr, currentLines);

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const workspaceName = workspaceFolder ? workspaceFolder.name : (vscode.workspace.name || '');
  const fileName = path.basename(document.fileName);

  const payload = {
    event_type: 'file_change',
    ide: getIdeName(),
    workspace: workspaceName,
    file: fileName,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    timestamp: new Date().toISOString()
  };

  await sendToBackend(payload);
}

/**
 * Extension Activation
 */
function activate(context) {
  const config = vscode.workspace.getConfiguration('rie');
  isEnabled = config.get('enabled', true);

  // Status Bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'rie.showStatus';
  context.subscriptions.push(statusBarItem);
  updateStatusBar('connected');

  // Listeners
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(handleActiveEditorChange)
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(handleFileSave)
  );

  // Configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('rie.enabled')) {
        isEnabled = vscode.workspace.getConfiguration('rie').get('enabled', true);
        updateStatusBar(isEnabled ? 'connected' : 'paused');
      }
    })
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('rie.toggleTracking', () => {
      isEnabled = !isEnabled;
      vscode.workspace.getConfiguration('rie').update('enabled', isEnabled, vscode.ConfigurationTarget.Global);
      updateStatusBar(isEnabled ? 'connected' : 'paused');
      vscode.window.showInformationMessage(`Rie Context Tracking is now ${isEnabled ? 'Active' : 'Paused'}.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rie.testConnection', async () => {
      const endpoint = vscode.workspace.getConfiguration('rie').get('endpoint', 'http://localhost:14300/workstream/events');
      const statusUrl = endpoint.replace(/\/workstream\/events\/?$/, '') + '/workstream/status';

      try {
        const start = Date.now();
        const url = new URL(statusUrl);
        const client = url.protocol === 'https:' ? https : http;

        const req = client.get({
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname,
          timeout: 3000
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const latency = Date.now() - start;
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(data);
                vscode.window.showInformationMessage(
                  `✓ Rie Connected (${latency}ms) • ${parsed.total_activities || 0} events recorded in SQLite.`
                );
                updateStatusBar('connected');
              } catch {
                vscode.window.showInformationMessage(`✓ Rie Connected (${latency}ms)`);
                updateStatusBar('connected');
              }
            } else {
              vscode.window.showErrorMessage(`✗ Rie Backend returned HTTP ${res.statusCode}`);
              updateStatusBar('offline');
            }
          });
        });

        req.on('error', (err) => {
          vscode.window.showErrorMessage(`✗ Could not reach Rie backend: ${err.message}`);
          updateStatusBar('offline');
        });
      } catch (err) {
        vscode.window.showErrorMessage(`✗ Connection error: ${err.message}`);
        updateStatusBar('offline');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rie.showStatus', async () => {
      const selection = await vscode.window.showQuickPick(
        [
          { label: `$(zap) Status: ${isEnabled ? 'Active' : 'Paused'}`, description: `Total events sent: ${totalEventsSent}` },
          { label: '$(sync) Test Connection', description: 'Ping local Rie Workstream API' },
          { label: isEnabled ? '$(debug-pause) Pause Tracking' : '$(play) Resume Tracking', description: 'Toggle context transmission' },
          { label: '$(gear) Configure Endpoint', description: 'Change backend URL' }
        ],
        { placeHolder: 'Rie Context — Companion Status' }
      );

      if (!selection) return;

      if (selection.label.includes('Test Connection')) {
        vscode.commands.executeCommand('rie.testConnection');
      } else if (selection.label.includes('Pause') || selection.label.includes('Resume')) {
        vscode.commands.executeCommand('rie.toggleTracking');
      } else if (selection.label.includes('Configure')) {
        vscode.commands.executeCommand('workbench.action.openSettings', 'rie');
      }
    })
  );

  // Initial remote config sync and periodic refresh every 10s
  syncRemoteConfig();
  const syncInterval = setInterval(syncRemoteConfig, 10000);
  context.subscriptions.push({ dispose: () => clearInterval(syncInterval) });

  // Trigger initial context for currently active editor
  if (vscode.window.activeTextEditor) {
    handleActiveEditorChange(vscode.window.activeTextEditor);
  }

  console.log(`[Rie Context] Extension activated on ${getIdeName()}`);
}

function deactivate() {
  if (statusBarItem) statusBarItem.dispose();
  fileSnapshots.clear();
}

module.exports = {
  activate,
  deactivate
};
