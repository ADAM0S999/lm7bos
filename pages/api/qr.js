export const maxDuration = 60;

function sanitizePhone(raw) {
  let n = String(raw || '').replace(/[^0-9]/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('2120') && n.length >= 12) n = '212' + n.slice(4);
  if ((n.startsWith('06') || n.startsWith('07') || n.startsWith('05')) && n.length === 10) {
    n = '212' + n.slice(1);
  }
  return n;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  };

  const hb = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) {}
  }, 4000);

  let sock = null, tempDir = null;

  const cleanup = async () => {
    clearInterval(hb);
    if (sock) { try { sock.end(); } catch (e) {} sock = null; }
    if (tempDir) {
      try {
        const { existsSync, rmSync } = await import('fs');
        if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
      tempDir = null;
    }
  };

  req.on('close', () => { cleanup(); });

  try {
    send({ status: 'INIT', message: 'Connecting to WhatsApp servers…' });

    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const {
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      DisconnectReason,
      delay,
    } = baileys;

    const pino = (await import('pino')).default;
    const qrcode = await import('qrcode');
    const { tmpdir } = await import('os');
    const { join } = await import('path');

    const uid = `adam_qr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    tempDir = join(tmpdir(), uid);

    const { state, saveCreds } = await useMultiFileAuthState(tempDir);
    const logger = pino({ level: 'silent' });

    let version = [2, 3000, 1015901307];
    try { const v = await fetchLatestBaileysVersion(); if (v?.version) version = v.version; } catch (e) {}

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore ? makeCacheableSignalKeyStore(state.keys, logger) : state.keys,
      },
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 10000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 300 });
          send({ status: 'QR', qr: qrDataUrl, message: 'Scan this QR code with WhatsApp' });
        } catch (e) {
          send({ status: 'ERROR', message: 'Failed to generate QR image: ' + e.message });
        }
      }

      if (connection === 'open') {
        send({ status: 'CONNECTED', message: 'CONNECTED. FINALIZING...' });
        await delay(2000);

        let b64 = '';
        try {
          if (state.creds) {
            b64 = `lm7bos_${Buffer.from(JSON.stringify(state.creds)).toString('base64')}`;
          }
        } catch (e) {}

        send({ status: 'FINALIZED', b64SessionId: b64, message: 'Session linked successfully!' });

        setTimeout(async () => {
          await cleanup();
          try { res.end(); } catch (e) {}
        }, 3000);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          send({ status: 'ERROR', message: 'Connection closed. Please try again.' });
          await cleanup();
          try { res.end(); } catch (e) {}
        }
      }
    });

    // Timeout at 55 seconds
    setTimeout(async () => {
      send({ status: 'TIMEOUT', message: 'QR code expired. Please refresh and try again.' });
      await cleanup();
      try { res.end(); } catch (e) {}
    }, 55000);

  } catch (err) {
    send({ status: 'ERROR', message: err.message || 'Failed to generate QR. Please try again.' });
    await cleanup();
    try { res.end(); } catch (e) {}
  }
}
