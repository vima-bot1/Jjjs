import { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { cropRect, outSize, exportClip, cancelExport, planHls, MAX_CLIP_SECONDS, MAX_MP4_BYTES } from './lib/exporter.js';

const RATIOS = {
  '9:16': { label: 'TikTok / Reels', ar: 9 / 16 },
  '1:1': { label: 'Square', ar: 1 },
  '16:9': { label: 'Landscape', ar: 16 / 9 },
};
const fmt = (t = 0) => {
  if (!isFinite(t)) return '--:--';
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
};
const mediaMsg = (v) =>
  v.error?.code === 4
    ? 'Your browser cannot play this format or codec (H.264/AAC MP4 is safest), or the URL is not a direct video file.'
    : v.error?.code === 2 ? 'Network error while loading the video.' : 'The video could not be loaded.';

/* Draggable crop window drawn over the video */
function CropOverlay({ dim, crop, onMove }) {
  const box = useRef(null), drag = useRef(null);
  const slackX = dim.w - crop.w, slackY = dim.h - crop.h;
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        ref={box}
        className="absolute border-2 border-rose rounded-sm cursor-grab active:cursor-grabbing pointer-events-auto touch-none"
        style={{
          left: `${(crop.x / dim.w) * 100}%`, top: `${(crop.y / dim.h) * 100}%`,
          width: `${(crop.w / dim.w) * 100}%`, height: `${(crop.h / dim.h) * 100}%`,
          boxShadow: '0 0 0 9999px rgba(0,0,0,.62)',
        }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { cx: e.clientX, cy: e.clientY, x0: crop.x, y0: crop.y }; }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const r = box.current.parentElement.getBoundingClientRect(), d = drag.current;
          const dx = ((e.clientX - d.cx) / r.width) * dim.w, dy = ((e.clientY - d.cy) / r.height) * dim.h;
          onMove(slackX ? (d.x0 + dx) / slackX : 0.5, slackY ? (d.y0 + dy) / slackY : 0.5);
        }}
        onPointerUp={() => (drag.current = null)}
      />
    </div>
  );
}

export default function App() {
  const vref = useRef(null), cref = useRef(null), wrap = useRef(null), hlsRef = useRef(null);
  const prev = useRef(false), abort = useRef(null), tRef = useRef(0), cropRef = useRef(null), endRef = useRef(0), ratioRef = useRef('9:16');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [kind, setKind] = useState('mp4');
  const [src, setSrc] = useState('');
  const [cap, setCap] = useState({ ok: false, reason: '' });
  const [dim, setDim] = useState({ w: 16, h: 9 });
  const [time, setTime] = useState(0), [dur, setDur] = useState(0), [playing, setPlaying] = useState(false);
  const [start, setStart] = useState(0), [end, setEnd] = useState(0);
  const [ratio, setRatio] = useState('9:16'), [pos, setPos] = useState({ x: 0.5, y: 0.5 }), [res, setRes] = useState(720);
  const [consent, setConsent] = useState(false);
  const [ex, setEx] = useState(null);

  const ready = status === 'ready';
  const crop = useMemo(() => cropRect(dim.w, dim.h, RATIOS[ratio].ar, pos.x, pos.y), [dim, ratio, pos]);
  const size = outSize(ratio, res);
  const clip = Math.max(0, end - start);
  cropRef.current = crop; endRef.current = end; ratioRef.current = ratio;

  /* one rAF loop: live crop preview, smooth clock, clip-preview stop */
  useEffect(() => {
    let raf;
    const loop = () => {
      const v = vref.current, c = cref.current;
      if (v && c && v.videoWidth && v.readyState >= 2) {
        const ar = RATIOS[ratioRef.current].ar, tw = ar >= 1 ? 480 : 360, th = Math.round(tw / ar), r = cropRef.current;
        if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
        try { c.getContext('2d').drawImage(v, r.x, r.y, r.w, r.h, 0, 0, tw, th); } catch {}
      }
      if (v) {
        if (Math.abs(v.currentTime - tRef.current) > 0.04) { tRef.current = v.currentTime; setTime(v.currentTime); }
        if (prev.current && v.currentTime >= endRef.current) { v.pause(); prev.current = false; }
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => () => {
    hlsRef.current?.destroy(); abort.current?.abort(); cancelExport();
  }, []);
  useEffect(() => () => { if (ex?.blobUrl) URL.revokeObjectURL(ex.blobUrl); }, [ex?.blobUrl]);

  function attach(v, u, isHls) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = () => { settled = true; resolve(); };
      const bad = (m) => (settled ? setError(m) : reject(new Error(m)));
      v.onloadedmetadata = ok;
      v.onerror = () => bad(mediaMsg(v));
      if (isHls && Hls.isSupported()) {
        const h = new Hls(); hlsRef.current = h; let recovered = false;
        h.on(Hls.Events.ERROR, (_, d) => {
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; h.recoverMediaError(); return; }
          bad(d.type === Hls.ErrorTypes.NETWORK_ERROR
            ? 'Could not load the stream. The server may block cross-origin (CORS) requests, or the URL is invalid or expired.'
            : 'This stream uses a codec your browser cannot decode.');
        });
        h.loadSource(u); h.attachMedia(v);
      } else if (isHls && v.canPlayType('application/vnd.apple.mpegurl')) v.src = u;
      else if (isHls) reject(new Error('HLS playback is not supported in this browser.'));
      else v.src = u;
    });
  }

  async function probe(u, isHls) {
    const ac = new AbortController();
    try {
      if (isHls) { await planHls(u, 0, 0.01, ac.signal); return { ok: true }; }
      const r = await fetch(u, { signal: ac.signal });
      if (!r.ok) return { ok: false, reason: `Source returned HTTP ${r.status}; export unavailable.` };
      const n = +r.headers.get('content-length') || 0;
      ac.abort();
      if (n > MAX_MP4_BYTES) return { ok: false, reason: 'File is over 500 MB — too large to export in the browser.' };
      return { ok: true };
    } catch (e) {
      return isHls ? { ok: false, reason: e.message }
        : { ok: false, reason: 'Playback works, but export is unavailable: the server does not allow cross-origin (CORS) reads.' };
    }
  }

  async function load(e) {
    e.preventDefault();
    const u = url.trim(); if (!u) return;
    const v = vref.current;
    hlsRef.current?.destroy(); hlsRef.current = null; v.removeAttribute('src'); v.load();
    prev.current = false; setEx(null); setError(''); setStatus('loading'); setCap({ ok: false, reason: '' });
    let parsed;
    try { parsed = new URL(u); } catch { setStatus('error'); setError('Enter a full URL starting with https://'); return; }
    if (!/^https?:$/.test(parsed.protocol)) { setStatus('error'); setError('Only http(s) URLs are supported.'); return; }
    if (location.protocol === 'https:' && parsed.protocol === 'http:') { setStatus('error'); setError('This page is HTTPS, so the browser blocks http:// media. Use an https:// URL.'); return; }
    const isHls = /\.m3u8(\?|#|$)/i.test(u);
    try {
      await attach(v, u, isHls);
      if (!isFinite(v.duration)) throw new Error('Live streams are not supported — the video needs a known duration.');
    } catch (err) {
      hlsRef.current?.destroy(); hlsRef.current = null;
      setStatus('error'); setError(err.message); return;
    }
    setKind(isHls ? 'hls' : 'mp4'); setSrc(u);
    setDim({ w: v.videoWidth || 1920, h: v.videoHeight || 1080 });
    setDur(v.duration); setStart(0); setEnd(Math.min(v.duration, 15)); setPos({ x: 0.5, y: 0.5 });
    setStatus('ready');
    setCap(await probe(u, isHls));
  }

  const seek = (t) => { vref.current.currentTime = Math.min(Math.max(0, t), dur); };
  const toggle = () => { const v = vref.current; prev.current = false; v.paused ? v.play().catch(() => {}) : v.pause(); };
  const markStart = () => { const t = vref.current.currentTime; setStart(t); if (t >= end) setEnd(Math.min(dur, t + 5)); };
  const markEnd = () => { const t = vref.current.currentTime; if (t <= start) setStart(Math.max(0, t - 1)); setEnd(t); };
  const preview = () => { const v = vref.current; v.currentTime = start; prev.current = true; v.play().catch(() => {}); };
  const pct = (t) => `${dur ? Math.min(100, (t / dur) * 100) : 0}%`;

  const tooLong = clip > MAX_CLIP_SECONDS;
  const canExport = ready && cap.ok && consent && clip >= 0.5 && !tooLong && !(ex && !ex.done && !ex.error);

  async function doExport() {
    const ac = new AbortController(); abort.current = ac;
    setEx({ step: 1, label: 'Starting', value: null });
    try {
      const blob = await exportClip({ url: src, kind, start, end, crop, size, signal: ac.signal, onPhase: (p) => setEx((s) => ({ ...s, ...p })) });
      setEx({ done: true, blobUrl: URL.createObjectURL(blob), size: blob.size });
    } catch (e) {
      setEx(e.name === 'AbortError' ? null : { error: e.message });
    }
  }
  const cancel = () => { abort.current?.abort(); cancelExport(); };
  const running = ex && !ex.done && !ex.error;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-10">
      <header className="mb-6 flex items-end justify-between animate-rise">
        <div>
          <h1 className="font-display text-5xl sm:text-6xl tracking-wide leading-none">
            Movie <span className="bg-gradient-to-r from-ember to-rose bg-clip-text text-transparent">Clip</span> Maker
          </h1>
          <p className="mt-1 text-sm text-zinc-400">Cut a scene, reframe it vertical, export an MP4 — all in your browser.</p>
        </div>
      </header>

      <form onSubmit={load} className="glass mb-6 flex flex-col gap-3 p-3 sm:flex-row">
        <input
          value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" spellCheck="false"
          placeholder="Paste an MP4 or .m3u8 URL you have permission to edit"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm outline-none placeholder:text-zinc-500 focus:border-rose/70"
        />
        <button className="btn-hot sm:w-40" disabled={status === 'loading' || !url.trim()}>
          {status === 'loading' ? (<><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />Loading</>) : 'Load video'}
        </button>
      </form>
      {status === 'error' && <p role="alert" className="mb-6 rounded-xl border border-ember/40 bg-ember/10 px-4 py-3 text-sm text-rose animate-rise">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* ---- player ---- */}
        <section className="glass p-3 sm:p-4">
          <div ref={wrap} className="relative mx-auto overflow-hidden rounded-xl bg-black"
            style={{ aspectRatio: ready ? dim.w / dim.h : '16 / 9', width: ready ? `min(100%, calc(68vh * ${dim.w / dim.h}))` : '100%' }}>
            <video ref={vref} playsInline preload="metadata" className="h-full w-full bg-black object-contain"
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onClick={toggle} />
            {ready && <CropOverlay dim={dim} crop={crop} onMove={(x, y) => setPos({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) })} />}
            {!ready && (
              <div className="absolute inset-0 grid place-items-center text-center text-sm text-zinc-500">
                {status === 'loading' ? <span className="animate-pulse">Connecting to stream…</span> : 'Paste a URL above to begin'}
              </div>
            )}
          </div>

          <div className={`mt-3 transition ${ready ? '' : 'pointer-events-none opacity-40'}`}>
            <div className="relative flex h-8 items-center">
              <div className="absolute inset-x-0 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="absolute inset-y-0 bg-gradient-to-r from-ember/80 to-rose/80" style={{ left: pct(start), width: pct(end - start) }} />
              </div>
              <div className="pointer-events-none absolute h-1.5 rounded-full bg-white/70" style={{ width: pct(time) }} />
              <span className="pointer-events-none absolute h-4 w-0.5 bg-ember" style={{ left: pct(start) }} />
              <span className="pointer-events-none absolute h-4 w-0.5 bg-rose" style={{ left: pct(end) }} />
              <input aria-label="Seek" type="range" className="seek" min="0" max={dur || 0} step="0.01" value={time} onChange={(e) => seek(+e.target.value)} />
            </div>
            <div className="mt-1 flex items-center gap-3">
              <button className="btn-ghost !px-4" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
              <span className="font-mono text-sm tabular-nums text-zinc-300">{fmt(time)} <span className="text-zinc-600">/</span> {fmt(dur)}</span>
              <button className="btn-ghost ml-auto" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : wrap.current.requestFullscreen?.())}>⛶ Fullscreen</button>
            </div>
          </div>
        </section>

        {/* ---- side panels ---- */}
        <aside className={`flex flex-col gap-4 transition ${ready ? '' : 'pointer-events-none opacity-50'}`}>
          <section className="glass p-4">
            <h2 className="mb-3 font-semibold">Clip</h2>
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-ghost" onClick={markStart}>Set start</button>
              <button className="btn-ghost" onClick={markEnd}>Set end</button>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center font-mono text-sm tabular-nums">
              <div className="rounded-lg bg-black/30 py-2"><div className="text-xs text-zinc-500">Start</div>{fmt(start)}</div>
              <div className="rounded-lg bg-black/30 py-2"><div className="text-xs text-zinc-500">End</div>{fmt(end)}</div>
              <div className="rounded-lg bg-black/30 py-2"><div className="text-xs text-zinc-500">Length</div><span className={tooLong ? 'text-ember' : ''}>{clip.toFixed(1)}s</span></div>
            </div>
            <button className="btn-ghost mt-3 w-full" onClick={preview} disabled={clip < 0.2}>▶ Preview selection</button>
            {tooLong && <p className="mt-2 text-xs text-ember">Clips are limited to {MAX_CLIP_SECONDS}s to keep browser memory in check.</p>}
          </section>

          <section className="glass p-4">
            <h2 className="mb-3 font-semibold">Crop</h2>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(RATIOS).map(([k, r]) => (
                <button key={k} className={`chip text-center ${ratio === k ? 'chip-on' : ''}`} onClick={() => setRatio(k)}>
                  <div className="font-semibold">{k}</div><div className="text-[11px] text-zinc-400">{r.label}</div>
                </button>
              ))}
            </div>
            <div className="mt-4 flex gap-4">
              <div className="grid shrink-0 place-items-center rounded-xl bg-black/40 p-2" style={{ width: 130, height: 150 }}>
                <canvas ref={cref} aria-label="Live crop preview" className="max-h-full max-w-full rounded-md" />
              </div>
              <div className="flex-1 space-y-3 text-xs text-zinc-400">
                {[['x', 'Horizontal', dim.w - crop.w], ['y', 'Vertical', dim.h - crop.h]].map(([a, l, slack]) => (
                  <label key={a} className="block">{l}
                    <input type="range" min="0" max="1" step="0.005" value={pos[a]} disabled={!slack}
                      onChange={(e) => setPos((p) => ({ ...p, [a]: +e.target.value }))} className="w-full accent-rose disabled:opacity-30" />
                  </label>
                ))}
                <p>Drag the pink frame on the video, or use the sliders.</p>
              </div>
            </div>
          </section>

          <section className="glass p-4">
            <h2 className="mb-3 font-semibold">Export</h2>
            <div className="grid grid-cols-2 gap-2">
              {[720, 1080].map((r) => (
                <button key={r} className={`chip text-center ${res === r ? 'chip-on' : ''}`} onClick={() => setRes(r)}>
                  <div className="font-semibold">{r}p</div><div className="text-[11px] text-zinc-400">{outSize(ratio, r).w}×{outSize(ratio, r).h} MP4</div>
                </button>
              ))}
            </div>
            <label className="mt-3 flex items-start gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-rose" />
              I own this video or have permission to edit it. Protected (DRM) streams are not processed.
            </label>
            {ready && !cap.ok && cap.reason && <p className="mt-3 rounded-lg bg-ember/10 p-2 text-xs text-rose">{cap.reason}</p>}

            {!running && <button className="btn-hot mt-3 w-full" disabled={!canExport} onClick={doExport}>Export clip</button>}
            {running && (
              <div className="mt-3" aria-live="polite">
                <div className="mb-1 flex justify-between text-xs text-zinc-300">
                  <span>Step {ex.step}/3 · {ex.label}</span>{ex.value != null && <span className="tabular-nums">{Math.round(ex.value * 100)}%</span>}
                </div>
                <div className="relative h-2 overflow-hidden rounded-full bg-white/10">
                  {ex.value != null
                    ? <div className="h-full rounded-full bg-gradient-to-r from-ember to-rose transition-[width]" style={{ width: `${ex.value * 100}%` }} />
                    : <div className="absolute inset-y-0 w-1/3 animate-slide rounded-full bg-gradient-to-r from-ember to-rose" />}
                </div>
                <button className="btn-ghost mt-3 w-full" onClick={cancel}>Cancel</button>
              </div>
            )}
            {ex?.error && <p role="alert" className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-ember/10 p-2 text-xs text-rose">{ex.error}</p>}
            {ex?.done && (
              <div className="mt-3 animate-rise space-y-2">
                <video src={ex.blobUrl} controls playsInline className="w-full rounded-lg bg-black" style={{ maxHeight: 280 }} />
                <a className="btn-hot w-full" href={ex.blobUrl} download={`clip-${ratio.replace(':', 'x')}-${res}p.mp4`}>Download MP4 ({(ex.size / 1048576).toFixed(1)} MB)</a>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
