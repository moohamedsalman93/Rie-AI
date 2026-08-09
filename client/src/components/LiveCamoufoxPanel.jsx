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
  User
} from 'lucide-react';
import { performBrowserAction, getBrowserActiveSession, getBrowserProfiles } from '../services/chatApi';

export function LiveCamoufoxPanel({ onClose, isEmbedded = true }) {
  const [frameData, setFrameData] = useState(null);
  const [isActive, setIsActive] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');
  const [currentTitle, setCurrentTitle] = useState('');
  const [isConnecting, setIsConnecting] = useState(true);
  const [isNavigating, setIsNavigating] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [interactionMode, setInteractionMode] = useState('interactive');
  const [isNativeMode, setIsNativeMode] = useState(false);
  const [profiles, setProfiles] = useState([{ id: 'default', name: 'Default Profile' }]);
  const [selectedProfile, setSelectedProfile] = useState('default');
  
  const imgRef = useRef(null);
  const wsRef = useRef(null);
  const containerRef = useRef(null);
  const resizeTimerRef = useRef(null);
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;

  // Fetch registered browser profiles and check active session status
  useEffect(() => {
    getBrowserProfiles()
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setProfiles(data);
        }
      })
      .catch((err) => console.error('Failed to load profiles:', err));

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

  // Adaptive ResizeObserver to sync Playwright viewport size with panel dimensions
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 200 && height > 200) {
          const targetW = Math.round(width);
          const targetH = Math.round(height);
          
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
        wsRef.current = ws;

        ws.onopen = () => {
          if (isMounted) setIsConnecting(false);
          // Send initial adaptive container dimensions if ready
          if (containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            if (rect.width > 200 && rect.height > 200) {
              ws.send(JSON.stringify({
                action: 'resize_viewport',
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              }));
            }
          }
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'frame') {
              setFrameData(data.image);
              setIsActive(true);
              setIsNavigating(false);
              setStatusMessage('');
              if (data.url && data.url !== currentUrlRef.current) {
                setCurrentUrl(data.url);
                setUrlInput(data.url);
              }
              if (data.title) setCurrentTitle(data.title);
            } else if (data.type === 'status') {
              setIsActive(data.active);
              if (!data.active) {
                setFrameData(null);
              }
            }
          } catch (err) {
            console.error('Error parsing browser stream frame:', err);
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
    if (interactionMode !== 'interactive' || !imgRef.current) return;
    
    const rect = imgRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const scaleX = imgRef.current.naturalWidth / rect.width;
    const scaleY = imgRef.current.naturalHeight / rect.height;

    const actualX = Math.round(clickX * scaleX);
    const actualY = Math.round(clickY * scaleY);

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

  const handleWheel = (e) => {
    if (interactionMode !== 'interactive') return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        action: 'scroll',
        deltaX: e.deltaX,
        deltaY: e.deltaY
      }));
    }
  };

  const handleKeyDown = (e) => {
    if (interactionMode !== 'interactive') return;
    if (document.activeElement?.tagName === 'INPUT') return;

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
      className="flex flex-col h-full w-full bg-neutral-950 border-l border-neutral-800/80 select-none overflow-hidden"
    >
      {/* Sleek Minimal Dark Header Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-neutral-900/90 border-b border-neutral-800/80">
        <div className="flex items-center gap-1.5 text-xs text-neutral-300 font-medium bg-neutral-800/80 px-2 py-1 rounded-lg border border-neutral-700/60">
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
          <button type="submit" disabled={isNavigating} className="p-1 hover:bg-neutral-800 rounded-md text-neutral-400 hover:text-neutral-200 transition-colors">
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
            title={interactionMode === 'interactive' ? 'Live Interactive Mode ON' : 'Read-Only View Mode'}
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
            onClick={() => handleNavigate()}
            title="Reload Page"
            className="p-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            <RefreshCw size={13} />
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close Panel"
              className="p-1.5 rounded-lg bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-500 hover:text-neutral-200 transition-colors"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

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
        ) : isActive && frameData ? (
          <div className="relative w-full h-full flex items-center justify-center">
            <img
              ref={imgRef}
              src={frameData}
              alt="Camoufox Live Stream"
              onClick={handleCanvasClick}
              className={`w-full h-full object-fill border-0 transition-all ${
                interactionMode === 'interactive' ? 'cursor-crosshair' : 'cursor-default'
              }`}
            />
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
