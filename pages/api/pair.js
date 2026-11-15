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

// Sanitize international phone numbers (specifically handles Morocco 21206 -> 2126)
function sanitizePhoneNumber(raw) {
  let clean = String(raw || '').replace(/[^0-9]/g, '');
  if (clean.startsWith('00')) {
    clean = clean.slice(2);
  }
  // Morocco fix: if entered with 0 after 212 (e.g. 21206... or 21207... or 21205...)
  if (clean.startsWith('2120') && clean.length >= 12) {
    clean = '212' + clean.slice(4);
  }
  // If user entered local Moroccan number without country code (06... or 07...)
  if ((clean.startsWith('06') || clean.startsWith('07') || clean.startsWith('05')) && clean.length === 10) {
    clean = '212' + clean.slice(1);
  }
  return clean;
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

  const cleanNumber = sanitizePhoneNumber(number);
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
      sessionId: finalSessionId,
      number: cleanNumber
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
      const { 
        useMultiFileAuthState, 
        delay, 
        DisconnectReason,
        fetchLatestBaileysVersion,
        makeCacheableSignalKeyStore 
      } = baileys;

      const pino = (await import('pino')).default;
      const NodeCache = (await import('node-cache')).default;
      const os = await import('os');
      const path = await import('path');

      tempDir = path.join(os.tmpdir(), `adam_auth_${cleanNumber}_${Date.now()}`);
      const { state, saveCreds } = await useMultiFileAuthState(tempDir);
      const logger = pino({ level: 'silent' });

      // Fetch latest WhatsApp Web version to prevent "Couldn't link device" protocol mismatches
      let version = [2, 3000, 1015901307];
      try {
        const v = await fetchLatestBaileysVersion();
        if (v?.version) version = v.version;
      } catch (e) {}

      const msgRetryCounterCache = new NodeCache();

      sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        // Canonical Ubuntu Chrome browser signature required for WhatsApp pairing code
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(state.keys, logger) : state.keys,
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
      });

      sock.ev.on('creds.update', saveCreds);

      // Listen for connection update
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          console.log(`[ADAM] WhatsApp connected successfully for ${cleanNumber}`);
          sendEvent({
            status: 'CONNECTED',
            message: 'CONNECTED. FINALIZING...',
            sessionId: finalSessionId
          });

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

      // Wait 3 seconds for WebSocket baseline
      await delay(3000);

      const rawCode = await sock.requestPairingCode(cleanNumber);
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
    const { 
      useMultiFileAuthState, 
      delay, 
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore 
    } = baileys;

    const pino = (await import('pino')).default;
    const NodeCache = (await import('node-cache')).default;
    const os = await import('os');
    const path = await import('path');

    const tempDir = path.join(os.tmpdir(), `adam_auth_${cleanNumber}_${Date.now()}`);
    const { state, saveCreds } = await useMultiFileAuthState(tempDir);
    const logger = pino({ level: 'silent' });

    let version = [2, 3000, 1015901307];
    try {
      const v = await fetchLatestBaileysVersion();
      if (v?.version) version = v.version;
    } catch (e) {}

    const msgRetryCounterCache = new NodeCache();

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(state.keys, logger) : state.keys,
      },
      msgRetryCounterCache,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000,
    });

    sock.ev.on('creds.update', saveCreds);

    const sessionRecord = {
      sock,
      status: 'WAITING',
      number: cleanNumber,
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

    const code = await sock.requestPairingCode(cleanNumber);
    const cleanCode = code ? String(code).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : '';
    const formatted = cleanCode.length === 8 
      ? `${cleanCode.slice(0, 4)} - ${cleanCode.slice(4)}`
      : cleanCode;

    return res.status(200).json({
      ok: true,
      number: cleanNumber,
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
