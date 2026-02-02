import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { ensureMoltbotGateway, findExistingMoltbotProcess } from '../gateway';
import loadingPageHtml from '../assets/loading.html';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }

  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }

  return message;
}

/**
 * WebSocket routes - NO Cloudflare Access authentication required
 *
 * These routes handle WebSocket connections from Clawdbot CLI.
 * Authentication is via gateway token (?token=...) validated by the container.
 */
const websocket = new Hono<AppEnv>();

// GET /ws - WebSocket proxy to Moltbot gateway
websocket.get('/ws', async (c) => {
  const request = c.req.raw;
  const url = new URL(request.url);
  const sandbox = c.get('sandbox');

  // Require WebSocket upgrade
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  if (!isWebSocketRequest) {
    return c.json({ error: 'WebSocket upgrade required' }, 426);
  }

  console.log('[WS] Proxying WebSocket connection to Moltbot');
  console.log('[WS] URL:', request.url);
  console.log('[WS] Search params:', url.search);

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // If gateway isn't ready, start it and wait
  if (!isGatewayReady) {
    console.log('[WS] Gateway not ready, starting...');
    try {
      await ensureMoltbotGateway(sandbox, c.env);
    } catch (error) {
      console.error('[WS] Failed to start Moltbot:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return c.json({
        error: 'Moltbot gateway failed to start',
        details: errorMessage,
      }, 503);
    }
  }

  // Get WebSocket connection to the container
  const containerResponse = await sandbox.wsConnect(request, MOLTBOT_PORT);
  console.log('[WS] wsConnect response status:', containerResponse.status);

  // Get the container-side WebSocket
  const containerWs = containerResponse.webSocket;
  if (!containerWs) {
    console.error('[WS] No WebSocket in container response - falling back to direct proxy');
    return containerResponse;
  }

  console.log('[WS] Got container WebSocket, setting up interception');

  // Create a WebSocket pair for the client
  const [clientWs, serverWs] = Object.values(new WebSocketPair());

  // Accept both WebSockets
  serverWs.accept();
  containerWs.accept();

  console.log('[WS] Both WebSockets accepted');
  console.log('[WS] containerWs.readyState:', containerWs.readyState);
  console.log('[WS] serverWs.readyState:', serverWs.readyState);

  // Relay messages from client to container
  serverWs.addEventListener('message', (event) => {
    console.log('[WS] Client -> Container:', typeof event.data, typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)');
    if (containerWs.readyState === WebSocket.OPEN) {
      containerWs.send(event.data);
    } else {
      console.log('[WS] Container not open, readyState:', containerWs.readyState);
    }
  });

  // Relay messages from container to client, with error transformation
  containerWs.addEventListener('message', (event) => {
    console.log('[WS] Container -> Client (raw):', typeof event.data, typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)');
    let data = event.data;

    // Try to intercept and transform error messages
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        console.log('[WS] Parsed JSON, has error.message:', !!parsed.error?.message);
        if (parsed.error?.message) {
          console.log('[WS] Original error.message:', parsed.error.message);
          parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
          console.log('[WS] Transformed error.message:', parsed.error.message);
          data = JSON.stringify(parsed);
        }
      } catch (e) {
        console.log('[WS] Not JSON or parse error:', e);
      }
    }

    if (serverWs.readyState === WebSocket.OPEN) {
      serverWs.send(data);
    } else {
      console.log('[WS] Server not open, readyState:', serverWs.readyState);
    }
  });

  // Handle close events
  serverWs.addEventListener('close', (event) => {
    console.log('[WS] Client closed:', event.code, event.reason);
    containerWs.close(event.code, event.reason);
  });

  containerWs.addEventListener('close', (event) => {
    console.log('[WS] Container closed:', event.code, event.reason);
    // Transform the close reason (truncate to 123 bytes max for WebSocket spec)
    let reason = transformErrorMessage(event.reason, url.host);
    if (reason.length > 123) {
      reason = reason.slice(0, 120) + '...';
    }
    console.log('[WS] Transformed close reason:', reason);
    serverWs.close(event.code, reason);
  });

  // Handle errors
  serverWs.addEventListener('error', (event) => {
    console.error('[WS] Client error:', event);
    containerWs.close(1011, 'Client error');
  });

  containerWs.addEventListener('error', (event) => {
    console.error('[WS] Container error:', event);
    serverWs.close(1011, 'Container error');
  });

  console.log('[WS] Returning intercepted WebSocket response');
  return new Response(null, {
    status: 101,
    webSocket: clientWs,
  });
});

export { websocket };
