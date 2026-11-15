export const maxDuration = 60; // Allow up to 60 seconds on Vercel

global._ppSessions = global._ppSessions || new Map();

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
  // ── GET: Check Profile Picture Pairing / Update Status ──
  if (req.method === 'GET') {
    const { trackingId } = req.query;
    if (!trackingId) {
      return res.status(400).json({ error: 'trackingId is required' });
    }

    const session = global._ppSessions.get(trackingId);
    if (!session) {
      return res.status(200).json({
        status: 'error',
        message: 'Session expired or not found. Please try again.'
      });
    }

    return res.status(200).json({
      status: session.status || 'waiting',
      message: session.message || '',
      code: session.code || null,
      formattedCode: session.formattedCode || null,
      deviceRemoved: session.deviceRemoved || false
    });
  }

  // ── DELETE / CANCEL: Cancel active profile picture request ──
  if (req.method === 'DELETE' || (req.method === 'POST' && req.body?.action === 'cancel')) {
    const trackingId = req.query?.trackingId || req.body?.trackingId;
    if (trackingId && global._ppSessions.has(trackingId)) {
      const session = global._ppSessions.get(trackingId);
      try {
        if (session.sock) {
          session.sock.end(new Error('User cancelled'));
        }
      } catch (e) {}
      try {
        const fs = await import('fs');
        if (session.tempDir && fs.existsSync(session.tempDir)) {
          fs.rmSync(session.tempDir, { recursive: true, force: true });
        }
      } catch (e) {}
      global._ppSessions.delete(trackingId);
    }
    return res.status(200).json({ ok: true, cancelled: true });
  }

  // ── POST: Start Profile Picture Update ──
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

  const trackingId = `pp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  try {
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, Browsers, delay, DisconnectReason } = baileys;
    const pino = (await import('pino')).default;
    const os = await import('os');
    const path = await import('path');

    const tempDir = path.join(os.tmpdir(), `adam_pp_${cleanNumber}_${Date.now()}`);
    const { state, saveCreds } = await useMultiFileAuthState(tempDir);

    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    const sessionRecord = {
      sock,
      status: 'waiting',
      message: 'Requesting your pairing code…',
      code: null,
      formattedCode: null,
      number: cleanNumber,
      trackingId,
      tempDir,
      imageBuffer,
      style,
      deviceRemoved: false,
      createdAt: Date.now()
    };
    global._ppSessions.set(trackingId, sessionRecord);

    // Handle connection update and automatic profile picture replacement
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      const current = global._ppSessions.get(trackingId);
      if (!current) return;

      if (connection === 'open') {
        current.status = 'working';
        current.message = 'Linked successfully. Processing full image…';

        try {
          // Process image using sharp
          let processedBuffer;
          try {
            const sharpModule = await import('sharp');
            const sharp = sharpModule.default || sharpModule;
            processedBuffer = await processFullImage(current.imageBuffer, current.style, sharp);
          } catch (sharpError) {
            console.warn('[ProfilePicture] sharp fallback to original buffer:', sharpError.message);
            processedBuffer = current.imageBuffer;
          }

          current.message = 'Updating WhatsApp profile picture…';

          // Update profile picture for the logged-in user
          await sock.updateProfilePicture(sock.user.id, processedBuffer);

          current.status = 'success';
          current.message = 'Profile picture updated successfully!';
          current.deviceRemoved = true;

          // Automatically clean up temporary linked device after 3 seconds
          setTimeout(async () => {
            try {
              await sock.logout();
            } catch (e) {}
            try {
              const fs = await import('fs');
              if (fs.existsSync(current.tempDir)) {
                fs.rmSync(current.tempDir, { recursive: true, force: true });
              }
            } catch (e) {}
            global._ppSessions.delete(trackingId);
          }, 4000);

        } catch (err) {
          console.error('[ProfilePicture] Error updating profile picture:', err);
          current.status = 'error';
          current.message = err.message || 'Failed to update profile picture. Please try again.';
        }
      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut && current.status !== 'success') {
          current.status = 'error';
          current.message = 'Connection was closed or logged out. Please try again.';
        }
      }
    });

    // Wait 3 seconds for handshake
    await delay(3000);

    const rawCode = await sock.requestPairingCode(cleanNumber);
    const cleanCode = rawCode ? String(rawCode).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : '';
    const formatted = cleanCode.length === 8 
      ? `${cleanCode.slice(0, 4)} - ${cleanCode.slice(4)}`
      : cleanCode;

    sessionRecord.status = 'code';
    sessionRecord.code = cleanCode;
    sessionRecord.formattedCode = formatted;
    sessionRecord.message = 'Enter this code in WhatsApp';

    return res.status(200).json({
      ok: true,
      trackingId,
      code: cleanCode,
      formattedCode: formatted,
      message: 'Enter this code in WhatsApp'
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || 'Failed to request pairing code. If this keeps happening, try using a VPN.'
    });
  }
}
