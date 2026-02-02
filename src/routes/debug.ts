import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { findExistingMoltbotProcess } from '../gateway';

/**
 * Debug routes for inspecting container state
 * Note: These routes should be protected by Cloudflare Access middleware
 * when mounted in the main app
 */
const debug = new Hono<AppEnv>();

// GET /debug/version - Returns version info from inside the container
debug.get('/version', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    // Get moltbot version (CLI is still named clawdbot until upstream renames)
    const versionProcess = await sandbox.startProcess('openclaw --version');
    await new Promise(resolve => setTimeout(resolve, 500));
    const versionLogs = await versionProcess.getLogs();
    const moltbotVersion = (versionLogs.stdout || versionLogs.stderr || '').trim();

    // Get node version
    const nodeProcess = await sandbox.startProcess('node --version');
    await new Promise(resolve => setTimeout(resolve, 500));
    const nodeLogs = await nodeProcess.getLogs();
    const nodeVersion = (nodeLogs.stdout || '').trim();

    return c.json({
      moltbot_version: moltbotVersion,
      node_version: nodeVersion,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ status: 'error', message: `Failed to get version info: ${errorMessage}` }, 500);
  }
});

// GET /debug/processes - List all processes with optional logs
debug.get('/processes', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    const includeLogs = c.req.query('logs') === 'true';

    const processData = await Promise.all(processes.map(async p => {
      const data: Record<string, unknown> = {
        id: p.id,
        command: p.command,
        status: p.status,
        startTime: p.startTime?.toISOString(),
        endTime: p.endTime?.toISOString(),
        exitCode: p.exitCode,
      };

      if (includeLogs) {
        try {
          const logs = await p.getLogs();
          data.stdout = logs.stdout || '';
          data.stderr = logs.stderr || '';
        } catch {
          data.logs_error = 'Failed to retrieve logs';
        }
      }

      return data;
    }));

    // Sort by status (running first, then starting, completed, failed)
    // Within each status, sort by startTime descending (newest first)
    const statusOrder: Record<string, number> = {
      'running': 0,
      'starting': 1,
      'completed': 2,
      'failed': 3,
    };
    
    processData.sort((a, b) => {
      const statusA = statusOrder[a.status as string] ?? 99;
      const statusB = statusOrder[b.status as string] ?? 99;
      if (statusA !== statusB) {
        return statusA - statusB;
      }
      // Within same status, sort by startTime descending
      const timeA = a.startTime as string || '';
      const timeB = b.startTime as string || '';
      return timeB.localeCompare(timeA);
    });

    return c.json({ count: processes.length, processes: processData });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/gateway-api - Probe the moltbot gateway HTTP API
debug.get('/gateway-api', async (c) => {
  const sandbox = c.get('sandbox');
  const path = c.req.query('path') || '/';
  const MOLTBOT_PORT = 18789;
  
  try {
    const url = `http://localhost:${MOLTBOT_PORT}${path}`;
    const response = await sandbox.containerFetch(new Request(url), MOLTBOT_PORT);
    const contentType = response.headers.get('content-type') || '';
    
    let body: string | object;
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }
    
    return c.json({
      path,
      status: response.status,
      contentType,
      body,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, path }, 500);
  }
});

// GET /debug/cli - Test moltbot CLI commands (CLI is still named clawdbot)
// Supports ?timeout=N parameter for long-running commands (default 15s, max 120s)
debug.get('/cli', async (c) => {
  const sandbox = c.get('sandbox');
  const cmd = c.req.query('cmd') || 'openclaw --help';
  const timeoutSecs = Math.min(parseInt(c.req.query('timeout') || '15', 10), 120);
  const maxAttempts = timeoutSecs * 2; // 500ms per attempt

  try {
    const proc = await sandbox.startProcess(cmd);

    // Wait for command to complete (configurable timeout)
    let attempts = 0;
    while (attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 500));
      if (proc.status !== 'running') break;
      attempts++;
    }

    const logs = await proc.getLogs();
    return c.json({
      command: cmd,
      status: proc.status,
      exitCode: proc.exitCode,
      attempts,
      timeoutSecs,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, command: cmd }, 500);
  }
});

// GET /debug/logs - Returns container logs for debugging
debug.get('/logs', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processId = c.req.query('id');
    let process = null;

    if (processId) {
      const processes = await sandbox.listProcesses();
      process = processes.find(p => p.id === processId);
      if (!process) {
        return c.json({
          status: 'not_found',
          message: `Process ${processId} not found`,
          stdout: '',
          stderr: '',
        }, 404);
      }
    } else {
      process = await findExistingMoltbotProcess(sandbox);
      if (!process) {
        return c.json({
          status: 'no_process',
          message: 'No Moltbot process is currently running',
          stdout: '',
          stderr: '',
        });
      }
    }

    const logs = await process.getLogs();
    return c.json({
      status: 'ok',
      process_id: process.id,
      process_status: process.status,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      status: 'error',
      message: `Failed to get logs: ${errorMessage}`,
      stdout: '',
      stderr: '',
    }, 500);
  }
});

// GET /debug/ws-test - Interactive WebSocket debug page
debug.get('/ws-test', async (c) => {
  const host = c.req.header('host') || 'localhost';
  const protocol = c.req.header('x-forwarded-proto') || 'https';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>WebSocket Debug</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #1a1a1a; color: #0f0; }
    #log { white-space: pre-wrap; background: #000; padding: 10px; height: 400px; overflow-y: auto; border: 1px solid #333; }
    button { margin: 5px; padding: 10px; }
    input { padding: 10px; width: 300px; }
    .error { color: #f00; }
    .sent { color: #0ff; }
    .received { color: #0f0; }
    .info { color: #ff0; }
  </style>
</head>
<body>
  <h1>WebSocket Debug Tool</h1>
  <div>
    <button id="connect">Connect</button>
    <button id="disconnect" disabled>Disconnect</button>
    <button id="clear">Clear Log</button>
  </div>
  <div style="margin: 10px 0;">
    <input id="message" placeholder="JSON message to send..." />
    <button id="send" disabled>Send</button>
  </div>
  <div style="margin: 10px 0;">
    <button id="sendConnect" disabled>Send Connect Frame</button>
  </div>
  <div id="log"></div>
  
  <script>
    const wsUrl = '${wsProtocol}://${host}/';
    let ws = null;
    
    const log = (msg, className = '') => {
      const logEl = document.getElementById('log');
      const time = new Date().toISOString().substr(11, 12);
      logEl.innerHTML += '<span class="' + className + '">[' + time + '] ' + msg + '</span>\\n';
      logEl.scrollTop = logEl.scrollHeight;
    };
    
    document.getElementById('connect').onclick = () => {
      log('Connecting to ' + wsUrl + '...', 'info');
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        log('Connected!', 'info');
        document.getElementById('connect').disabled = true;
        document.getElementById('disconnect').disabled = false;
        document.getElementById('send').disabled = false;
        document.getElementById('sendConnect').disabled = false;
      };
      
      ws.onmessage = (e) => {
        log('RECV: ' + e.data, 'received');
        try {
          const parsed = JSON.parse(e.data);
          log('  Parsed: ' + JSON.stringify(parsed, null, 2), 'received');
        } catch {}
      };
      
      ws.onerror = (e) => {
        log('ERROR: ' + JSON.stringify(e), 'error');
      };
      
      ws.onclose = (e) => {
        log('Closed: code=' + e.code + ' reason=' + e.reason, 'info');
        document.getElementById('connect').disabled = false;
        document.getElementById('disconnect').disabled = true;
        document.getElementById('send').disabled = true;
        document.getElementById('sendConnect').disabled = true;
        ws = null;
      };
    };
    
    document.getElementById('disconnect').onclick = () => {
      if (ws) ws.close();
    };
    
    document.getElementById('clear').onclick = () => {
      document.getElementById('log').innerHTML = '';
    };
    
    document.getElementById('send').onclick = () => {
      const msg = document.getElementById('message').value;
      if (ws && msg) {
        log('SEND: ' + msg, 'sent');
        ws.send(msg);
      }
    };
    
    document.getElementById('sendConnect').onclick = () => {
      if (!ws) return;
      const connectFrame = {
        type: 'req',
        id: 'debug-' + Date.now(),
        method: 'connect',
        params: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: 'debug-tool',
            displayName: 'Debug Tool',
            version: '1.0.0',
            mode: 'webchat',
            platform: 'web'
          },
          role: 'operator',
          scopes: []
        }
      };
      const msg = JSON.stringify(connectFrame);
      log('SEND Connect Frame: ' + msg, 'sent');
      ws.send(msg);
    };
    
    document.getElementById('message').onkeypress = (e) => {
      if (e.key === 'Enter') document.getElementById('send').click();
    };
  </script>
</body>
</html>`;
  
  return c.html(html);
});

// GET /debug/terminal - Interactive terminal page for running CLI commands
debug.get('/terminal', async (c) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Moltbot Terminal</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #1a1a1a; color: #0f0; margin: 0; }
    h1 { color: #0f0; }
    #output {
      white-space: pre;
      background: #000;
      padding: 15px;
      min-height: 400px;
      overflow: auto;
      border: 1px solid #333;
      font-size: 12px;
      line-height: 1.2;
    }
    .input-row { margin: 10px 0; display: flex; gap: 10px; }
    input {
      padding: 10px;
      flex: 1;
      background: #000;
      color: #0f0;
      border: 1px solid #333;
      font-family: monospace;
    }
    button {
      padding: 10px 20px;
      background: #333;
      color: #0f0;
      border: 1px solid #0f0;
      cursor: pointer;
    }
    button:hover { background: #444; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .status { color: #ff0; margin: 10px 0; }
    .quick-cmds { margin: 10px 0; }
    .quick-cmds button { margin-right: 5px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Moltbot Terminal</h1>
  <div class="quick-cmds">
    Quick commands:
    <button onclick="runCmd('openclaw --version')">Version</button>
    <button onclick="runCmd('openclaw channels list')">List Channels</button>
    <button onclick="runCmd('openclaw channels login', 90)">Channel Login (QR)</button>
    <button onclick="runCmd('openclaw status')">Status</button>
  </div>
  <div class="input-row">
    <input id="cmd" value="openclaw --help" placeholder="Enter command..." />
    <button id="run" onclick="runCmd()">Run</button>
  </div>
  <div class="status" id="status"></div>
  <div id="output">Ready. Enter a command above.</div>

  <script>
    async function runCmd(cmd, timeout = 15) {
      const cmdInput = document.getElementById('cmd');
      const output = document.getElementById('output');
      const status = document.getElementById('status');
      const runBtn = document.getElementById('run');

      if (cmd) cmdInput.value = cmd;
      const command = cmdInput.value;

      output.textContent = 'Running: ' + command + '\\n(timeout: ' + timeout + 's)\\n\\n';
      status.textContent = 'Status: Running... (may take up to ' + timeout + 's)';
      runBtn.disabled = true;

      try {
        const resp = await fetch('/debug/cli?cmd=' + encodeURIComponent(command) + '&timeout=' + timeout);
        const data = await resp.json();

        if (data.error) {
          output.textContent = 'Error: ' + data.error;
          status.textContent = 'Status: Error';
        } else {
          output.textContent = data.stdout || '(no output)';
          if (data.stderr) {
            output.textContent += '\\n\\nSTDERR:\\n' + data.stderr;
          }
          status.textContent = 'Status: ' + data.status + ' (exit: ' + data.exitCode + ')';
        }
      } catch (e) {
        output.textContent = 'Request failed: ' + e.message;
        status.textContent = 'Status: Failed';
      }

      runBtn.disabled = false;
    }

    document.getElementById('cmd').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') runCmd();
    });
  </script>
</body>
</html>`;

  return c.html(html);
});

// GET /debug/env - Show environment configuration (sanitized)
debug.get('/env', async (c) => {
  return c.json({
    has_anthropic_key: !!c.env.ANTHROPIC_API_KEY,
    has_openai_key: !!c.env.OPENAI_API_KEY,
    has_gateway_token: !!c.env.MOLTBOT_GATEWAY_TOKEN,
    has_r2_access_key: !!c.env.R2_ACCESS_KEY_ID,
    has_r2_secret_key: !!c.env.R2_SECRET_ACCESS_KEY,
    has_cf_account_id: !!c.env.CF_ACCOUNT_ID,
    dev_mode: c.env.DEV_MODE,
    debug_routes: c.env.DEBUG_ROUTES,
    bind_mode: c.env.CLAWDBOT_BIND_MODE,
    cf_access_team_domain: c.env.CF_ACCESS_TEAM_DOMAIN,
    has_cf_access_aud: !!c.env.CF_ACCESS_AUD,
  });
});

// GET /debug/container-config - Read the moltbot config from inside the container
debug.get('/container-config', async (c) => {
  const sandbox = c.get('sandbox');
  
  try {
    const proc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    
    let attempts = 0;
    while (attempts < 10) {
      await new Promise(r => setTimeout(r, 200));
      if (proc.status !== 'running') break;
      attempts++;
    }

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';
    
    let config = null;
    try {
      config = JSON.parse(stdout);
    } catch {
      // Not valid JSON
    }
    
    return c.json({
      status: proc.status,
      exitCode: proc.exitCode,
      config,
      raw: config ? undefined : stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

export { debug };
