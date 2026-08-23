import React, { useState, useEffect, useRef } from 'react';
import {
  Globe,
  RefreshCw,
  X,
  ShieldCheck,
  ExternalLink,
  Loader2,
  Play,
  MousePointer,
  ArrowRight,
  Monitor,
  User,
  ChevronLeft,
  ChevronRight,
  Cookie,
  Check,
  AlertCircle,
  FileText,
  Sparkles,
  Clipboard
} from 'lucide-react';
import {
  performBrowserAction,
  getBrowserActiveSession,
  getBrowserProfiles,
  getBrowserCookieSources,
  importLocalBrowserCookies,
  importJsonCookies
} from '../services/chatApi';

export function LiveCamoufoxPanel({ onClose, isEmbedded = true }) {
  const [hasFrame, setHasFrame] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');
  const [currentTitle, setCurrentTitle] = useState('');
  const [isNavigating, setIsNavigating] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [interactionMode, setInteractionMode] = useState('interactive');
  const [isNativeMode, setIsNativeMode] = useState(false);
  const [profiles, setProfiles] = useState([{ id: 'default', name: 'Default Profile' }]);
  const [selectedProfile, setSelectedProfile] = useState('default');
  const [clickRipples, setClickRipples] = useState([]);

  // Cookie & Session Import State
  const [isCookieModalOpen, setIsCookieModalOpen] = useState(false);
  const [cookieTab, setCookieTab] = useState('local'); // 'local' | 'json'
  const [cookieBrowser, setCookieBrowser] = useState('chrome');
  const [cookieDomain, setCookieDomain] = useState('');
  const [cookieJsonInput, setCookieJsonInput] = useState('');
  const [isImportingCookies, setIsImportingCookies] = useState(false);
  const [cookieFeedback, setCookieFeedback] = useState(null);
  const [cookieSources, setCookieSources] = useState([
    { id: 'chrome', name: 'Google Chrome' },
    { id: 'edge', name: 'Microsoft Edge' },
    { id: 'brave', name: 'Brave Browser' },
    { id: 'firefox', name: 'Mozilla Firefox' },
  ]);
  
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const containerRef = useRef(null);
  const resizeTimerRef = useRef(null);
  const scrollAccRef = useRef({ deltaX: 0, deltaY: 0, scheduled: false });
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;

  // Fetch registered browser profiles, sources, and check active session status
  useEffect(() => {
    getBrowserProfiles()
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setProfiles(data);
        }
      })
      .catch((err) => console.error('Failed to load profiles:', err));

    getBrowserCookieSources()
      .then((data) => {
        if (data?.sources && Array.isArray(data.sources)) {
          setCookieSources(data.sources);
        }
      })
      .catch((err) => console.error('Failed to load cookie sources:', err));

    getBrowserActiveSession()
      .then((data) => {
        if (data?.active) {
          setIsActive(true);
          if (data.url) {
            setCurrentUrl(data.url);
            setUrlInput(data.url);
          }
          if (data.title) setCurrentTitle(data.title);
          if (data.profile) setSelectedProfile(data.profile);
        }
      })
      .catch((err) => console.error('Failed to check active session status:', err));
  }, []);

  // Adaptive ResizeObserver to sync Playwright viewport size with physical screen pixels (HiDPI)
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 200 && height > 200) {
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const targetW = Math.round(width * dpr);
          const targetH = Math.round(height * dpr);
          
          if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = setTimeout(() => {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                action: 'resize_viewport',
                width: targetW,
                height: targetH
              }));
            }
          }, 150);
        }
      }
    });

    observer.observe(containerRef.current);
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let ws;
    let isMounted = true;
    let reconnectTimer;

    const connectWebSocket = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host.includes('14200')
        ? '127.0.0.1:14300'
        : (window.location.host || '127.0.0.1:14300');
      const wsUrl = `${protocol}//${host}/api/browser/stream`;

      try {
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'blob';
        wsRef.current = ws;

        ws.onopen = () => {
          if (isMounted) setIsConnecting(false);
          // Send initial adaptive container dimensions if ready (HiDPI scaled)
          if (containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            if (rect.width > 200 && rect.height > 200) {
              const dpr = Math.min(window.devicePixelRatio || 1, 2);
              ws.send(JSON.stringify({
                action: 'resize_viewport',
                width: Math.round(rect.width * dpr),
                height: Math.round(rect.height * dpr)
              }));
            }
          }
        };

        ws.onmessage = (event) => {
          // 1. High-Performance Hardware-Accelerated Binary Blob Stream
          if (event.data instanceof Blob) {
            createImageBitmap(event.data)
              .then((bitmap) => {
                if (!isMounted) {
                  bitmap.close();
                  return;
                }
                const canvas = canvasRef.current;
                if (canvas) {
                  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                  }
                  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');
                  if (ctx) {
                    ctx.drawImage(bitmap, 0, 0);
                  }
                }
                bitmap.close();
                setHasFrame(true);
                setIsActive(true);
                setIsNavigating(false);
                setStatusMessage('');
              })
              .catch((err) => {
                console.error('Error rendering hardware bitmap frame:', err);
              });
            return;
          }

          // 2. Metadata / JSON messages
          if (typeof event.data === 'string') {
            try {
              const data = JSON.parse(event.data);
              if (data.type === 'metadata') {
                if (data.active !== undefined) setIsActive(data.active);
                if (data.url && data.url !== currentUrlRef.current) {
                  setCurrentUrl(data.url);
                  setUrlInput(data.url);
                }
                if (data.title) setCurrentTitle(data.title);
              } else if (data.type === 'status') {
                setIsActive(data.active);
                if (!data.active) {
                  setHasFrame(false);
                }
              }
            } catch (err) {
              console.error('Error parsing browser stream message:', err);
            }
          }
        };

        ws.onerror = (err) => {
          console.error('Browser WebSocket error:', err);
          if (isMounted) setIsConnecting(false);
        };

        ws.onclose = () => {
          if (isMounted) {
            setIsConnecting(false);
            reconnectTimer = setTimeout(() => {
              if (isMounted) connectWebSocket();
            }, 2000);
          }
        };
      } catch (err) {
        console.error('Failed to instantiate WebSocket stream:', err);
      }
    };

    connectWebSocket();

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const handleNavigate = async (e) => {
    if (e) e.preventDefault();
    if (!urlInput) return;
    
    let targetUrl = urlInput.trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    setIsNavigating(true);
    setStatusMessage('Navigating to target URL...');
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: 'navigate', url: targetUrl }));
      } else {
        await performBrowserAction('navigate', { url: targetUrl });
      }
    } catch (err) {
      console.error('Failed to navigate:', err);
      setStatusMessage('Navigation failed. Please try again.');
    } finally {
      setTimeout(() => setIsNavigating(false), 2000);
    }
  };

  const handleGoBack = async () => {
    setIsNavigating(true);
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: 'back' }));
      } else {
        await performBrowserAction('back', {});
      }
    } catch (err) {
      console.error('Failed to navigate back:', err);
    } finally {
      setTimeout(() => setIsNavigating(false), 600);
    }
  };

  const handleGoForward = async () => {
    setIsNavigating(true);
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: 'forward' }));
      } else {
        await performBrowserAction('forward', {});
      }
    } catch (err) {
      console.error('Failed to navigate forward:', err);
    } finally {
      setTimeout(() => setIsNavigating(false), 600);
    }
  };

  const handleImportLocalCookies = async () => {
    setIsImportingCookies(true);
    setCookieFeedback(null);
    try {
      const res = await importLocalBrowserCookies(cookieBrowser, cookieDomain || null, selectedProfile);
      if (res.success) {
        setCookieFeedback({ type: 'success', text: res.message || `Imported ${res.count} cookies!` });
        setTimeout(() => {
          handleNavigate();
        }, 800);
      } else {
        setCookieFeedback({ type: 'error', text: res.message || 'Extraction failed. Use the Paste JSON tab to import cookies directly.' });
      }
    } catch (err) {
      setCookieFeedback({ type: 'error', text: err.message || 'Failed to extract cookies from selected browser.' });
    } finally {
      setIsImportingCookies(false);
    }
  };

  const handleImportJsonCookies = async () => {
    if (!cookieJsonInput.trim()) return;
    setIsImportingCookies(true);
    setCookieFeedback(null);
    try {
      const res = await importJsonCookies(cookieJsonInput.trim(), selectedProfile);
      if (res.success) {
        setCookieFeedback({ type: 'success', text: res.message || `Injected ${res.count} cookies!` });
        setCookieJsonInput('');
        setTimeout(() => {
          handleNavigate();
        }, 800);
      } else {
        setCookieFeedback({ type: 'error', text: res.message || 'Failed to inject cookies.' });
      }
    } catch (err) {
      setCookieFeedback({ type: 'error', text: err.message || 'Invalid JSON format. Please check your cookie JSON.' });
    } finally {
      setIsImportingCookies(false);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setCookieJsonInput(text);
        setCookieFeedback(null);
      }
    } catch (err) {
      console.error('Clipboard access denied:', err);
    }
  };

  const handleOpenSession = async (headless = true, overrideProfile = null) => {
    const profToUse = overrideProfile || selectedProfile;
    setIsNavigating(true);
    setIsNativeMode(!headless);
    setStatusMessage(headless ? `Launching Camoufox (${profToUse})...` : `Opening 60 FPS window (${profToUse})...`);
    try {
      const targetUrl = urlInput || 'https://google.com';
      await performBrowserAction('open', { url: targetUrl, profile: profToUse, headless });
      setIsActive(true);
    } catch (err) {
      console.error('Failed to open browser session:', err);
      setStatusMessage('Failed to launch Camoufox engine.');
    } finally {
      setIsNavigating(false);
    }
  };

  const handleToggleMode = async (headless, overrideProfile = null) => {
    const profToUse = overrideProfile || selectedProfile;
    setIsNavigating(true);
    setIsNativeMode(!headless);
    setStatusMessage(headless ? 'Docking into in-app workspace...' : 'Opening 60 FPS native Firefox desktop window...');
    try {
      const targetUrl = urlInput || currentUrl || 'https://google.com';
      await performBrowserAction('open', { url: targetUrl, profile: profToUse, headless });
      setIsActive(true);
    } catch (err) {
      console.error('Failed to switch browser mode:', err);
      setStatusMessage('Failed to switch browser mode.');
    } finally {
      setIsNavigating(false);
    }
  };

  const handleCanvasClick = (e) => {
    if (interactionMode !== 'interactive' || !canvasRef.current) return;
    
    const rect = canvasRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    // Instant optimistic visual ripple (0ms feedback)
    const rippleId = Date.now() + Math.random();
    setClickRipples((prev) => [...prev, { id: rippleId, x: clientX, y: clientY }]);
    setTimeout(() => {
      setClickRipples((prev) => prev.filter((r) => r.id !== rippleId));
    }, 450);

    const scaleX = canvasRef.current.width / rect.width;
    const scaleY = canvasRef.current.height / rect.height;

    const actualX = Math.round(clientX * scaleX);
    const actualY = Math.round(clientY * scaleY);

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        action: 'click',
        x: actualX,
        y: actualY
      }));
    } else {
      performBrowserAction('click', { x: actualX, y: actualY });
    }
  };

  // Debounced/Accumulated Wheel Scrolling to eliminate stutter
  const handleWheel = (e) => {
    if (interactionMode !== 'interactive') return;
    
    scrollAccRef.current.deltaX += e.deltaX;
    scrollAccRef.current.deltaY += e.deltaY;

    if (!scrollAccRef.current.scheduled) {
      scrollAccRef.current.scheduled = true;
      requestAnimationFrame(() => {
        const dx = Math.round(scrollAccRef.current.deltaX);
        const dy = Math.round(scrollAccRef.current.deltaY);
        scrollAccRef.current.deltaX = 0;
        scrollAccRef.current.deltaY = 0;
        scrollAccRef.current.scheduled = false;

        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && (dx !== 0 || dy !== 0)) {
          wsRef.current.send(JSON.stringify({
            action: 'scroll',
            deltaX: dx,
            deltaY: dy
          }));
        }
      });
    }
  };

  const handleKeyDown = (e) => {
    if (interactionMode !== 'interactive') return;
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'SELECT') return;

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        action: 'type',
        text: e.key
      }));
    }
  };

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      className={`flex flex-col h-full w-full bg-neutral-950 border-l border-neutral-800/80 select-none overflow-hidden outline-none transition-all ${
        isFocused && interactionMode === 'interactive' ? 'ring-1 ring-emerald-500/20' : ''
      }`}
    >
      {/* Sleek Minimal Dark Header Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-neutral-900/90 border-b border-neutral-800/80">
        <div className="flex items-center gap-1.5 text-xs text-neutral-300 font-medium bg-neutral-800/80 px-2 py-1 rounded-lg border border-neutral-700/60 shrink-0">
          <ShieldCheck size={13} className="text-neutral-400 shrink-0" />
          <span className="hidden md:inline text-neutral-300">Camoufox</span>
          <span className="text-neutral-600 font-normal">|</span>
          <User size={12} className="text-emerald-400 shrink-0" />
          <select
            value={selectedProfile}
            onChange={(e) => {
              const newProf = e.target.value;
              setSelectedProfile(newProf);
              if (isActive) {
                handleOpenSession(!isNativeMode, newProf);
              }
            }}
            className="bg-transparent text-neutral-200 text-xs font-mono outline-none cursor-pointer border-none py-0 pl-0 pr-1"
            title="Active Persistent Browser Profile"
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id} className="bg-neutral-900 text-neutral-200">
                {p.name || p.id}
              </option>
            ))}
          </select>
        </div>

        {/* History Navigation Buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={handleGoBack}
            disabled={!isActive || isNavigating}
            title="Go Back (History)"
            className="p-1.5 rounded-lg bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 text-neutral-400 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-neutral-950 transition-colors cursor-pointer"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            type="button"
            onClick={handleGoForward}
            disabled={!isActive || isNavigating}
            title="Go Forward (History)"
            className="p-1.5 rounded-lg bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 text-neutral-400 hover:text-neutral-200 disabled:opacity-30 disabled:hover:bg-neutral-950 transition-colors cursor-pointer"
          >
            <ChevronRight size={13} />
          </button>
        </div>

        {/* Address Bar */}
        <form onSubmit={handleNavigate} className="flex-1 flex items-center gap-2 bg-neutral-950 border border-neutral-800 rounded-xl px-2.5 py-1 text-xs text-neutral-200 focus-within:border-neutral-700 transition-colors">
          <Globe size={13} className="text-neutral-500 shrink-0" />
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter URL (e.g. https://google.com)..."
            className="w-full bg-transparent outline-none text-xs text-neutral-200 placeholder-neutral-600"
          />
          <button type="submit" disabled={isNavigating} className="p-1 hover:bg-neutral-800 rounded-md text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer">
            {isNavigating ? <Loader2 size={12} className="animate-spin text-neutral-400" /> : <ArrowRight size={12} />}
          </button>
        </form>

        {/* Sleek Dark Mode Switch Pills */}
        <div className="flex items-center bg-neutral-950 p-0.5 rounded-xl border border-neutral-800/90 text-[11px] font-medium shrink-0">
          <button
            type="button"
            onClick={() => handleToggleMode(true)}
            disabled={isNavigating}
            title="Embedded In-App Panel"
            className={`px-2.5 py-1 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              !isNativeMode
                ? 'bg-neutral-800 text-neutral-100 font-medium border border-neutral-700/80 shadow-sm'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <Monitor size={11} />
            <span className="hidden sm:inline">In-App</span>
          </button>
          <button
            type="button"
            onClick={() => handleToggleMode(false)}
            disabled={isNavigating}
            title="Pop Out into 60 FPS Native Desktop Window"
            className={`px-2.5 py-1 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              isNativeMode
                ? 'bg-neutral-800 text-neutral-100 font-medium border border-neutral-700/80 shadow-sm'
                : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <ExternalLink size={11} />
            <span className="hidden sm:inline">Native Window</span>
          </button>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setInteractionMode(m => m === 'interactive' ? 'view' : 'interactive')}
            title={interactionMode === 'interactive' ? 'Live Interactive Mode ON (Click & Type)' : 'Read-Only View Mode'}
            className={`p-1.5 rounded-lg border text-xs transition-colors flex items-center gap-1 ${
              interactionMode === 'interactive'
                ? 'bg-neutral-800 border-neutral-700 text-neutral-200'
                : 'bg-neutral-900/60 border-neutral-800 text-neutral-500'
            }`}
          >
            <MousePointer size={13} />
          </button>

          <button
            type="button"
            onClick={() => {
              setIsCookieModalOpen(true);
              setCookieFeedback(null);
            }}
            title="Import Cookies & Logged-in Sessions from Other Browsers"
            className="px-2 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 hover:text-amber-300 transition-colors cursor-pointer flex items-center gap-1.5 text-xs font-medium"
          >
            <Cookie size={12} />
            <span className="hidden md:inline text-[11px]">Import Cookies</span>
          </button>

          <button
            type="button"
            onClick={() => handleNavigate()}
            title="Reload Page"
            className="p-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer"
          >
            <RefreshCw size={13} />
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close Panel"
              className="p-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-500 hover:text-neutral-200 transition-colors cursor-pointer"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Cookie & Session Import Modal Dialog */}
      {isCookieModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800 bg-neutral-950/50">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
                  <Cookie size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-neutral-100">Import Cookies & Sessions</h3>
                  <p className="text-xs text-neutral-400">Transfer logged-in sessions into your Camoufox profile</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsCookieModalOpen(false)}
                className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>

            {/* Modal Tabs */}
            <div className="flex border-b border-neutral-800 px-5 pt-3 bg-neutral-950/30 gap-4 text-xs font-medium">
              <button
                type="button"
                onClick={() => { setCookieTab('local'); setCookieFeedback(null); }}
                className={`pb-2.5 border-b-2 flex items-center gap-1.5 transition-colors cursor-pointer ${
                  cookieTab === 'local'
                    ? 'border-amber-400 text-amber-400 font-semibold'
                    : 'border-transparent text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Sparkles size={13} />
                <span>Auto-Extract from Browser</span>
              </button>
              <button
                type="button"
                onClick={() => { setCookieTab('json'); setCookieFeedback(null); }}
                className={`pb-2.5 border-b-2 flex items-center gap-1.5 transition-colors cursor-pointer ${
                  cookieTab === 'json'
                    ? 'border-amber-400 text-amber-400 font-semibold'
                    : 'border-transparent text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <FileText size={13} />
                <span>Paste Cookie JSON</span>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4 text-xs">
              {/* Feedback Alert */}
              {cookieFeedback && (
                <div className={`p-3.5 rounded-xl border flex flex-col gap-2 ${
                  cookieFeedback.type === 'success'
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}>
                  <div className="flex items-start gap-2.5">
                    {cookieFeedback.type === 'success' ? (
                      <Check size={15} className="shrink-0 mt-0.5 text-emerald-400" />
                    ) : (
                      <AlertCircle size={15} className="shrink-0 mt-0.5 text-rose-400" />
                    )}
                    <span className="leading-relaxed">{cookieFeedback.text}</span>
                  </div>
                  {cookieFeedback.type === 'error' && cookieTab === 'local' && (
                    <button
                      type="button"
                      onClick={() => {
                        setCookieTab('json');
                        setCookieFeedback(null);
                        handlePasteClipboard();
                      }}
                      className="self-start mt-1 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 rounded-xl flex items-center gap-1.5 font-medium transition-colors cursor-pointer"
                    >
                      <Clipboard size={12} />
                      <span>Switch to Paste JSON Tab (Instant)</span>
                    </button>
                  )}
                </div>
              )}

              {cookieTab === 'local' ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-neutral-400 font-medium mb-1.5">Source Browser on this Windows PC</label>
                    <select
                      value={cookieBrowser}
                      onChange={(e) => setCookieBrowser(e.target.value)}
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-3 py-2 text-neutral-200 text-xs focus:border-neutral-700 outline-none"
                    >
                      {cookieSources.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-neutral-400 font-medium mb-1.5">
                      Domain Filter <span className="text-neutral-500 font-normal">(Optional, e.g. google.com, github.com)</span>
                    </label>
                    <input
                      type="text"
                      value={cookieDomain}
                      onChange={(e) => setCookieDomain(e.target.value)}
                      placeholder="Leave blank to import all session cookies..."
                      className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-3 py-2 text-neutral-200 placeholder-neutral-600 text-xs focus:border-neutral-700 outline-none"
                    />
                  </div>

                  <div className="p-3 bg-neutral-950 border border-neutral-800/80 rounded-xl text-[11px] text-neutral-400 space-y-1">
                    <p className="font-medium text-neutral-300">💡 Target Camoufox Profile: <span className="text-amber-400">{selectedProfile}</span></p>
                    <p>Decrypted cookies will be automatically injected into your active browsing session and saved to disk.</p>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setIsCookieModalOpen(false)}
                      className="px-3.5 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleImportLocalCookies}
                      disabled={isImportingCookies}
                      className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-neutral-950 font-semibold transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      {isImportingCookies ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                      <span>Extract & Sync Session</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-neutral-400 font-medium">
                        Cookie Array JSON <span className="text-neutral-500 font-normal">(Cookie-Editor export)</span>
                      </label>
                      <button
                        type="button"
                        onClick={handlePasteClipboard}
                        className="px-2 py-1 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-amber-300 hover:text-amber-200 text-[11px] flex items-center gap-1 border border-neutral-700/80 transition-colors cursor-pointer font-medium"
                      >
                        <Clipboard size={11} />
                        <span>Paste from Clipboard</span>
                      </button>
                    </div>
                    <textarea
                      rows={6}
                      value={cookieJsonInput}
                      onChange={(e) => setCookieJsonInput(e.target.value)}
                      placeholder={'[\n  {\n    "name": "session_id",\n    "value": "xyz...",\n    "domain": ".google.com",\n    "path": "/"\n  }\n]'}
                      className="w-full font-mono bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-neutral-200 placeholder-neutral-700 text-[11px] focus:border-neutral-700 outline-none resize-none"
                    />
                  </div>

                  <div className="p-3 bg-neutral-950 border border-neutral-800/80 rounded-xl text-[11px] text-neutral-400 space-y-1">
                    <p className="font-medium text-neutral-300">💡 3-Second Quick Import via Cookie-Editor:</p>
                    <p>1. Open target site (e.g. <span className="text-neutral-200">google.com</span>) in Chrome/Brave/Edge.</p>
                    <p>2. Click the <b>Cookie-Editor</b> extension → <b>Export → JSON</b>.</p>
                    <p>3. Click <b>"Paste from Clipboard"</b> above and click <b>Inject JSON Cookies</b>!</p>
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setIsCookieModalOpen(false)}
                      className="px-3.5 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleImportJsonCookies}
                      disabled={isImportingCookies || !cookieJsonInput.trim()}
                      className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-neutral-950 font-semibold transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      {isImportingCookies ? <Loader2 size={13} className="animate-spin" /> : <Cookie size={13} />}
                      <span>Inject JSON Cookies</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Canvas Frame Area */}
      <div
        ref={containerRef}
        onWheel={handleWheel}
        className="flex-1 relative flex items-center justify-center bg-neutral-950 overflow-hidden"
      >
        {isNativeMode ? (
          <div className="flex flex-col items-center justify-center text-center p-6 space-y-4 max-w-sm">
            <div className="w-12 h-12 rounded-2xl bg-neutral-900 border border-neutral-800 text-neutral-300 flex items-center justify-center">
              <ExternalLink size={22} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-neutral-200">60 FPS Native Window Active</h3>
              <p className="text-xs text-neutral-400 mt-1">
                Camoufox is running in a standalone Firefox desktop window for native 60 FPS performance.
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleToggleMode(true)}
              className="px-4 py-2 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 hover:text-white text-xs font-medium rounded-xl border border-neutral-800 transition-colors flex items-center gap-2 cursor-pointer"
            >
              <Monitor size={13} />
              <span>Dock Back into In-App View</span>
            </button>
          </div>
        ) : isActive && hasFrame ? (
          <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
            <canvas
              ref={canvasRef}
              onClick={handleCanvasClick}
              className="max-w-full max-h-full object-contain select-none border-0 transition-all cursor-default shadow-sm"
              style={{ imageRendering: 'auto' }}
            />
            {clickRipples.map((r) => (
              <span
                key={r.id}
                className="absolute pointer-events-none rounded-full border-2 border-emerald-400 bg-emerald-400/30 animate-ping"
                style={{
                  left: r.x - 12,
                  top: r.y - 12,
                  width: 24,
                  height: 24,
                  zIndex: 40,
                }}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center text-center p-6 space-y-4 max-w-sm">
            <div className="w-12 h-12 rounded-2xl bg-neutral-900 border border-neutral-800 text-neutral-300 flex items-center justify-center">
              {isNavigating ? <Loader2 size={22} className="animate-spin text-neutral-400" /> : <Globe size={22} />}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-neutral-200">Camoufox Live Browser Workspace</h3>
              <p className="text-xs text-neutral-400 mt-1">
                Open a stealth Camoufox session to visually watch and interact live with AI browsing tasks.
              </p>
              {statusMessage && (
                <p className="text-xs text-neutral-400 font-medium mt-2 animate-pulse">
                  {statusMessage}
                </p>
              )}
            </div>

            <div className="w-full bg-neutral-900/80 border border-neutral-800 rounded-xl p-3 text-left space-y-1.5">
              <label className="text-[11px] font-medium text-neutral-300 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <User size={12} className="text-emerald-400" /> Choose Profile:
                </span>
                <span className="text-[10px] font-mono text-neutral-500">({selectedProfile})</span>
              </label>
              <select
                value={selectedProfile}
                onChange={(e) => setSelectedProfile(e.target.value)}
                className="w-full px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded-lg text-xs text-neutral-200 focus:outline-none focus:border-neutral-700 font-medium cursor-pointer"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id} className="bg-neutral-900 text-neutral-200">
                    {p.name || p.id} ({p.id})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5 w-full">
              <button
                type="button"
                onClick={() => handleOpenSession(true)}
                disabled={isNavigating}
                className="flex-1 px-4 py-2 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 hover:text-white text-xs font-medium rounded-xl border border-neutral-800 hover:border-neutral-700 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isNavigating ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                <span>In-App View</span>
              </button>

              <button
                type="button"
                onClick={() => handleOpenSession(false)}
                disabled={isNavigating}
                className="flex-1 px-4 py-2 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 hover:text-white text-xs font-medium rounded-xl border border-neutral-800 hover:border-neutral-700 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <ExternalLink size={13} />
                <span>Native Window</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
