export const maxDuration = 60; // Allow up to 60 seconds on Vercel

// Helper to process full image with sharp into a 1:1 canvas without cropping
async function processFullImage(buffer, style = 'blur', sharp) {
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width || 720;
  const height = metadata.height || 720;

  // If already square (1:1), resize directly
  if (width === height) {
    return await sharp(buffer)
      .resize(720, 720, { fit: 'cover' })
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  const maxDimension = Math.max(width, height);
  const targetSize = Math.min(Math.max(maxDimension, 720), 1080);

  if (style === 'blur') {
    // Backdrop: blurred cover for full non-cropped display
    const background = await sharp(buffer)
      .resize(targetSize, targetSize, { fit: 'cover' })
      .blur(25)
      .modulate({ brightness: 0.65 })
      .toBuffer();

    // Foreground: full image contained inside proportionally
    const foreground = await sharp(buffer)
      .resize(targetSize, targetSize, { fit: 'inside' })
      .toBuffer();

    return await sharp(background)
      .composite([{ input: foreground, gravity: 'center' }])
      .jpeg({ quality: 95 })
      .toBuffer();
  } else {
    // Dark padding (#121217)
    return await sharp(buffer)
      .resize(targetSize, targetSize, {
        fit: 'contain',
        background: { r: 18, g: 18, b: 23, alpha: 1 }
      })
      .jpeg({ quality: 95 })
      .toBuffer();
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let { number, image, style = 'blur' } = req.body;
  if (!number) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  if (!image) {
    return res.status(400).json({ error: 'Image is required' });
  }

  const cleanNumber = String(number).replace(/[^0-9]/g, '');
  if (cleanNumber.length < 9) {
    return res.status(400).json({ error: 'Please enter a valid phone number with country code' });
  }

  // Extract base64 image buffer
  let imageBuffer;
  try {
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    imageBuffer = Buffer.from(base64Data, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'Invalid image format. Please upload JPG or PNG.' });
  }

  if (imageBuffer.length > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image size exceeds 5 MB limit.' });
  }

  // Set SSE streaming headers so Vercel keeps the connection and WebSocket ALIVE!
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

  // Heartbeat to prevent proxy / Vercel idle timeouts
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch (e) {}
  }, 3000);

  sendEvent({
    status: 'waiting',
    message: 'Starting secure connection to WhatsApp…'
  });

  let sock = null;
  let tempDir = null;

  const cleanup = async () => {
    clearInterval(heartbeat);
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {}
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

    tempDir = path.join(os.tmpdir(), `adam_pp_${cleanNumber}_${Date.now()}`);
    const { state, saveCreds } = await useMultiFileAuthState(tempDir);

    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // Active listener for WhatsApp connection
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        sendEvent({
          status: 'working',
          message: 'Linked successfully! Processing full resolution image…'
        });

        try {
          let processedBuffer;
          try {
            const sharpModule = await import('sharp');
            const sharp = sharpModule.default || sharpModule;
            processedBuffer = await processFullImage(imageBuffer, style, sharp);
          } catch (sharpError) {
            console.warn('[ProfilePicture] sharp fallback:', sharpError.message);
            processedBuffer = imageBuffer;
          }

          sendEvent({
            status: 'working',
            message: 'Updating WhatsApp profile picture…'
          });

          await sock.updateProfilePicture(sock.user.id, processedBuffer);

          sendEvent({
            status: 'success',
            message: 'Profile picture updated successfully!',
            deviceRemoved: true
          });

          // Wait 3 seconds then cleanly close and logout
          setTimeout(async () => {
            await cleanup();
            try {
              res.end();
            } catch (e) {}
          }, 3000);

        } catch (err) {
          console.error('[ProfilePicture] Update error:', err);
          sendEvent({
            status: 'error',
            message: err.message || 'Failed to update profile picture. Please try again.'
          });
          await cleanup();
          try {
            res.end();
          } catch (e) {}
        }
      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          sendEvent({
            status: 'error',
            message: 'Device was disconnected or logged out. Please try again.'
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

    sendEvent({
      status: 'waiting',
      message: 'Requesting pairing code from WhatsApp…'
    });

    const rawCode = await sock.requestPairingCode(cleanNumber);
    const cleanCode = rawCode ? String(rawCode).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : '';
    const formatted = cleanCode.length === 8 
      ? `${cleanCode.slice(0, 4)} - ${cleanCode.slice(4)}`
      : cleanCode;

    // Send code to client - but keep the stream OPEN while waiting for user to type code!
    sendEvent({
      status: 'code',
      code: cleanCode,
      formattedCode: formatted,
      message: 'Enter this code in WhatsApp'
    });

    // Safety timeout at 55 seconds (before Vercel 60s limit)
    setTimeout(async () => {
      sendEvent({
        status: 'error',
        message: 'Linking timed out (60s). Please make sure you tap "Link with phone instead" on your phone.'
      });
      await cleanup();
      try {
        res.end();
      } catch (e) {}
    }, 55000);

  } catch (err) {
    console.error('[ProfilePicture] Fatal error:', err);
    sendEvent({
      status: 'error',
      message: err.message || 'Failed to request pairing code. If connection fails, try using a VPN.'
    });
    await cleanup();
    try {
      res.end();
    } catch (e) {}
  }
}
