'use strict';

/**
 * ADAM Bot — plugins/profile.js
 * Full profile picture without cropping (Levanter style).
 */

const { bot } = require('../lib/');
const config  = require('../config');

async function downloadMedia(sock, msg) {
  const { downloadMediaMessage } = require('@whiskeysockets/baileys');
  return downloadMediaMessage(msg, 'buffer', {}, { logger: console, reuploadRequest: sock.updateMediaMessage });
}

async function processFullImage(buffer, style = 'blur') {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    return buffer;
  }

  const metadata = await sharp(buffer).metadata();
  const width = metadata.width || 720;
  const height = metadata.height || 720;

  if (width === height) {
    return await sharp(buffer)
      .resize(720, 720, { fit: 'cover' })
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  const maxDimension = Math.max(width, height);
  const targetSize = Math.min(Math.max(maxDimension, 720), 1080);

  if (style === 'blur') {
    const background = await sharp(buffer)
      .resize(targetSize, targetSize, { fit: 'cover' })
      .blur(25)
      .modulate({ brightness: 0.65 })
      .toBuffer();

    const foreground = await sharp(buffer)
      .resize(targetSize, targetSize, { fit: 'inside' })
      .toBuffer();

    return await sharp(background)
      .composite([{ input: foreground, gravity: 'center' }])
      .jpeg({ quality: 95 })
      .toBuffer();
  } else {
    return await sharp(buffer)
      .resize(targetSize, targetSize, {
        fit: 'contain',
        background: { r: 18, g: 18, b: 23, alpha: 1 }
      })
      .jpeg({ quality: 95 })
      .toBuffer();
  }
}

bot(
  {
    pattern  : 'fullpp|pp',
    desc     : 'Set full profile picture without cropping (Levanter style)',
    category : 'tools',
    usage    : '.fullpp (reply to any image)',
    isMedia  : true,
  },
  async (sock, msg, { jid, raw, reply, isSudo }) => {
    if (!isSudo) {
      return reply('❌ Only the bot owner can change the profile picture.');
    }

    const quoted = raw.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const target = quoted
      ? { message: quoted, key: { remoteJid: jid, id: raw.message.extendedTextMessage.contextInfo.stanzaId, participant: raw.message.extendedTextMessage.contextInfo.participant } }
      : raw;

    const msgType = Object.keys(target.message || {})[0];
    if (msgType !== 'imageMessage') {
      return reply('🖼️ Please reply to an image with *.fullpp* to set full profile picture.');
    }

    await reply('⏳ Processing full image without cropping…');

    try {
      const buffer = await downloadMedia(sock, target);
      if (!buffer) {
        return reply('❌ Failed to download the image.');
      }

      const processed = await processFullImage(buffer, 'blur');
      await sock.updateProfilePicture(sock.user.id, processed);

      return reply('✅ Full profile picture updated successfully! No cropping applied.');
    } catch (err) {
      console.error('[profile plugin error]', err);
      return reply(`❌ Error updating profile picture: ${err.message}`);
    }
  }
);
