import React, { useState, useRef, useEffect } from 'react';
import Head from 'next/head';
import Link from 'next/link';

export default function ProfilePicturePage() {
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [imageError, setImageError] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [style, setStyle] = useState('blur'); // 'blur' or 'dark'

  // Phases: 'idle' | 'waiting' | 'code' | 'working' | 'success' | 'error'
  const [phase, setPhase] = useState('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [formattedCode, setFormattedCode] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [trackingId, setTrackingId] = useState(null);
  const [deviceRemoved, setDeviceRemoved] = useState(false);

  const fileInputRef = useRef(null);
  const pollIntervalRef = useRef(null);

  const cleanPhone = phone.replace(/\D/g, '').replace(/^00/, '');
  const isPhoneValid = cleanPhone.length >= 9 && cleanPhone.length <= 15;
  const canSubmit = imageFile && isPhoneValid && phase === 'idle';

  useEffect(() => {
    return () => {
      stopPolling();
      if (imagePreview) {
        URL.revokeObjectURL(imagePreview);
      }
    };
  }, [imagePreview]);

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setImageError('Please choose a JPG or PNG image.');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      setImageError(`This photo is ${mb} MB — the limit is 5 MB.`);
      return;
    }

    setImageError('');
    setImageFile(file);

    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
    }
    const previewUrl = URL.createObjectURL(file);
    setImagePreview(previewUrl);
  };

  const readFileAsBase64 = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const startPolling = (id) => {
    stopPolling();
    pollIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/profile-picture?trackingId=${encodeURIComponent(id)}`);
        if (!res.ok) return;

        const data = await res.json();
        if (data.status) {
          if (data.status === 'working') {
            setPhase('working');
            setStatusMessage(data.message || 'Updating profile picture…');
          } else if (data.status === 'success') {
            stopPolling();
            setPhase('success');
            setStatusMessage('Profile picture updated successfully!');
            setDeviceRemoved(Boolean(data.deviceRemoved));
          } else if (data.status === 'error') {
            stopPolling();
            setPhase('error');
            setStatusMessage(data.message || 'Failed to update profile picture.');
          }
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 2000);
  };

  const handleSubmit = async (e) => {
    e?.preventDefault();
    if (!canSubmit) {
      setPhoneTouched(true);
      return;
    }

    setPhase('waiting');
    setStatusMessage('Requesting your pairing code…');
    setPairingCode('');
    setFormattedCode('');
    setDeviceRemoved(false);

    try {
      const base64Image = await readFileAsBase64(imageFile);
      const res = await fetch('/api/profile-picture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: cleanPhone,
          image: base64Image,
          style
        })
      });

      const data = await res.json();
      if (data.ok && data.code) {
        setTrackingId(data.trackingId);
        setPairingCode(data.code);
        setFormattedCode(data.formattedCode || data.code);
        setPhase('code');
        startPolling(data.trackingId);
      } else {
        setPhase('error');
        setStatusMessage(data.error || 'Could not request a pairing code. Please try again.');
      }
    } catch (err) {
      setPhase('error');
      setStatusMessage(`Connection failed: ${err.message}. If this keeps happening, try using a VPN.`);
    }
  };

  const handleCancel = async () => {
    stopPolling();
    if (trackingId) {
      try {
        await fetch('/api/profile-picture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', trackingId })
        });
      } catch (e) {}
    }
    setPhase('idle');
    setPairingCode('');
    setStatusMessage('');
  };

  const handleStartOver = () => {
    handleCancel();
    setImageFile(null);
    if (imagePreview) {
      URL.revokeObjectURL(imagePreview);
      setImagePreview(null);
    }
    setPhone('');
    setPhoneTouched(false);
  };

  const copyCode = () => {
    const raw = pairingCode.replace(/[^A-Za-z0-9]/g, '');
    navigator.clipboard.writeText(raw);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  return (
    <div style={{ backgroundColor: '#09090b', minHeight: '100vh', color: '#f4f4f5', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <Head>
        <title>Full Profile Picture | 🤖 ADAM WhatsApp Bot</title>
        <meta name="description" content="Update your WhatsApp profile image instantly without cropping. Upload, pair, and you're done." />
        <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><text y='20' font-size='20'>🤖</text></svg>" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600;700&display=swap" />
        <script src="https://cdn.tailwindcss.com"></script>
      </Head>

      {/* Navigation Header */}
      <header className="border-b border-zinc-800 bg-zinc-950/80 sticky top-0 backdrop-blur-md z-40">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-3 group">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-red-600 to-red-500 flex items-center justify-center font-extrabold text-white text-xl shadow-lg shadow-red-500/20 group-hover:scale-105 transition">
                🤖
              </div>
              <div>
                <span className="font-bold text-lg tracking-tight text-white flex items-center gap-2">
                  ADAM <span className="text-xs px-2 py-0.5 rounded-full bg-red-950/60 text-red-400 border border-red-800/80 font-mono">v2.0</span>
                </span>
              </div>
            </Link>
          </div>

          <nav className="flex items-center gap-1 text-sm text-zinc-400">
            <Link href="/" className="px-3.5 py-1.5 rounded-lg font-medium transition hover:text-white">
              🔑 Session
            </Link>
            <Link href="/profile-picture" className="px-3.5 py-1.5 rounded-lg font-medium transition bg-zinc-800 text-white border border-zinc-700/60">
              🖼️ Profile Picture
            </Link>
            <Link href="/#deploy" className="px-3.5 py-1.5 rounded-lg font-medium transition hover:text-white">
              🚀 Deploy
            </Link>
            <Link href="/#plugins" className="px-3.5 py-1.5 rounded-lg font-medium transition hover:text-white">
              🧩 Plugins
            </Link>
            <Link href="/#config" className="px-3.5 py-1.5 rounded-lg font-medium transition hover:text-white">
              ⚙️ Config
            </Link>
          </nav>

          <a 
            href="https://github.com/ADAM0S999/lm7bos" 
            target="_blank" 
            rel="noreferrer"
            className="hidden sm:flex items-center gap-2 text-xs font-mono px-3.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 transition"
          >
            GitHub
          </a>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-5xl mx-auto px-4 py-12">
        
        {/* Title Header (Matching Levanter) */}
        <div className="mb-10">
          <h1 className="text-3xl md:text-5xl font-extrabold text-white tracking-tight font-mono mb-3">
            Profile Picture.
          </h1>
          <p className="text-sm md:text-base text-zinc-400 max-w-xl">
            Update your WhatsApp profile image instantly without cropping. Upload full photo, pair, and you&apos;re done.
          </p>
        </div>

        {/* Content Columns */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* Left Column (Forms & Actions) */}
          <div className="lg:col-span-7 space-y-6">
            
            {/* Step 1 Card: Upload Image */}
            <div className="bg-[#121217] border border-zinc-800/90 rounded-2xl p-6 md:p-8 shadow-xl">
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs font-mono transition ${imageFile ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-red-500/20 text-red-400 border border-red-500/40'}`}>
                    1
                  </div>
                  <h2 className="text-base md:text-lg font-bold text-white font-mono">Upload Image</h2>
                </div>
                {imageFile && (
                  <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs font-bold">
                    ✓
                  </span>
                )}
              </div>

              <input 
                ref={fileInputRef}
                type="file" 
                accept="image/jpeg,image/png,image/webp" 
                className="hidden" 
                onChange={handleImageSelect}
              />

              {!imagePreview ? (
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-zinc-700/80 hover:border-red-500/80 bg-[#0c0c10] rounded-2xl p-8 md:p-12 text-center cursor-pointer transition group"
                >
                  <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-zinc-900 flex items-center justify-center text-zinc-400 group-hover:text-red-400 transition">
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                      <circle cx="8.5" cy="8.5" r="1.5"></circle>
                      <polyline points="21 15 16 10 5 21"></polyline>
                    </svg>
                  </div>
                  <p className="font-semibold text-white text-sm mb-1">Choose an image</p>
                  <p className="text-xs text-zinc-500 font-mono">JPG or PNG &bull; up to 5 MB</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="relative rounded-2xl overflow-hidden border border-zinc-800 bg-[#0a0a0d] p-3 flex justify-center">
                    <img 
                      src={imagePreview} 
                      alt="Selected profile picture" 
                      className="max-h-64 md:max-h-80 w-auto rounded-xl object-contain shadow-2xl"
                    />
                  </div>

                  {/* Image Style Selector */}
                  <div className="flex flex-col sm:flex-row gap-2 items-center justify-between pt-1">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setStyle('blur')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-mono transition cursor-pointer ${style === 'blur' ? 'bg-red-600/30 border border-red-500 text-red-300' : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'}`}
                      >
                        ✨ Blurred Backdrop (Full Fit)
                      </button>
                      <button
                        type="button"
                        onClick={() => setStyle('dark')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-mono transition cursor-pointer ${style === 'dark' ? 'bg-red-600/30 border border-red-500 text-red-300' : 'bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white'}`}
                      >
                        ⬛ Dark Padded
                      </button>
                    </div>

                    <button 
                      type="button"
                      disabled={phase !== 'idle'}
                      onClick={() => fileInputRef.current?.click()}
                      className="text-xs font-mono text-zinc-400 hover:text-white transition flex items-center gap-1.5"
                    >
                      <span>🔄</span>
                      <span>Change photo</span>
                    </button>
                  </div>
                </div>
              )}

              {imageError && (
                <p className="text-xs font-mono text-red-400 mt-3">{imageError}</p>
              )}
            </div>

            {/* Step 2 Card: Phone Number */}
            <div className={`bg-[#121217] border border-zinc-800/90 rounded-2xl p-6 md:p-8 shadow-xl transition ${imageFile ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs font-mono transition ${isPhoneValid ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-red-500/20 text-red-400 border border-red-500/40'}`}>
                    2
                  </div>
                  <h2 className="text-base md:text-lg font-bold text-white font-mono">Phone Number</h2>
                </div>
                {isPhoneValid && (
                  <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-xs font-bold">
                    ✓
                  </span>
                )}
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-mono text-zinc-400">
                  Use international format with country code
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                    </svg>
                  </div>
                  <input 
                    type="tel"
                    disabled={phase !== 'idle'}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    onBlur={() => setPhoneTouched(true)}
                    placeholder="e.g. +1234567890"
                    className="w-full bg-[#0c0c10] border border-zinc-800 rounded-xl pl-10 pr-10 py-3 text-sm text-white font-mono placeholder-zinc-600 focus:outline-none focus:border-red-500 transition"
                  />
                  {isPhoneValid && (
                    <div className="absolute inset-y-0 right-0 pr-3.5 flex items-center pointer-events-none text-emerald-400 font-bold">
                      ✓
                    </div>
                  )}
                </div>
                {phoneTouched && cleanPhone && !isPhoneValid && (
                  <p className="text-xs font-mono text-red-400">
                    Enter a valid number, including the country code (e.g. +212612345678)
                  </p>
                )}
              </div>
            </div>

            {/* Action / Progress Box */}
            {phase === 'idle' ? (
              <button 
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className={`w-full py-4 px-6 rounded-2xl font-mono text-sm font-semibold transition flex items-center justify-center gap-3 cursor-pointer shadow-xl ${canSubmit ? 'bg-red-600 hover:bg-red-500 text-white shadow-red-900/30' : 'bg-zinc-800/60 text-zinc-500 cursor-not-allowed border border-zinc-800'}`}
              >
                <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.582 2.128 2.182-.573c.978.58 1.911.928 3.145.929 3.178 0 5.767-2.587 5.768-5.766.001-3.187-2.575-5.771-5.764-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.006c.106.005.249-.04.39.298.144.347.491 1.2.534 1.287.043.087.072.188.014.304-.058.116-.087.188-.173.289l-.26.304c-.087.086-.177.18-.076.354.101.174.449.741.964 1.201.662.591 1.221.774 1.394.86.174.086.275.072.376-.044.101-.116.433-.506.549-.68.116-.173.231-.145.39-.086s1.011.477 1.184.564.289.13.332.202c.045.072.045.419-.099.824z"/>
                </svg>
                <span>Update Profile Picture</span>
              </button>
            ) : (
              /* PROGRESS / PAIRING / SUCCESS / ERROR CARD */
              <div className="bg-[#12161f] border border-[#1e293b] rounded-2xl p-6 md:p-8 space-y-5 animate-fade-in shadow-2xl">
                
                {/* Header Row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {phase === 'waiting' || phase === 'working' ? (
                      <span className="w-5 h-5 border-2 border-[#38bdf8] border-t-transparent rounded-full animate-spin"></span>
                    ) : phase === 'success' ? (
                      <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-sm">
                        ✓
                      </span>
                    ) : phase === 'error' ? (
                      <span className="w-6 h-6 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center font-bold text-sm">
                        !
                      </span>
                    ) : (
                      <span className="text-[#38bdf8] text-lg">🔑</span>
                    )}
                    <h3 className="text-sm md:text-base font-bold text-white font-mono">
                      {phase === 'waiting' && 'Requesting your pairing code…'}
                      {phase === 'code' && 'Enter this code in WhatsApp'}
                      {phase === 'working' && (statusMessage || 'Updating profile picture…')}
                      {phase === 'success' && 'Profile picture updated!'}
                      {phase === 'error' && 'Update Failed'}
                    </h3>
                  </div>

                  {phase === 'success' && (
                    <span className="px-2.5 py-1 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-mono">
                      Done
                    </span>
                  )}
                </div>

                {/* PHASE: CODE (Matching Levanter) */}
                {phase === 'code' && (
                  <div className="space-y-4">
                    <div className="bg-[#0c0c10] border border-zinc-800 rounded-xl py-6 px-4 text-center">
                      <span className="text-3xl md:text-4xl font-extrabold font-mono text-[#38bdf8] tracking-[0.25em] inline-block select-all drop-shadow-[0_0_12px_rgba(56,189,248,0.4)]">
                        {formattedCode}
                      </span>
                    </div>

                    <button 
                      type="button"
                      onClick={copyCode}
                      className="w-full py-3 rounded-xl bg-[#20202a] hover:bg-[#272734] border border-zinc-700/80 text-white font-mono text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer"
                    >
                      {copiedCode ? (
                        <>
                          <span className="text-emerald-400 font-bold">✓</span>
                          <span>Copied code</span>
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="7" y="3" width="14" height="15" rx="2"></rect>
                            <path d="M3 7v12a2 2 0 0 0 2 2h12"></path>
                          </svg>
                          <span>Copy code</span>
                        </>
                      )}
                    </button>

                    {/* Linking steps */}
                    <div className="space-y-2.5 text-xs font-mono text-zinc-300 pt-2 border-t border-zinc-800/80">
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 rounded-md bg-[#1c1c24] border border-zinc-700/80 flex items-center justify-center font-bold text-[11px] text-[#38bdf8] shrink-0">1</div>
                        <span>Go to Linked Devices in Settings</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 rounded-md bg-[#1c1c24] border border-zinc-700/80 flex items-center justify-center font-bold text-[11px] text-[#38bdf8] shrink-0">2</div>
                        <span>Tap &quot;Link with phone instead&quot;</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 rounded-md bg-[#1c1c24] border border-zinc-700/80 flex items-center justify-center font-bold text-[11px] text-[#38bdf8] shrink-0">3</div>
                        <span>Enter the 8-character code</span>
                      </div>
                    </div>

                    <p className="text-[11px] font-mono text-zinc-500 text-center">
                      Keep this tab open and come back here after linking.
                    </p>

                    <button 
                      type="button"
                      onClick={handleCancel}
                      className="w-full py-2.5 rounded-xl hover:bg-zinc-800/60 text-zinc-400 hover:text-white font-mono text-xs transition"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* PHASE: WORKING */}
                {phase === 'working' && (
                  <div className="py-4 text-center space-y-2">
                    <p className="text-xs font-mono text-zinc-400">{statusMessage}</p>
                    <p className="text-[11px] font-mono text-zinc-500">Applying full resolution without cropping…</p>
                  </div>
                )}

                {/* PHASE: SUCCESS */}
                {phase === 'success' && (
                  <div className="space-y-4 pt-1">
                    <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-900/40 text-xs font-mono text-emerald-300 space-y-1">
                      <p className="font-bold">✓ Profile picture was successfully updated on WhatsApp!</p>
                      {deviceRemoved && (
                        <p className="text-zinc-400 text-[11px]">The temporary linked device was removed automatically.</p>
                      )}
                    </div>

                    <button 
                      type="button"
                      onClick={handleStartOver}
                      className="w-full py-3 rounded-xl bg-[#20202a] hover:bg-[#272734] border border-zinc-700/80 text-white font-mono text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer"
                    >
                      <span>🔄</span>
                      <span>Start over</span>
                    </button>
                  </div>
                )}

                {/* PHASE: ERROR */}
                {phase === 'error' && (
                  <div className="space-y-4 pt-1">
                    <div className="p-4 rounded-xl bg-red-950/20 border border-red-900/40 text-xs font-mono text-red-300">
                      {statusMessage}
                    </div>

                    <div className="flex items-center gap-3">
                      <button 
                        type="button"
                        onClick={handleSubmit}
                        className="flex-1 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white font-mono text-xs font-semibold transition"
                      >
                        Try again
                      </button>
                      <button 
                        type="button"
                        onClick={handleStartOver}
                        className="flex-1 py-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 font-mono text-xs transition"
                      >
                        Start over
                      </button>
                    </div>
                  </div>
                )}

              </div>
            )}

          </div>

          {/* Right Column (How it works - Matching Levanter) */}
          <div className="lg:col-span-5">
            <div className="bg-[#121217] border border-zinc-800/90 rounded-2xl p-6 md:p-8 shadow-xl space-y-6">
              <h3 className="text-xs font-mono font-bold uppercase tracking-[0.2em] text-zinc-400">
                How it works
              </h3>

              <div className="space-y-4">
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-300 shrink-0 text-sm">
                    🖼️
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">Select a high-quality image.</p>
                    <p className="text-xs text-zinc-400 mt-0.5">Vertical or horizontal photos will be scaled to full display without cutting.</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-300 shrink-0 text-sm">
                    📞
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">Enter your number to receive a pairing code.</p>
                    <p className="text-xs text-zinc-400 mt-0.5">Use your full international number with country code.</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-300 shrink-0 text-sm">
                    🔗
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">Link the device in your WhatsApp settings.</p>
                    <p className="text-xs text-zinc-400 mt-0.5">Open WhatsApp &gt; Linked Devices &gt; Link with phone number instead.</p>
                  </div>
                </div>

                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-300 shrink-0 text-sm">
                    ✅
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">Wait for the success message.</p>
                    <p className="text-xs text-zinc-400 mt-0.5">Your full profile picture updates instantly and the temporary link disconnects automatically.</p>
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-zinc-800/80">
                <div className="flex items-center gap-2 text-xs font-mono text-zinc-500">
                  <span>🔒</span>
                  <span>100% Secure &bull; Temporary Link only &bull; Auto-Logout</span>
                </div>
              </div>
            </div>
          </div>

        </div>

      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800/80 mt-16 py-6 text-center text-xs text-zinc-500 font-mono">
        <p>🤖 ADAM WhatsApp Bot Platform &bull; Compatible with Vercel, Render, Koyeb, and VPS</p>
      </footer>
    </div>
  );
}
