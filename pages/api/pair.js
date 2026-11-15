export const maxDuration = 60; // Allow up to 60 seconds on Vercel

global._activeSockets = global._activeSockets || new Map();

// Generate session ID helper
function generateSessionId(customName = null) {
  const prefix = 'lm7bos';
  if (customName && typeof customName === 'string' && customName.trim().length > 0) {
    const cleanName = customName.trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    if (cleanName.length > 0) {
      return `${prefix}_${cleanName}`;
    }
  }
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let randomPart = '';
  for (let i = 0; i < 10; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `${prefix}_adjacency${randomPart}`;
}

export default async function handler(req, res) {
  // ── GET: Check connection status for real-time login (polling fallback) ──
  if (req.method === 'GET') {
    const { sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const session = global._activeSockets.get(sessionId);
    if (!session) {
      return res.status(200).json({
        status: 'WAITING',
        sessionId,
        message: 'Waiting for WhatsApp device confirmation...'
      });
    }

    return res.status(200).json({
      status: session.status || 'WAITING',
      sessionId,
      number: session.number,
      message: session.status === 'CONNECTED' ? 'Device connected successfully!' : 'Waiting for WhatsApp device confirmation...',
      connectedAt: session.connectedAt || null
    });
  }

  // ── POST: Request pairing code ──
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let { number, sessionName, sessionId, stream } = req.body || {};
  if (!number) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  number = String(number).replace(/[^0-9]/g, '');
  const finalSessionId = sessionId || generateSessionId(sessionName);
  const isSse = stream || req.headers['accept']?.includes('text/event-stream');

  if (isSse) {
    // ── SSE STREAMING MODE (Prevents Vercel Serverless Freeze) ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const sendEvent = (data) => {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (e) {}
    };

    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch (e) {}
    }, 3000);

    sendEvent({
      status: 'INIT',
      message: 'Connecting to WhatsApp servers…',
      sessionId: finalSessionId
    });

    let sock = null;
    let tempDir = null;

    const cleanup = async () => {
      clearInterval(heartbeat);
      if (sock) {
        try {
          sock.end();
        } catch (e) {}
        sock = null;
      }
      if (tempDir) {
        try {
          const fs = await import('fs');
          if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
          }
        } catch (e) {}
        tempDir = null;
      }
      global._activeSockets.delete(finalSessionId);
    };

    req.on('close', () => {
      cleanup();
    });

    try {
      const baileys = await import('@whiskeysockets/baileys');
      const makeWASocket = baileys.default || baileys.makeWASocket;
      const { useMultiFileAuthState, Browsers, delay, DisconnectReason } = baileys;
      const pino = (await import('pino')).default;
      const os = await import('os');
      const path = await import('path');

      tempDir = path.join(os.tmpdir(), `adam_auth_${number}_${Date.now()}`);
      const { state, saveCreds } = await useMultiFileAuthState(tempDir);
      const logger = pino({ level: 'silent' });

      sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });

      sock.ev.on('creds.update', saveCreds);

      // Listen for connection update
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          console.log(`[ADAM] WhatsApp connected successfully for ${number}`);
          sendEvent({
            status: 'CONNECTED',
            message: 'CONNECTED. FINALIZING...',
            sessionId: finalSessionId
          });

          // Wait 2 seconds for creds to write
          await delay(2000);

          let b64Session = finalSessionId;
          try {
            if (state.creds) {
              b64Session = `lm7bos_${Buffer.from(JSON.stringify(state.creds)).toString('base64')}`;
            }
          } catch (e) {}

          sendEvent({
            status: 'FINALIZED',
            sessionId: finalSessionId,
            b64SessionId: b64Session,
            message: 'Session linked successfully!'
          });

          setTimeout(async () => {
            await cleanup();
            try {
              res.end();
            } catch (e) {}
          }, 3000);

        } else if (connection === 'close') {
          const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
          if (isLoggedOut) {
            sendEvent({
              status: 'ERROR',
              message: 'Connection closed or logged out. Please request a new pairing code.'
            });
            await cleanup();
            try {
              res.end();
            } catch (e) {}
          }
        }
      });

      // Wait 3 seconds for handshake
      await delay(3000);

      const rawCode = await sock.requestPairingCode(number);
      const cleanCode = rawCode ? String(rawCode).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : '';
      const formatted = cleanCode.length === 8 
        ? `${cleanCode.slice(0, 4)} - ${cleanCode.slice(4)}`
        : cleanCode;

      sendEvent({
        status: 'CODE',
        code: cleanCode,
        formattedCode: formatted,
        sessionId: finalSessionId,
        message: 'Enter code on your phone in WhatsApp'
      });

      // Timeout at 55 seconds (before Vercel's 60s maxDuration limit)
      setTimeout(async () => {
        sendEvent({
          status: 'TIMEOUT',
          message: 'Pairing timed out. You can click "CONNECTED. FINALIZING..." or request a new code.'
        });
        await cleanup();
        try {
          res.end();
        } catch (e) {}
      }, 55000);

    } catch (err) {
      console.error('[ADAM Pair Error]:', err);
      sendEvent({
        status: 'ERROR',
        message: err.message || 'Failed to request pairing code. If connection fails, try using a VPN.'
      });
      await cleanup();
      try {
        res.end();
      } catch (e) {}
    }
    return;
  }

  // ── STANDARD JSON FALLBACK MODE ──
  try {
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, Browsers, delay, DisconnectReason } = baileys;
    const pino = (await import('pino')).default;
    const os = await import('os');
    const path = await import('path');

    const tempDir = path.join(os.tmpdir(), `adam_auth_${number}_${Date.now()}`);
    const { state, saveCreds } = await useMultiFileAuthState(tempDir);
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    const sessionRecord = {
      sock,
      status: 'WAITING',
      number,
      sessionId: finalSessionId,
      createdAt: Date.now()
    };
    global._activeSockets.set(finalSessionId, sessionRecord);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        sessionRecord.status = 'CONNECTED';
        sessionRecord.connectedAt = Date.now();
      } else if (connection === 'close') {
        const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
        if (isLoggedOut) {
          sessionRecord.status = 'DISCONNECTED';
        }
      }
    });

    await delay(3000);

    const code = await sock.requestPairingCode(number);
    const cleanCode = code ? String(code).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : '';
    const formatted = cleanCode.length === 8 
      ? `${cleanCode.slice(0, 4)} - ${cleanCode.slice(4)}`
      : cleanCode;

    return res.status(200).json({
      ok: true,
      number,
      sessionId: finalSessionId,
      code: cleanCode || formatted,
      formattedCode: formatted,
      message: 'Enter code in WhatsApp -> Linked Devices -> Link with phone number'
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      sessionId: finalSessionId,
      error: err.message || String(err)
    });
  }
}
