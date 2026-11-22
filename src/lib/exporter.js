import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

export const MAX_CLIP_SECONDS = 180;
export const MAX_MP4_BYTES = 500 * 1024 * 1024;
let ff = null;

/* ---------- geometry ---------- */
export function cropRect(vw, vh, ar, px, py) {
  let w = vw, h = vw / ar;
  if (h > vh) { h = vh; w = vh * ar; }
  w = Math.floor(w / 2) * 2; h = Math.floor(h / 2) * 2;
  return { x: Math.round(((vw - w) * px) / 2) * 2, y: Math.round(((vh - h) * py) / 2) * 2, w, h };
}
export function outSize(ratio, res) {
  const even = (n) => Math.round(n / 2) * 2;
  if (ratio === '9:16') return { w: res, h: even((res * 16) / 9) };
  if (ratio === '16:9') return { w: even((res * 16) / 9), h: res };
  return { w: res, h: res };
}

/* ---------- network ---------- */
const netErr = (e) =>
  e.name === 'AbortError' ? e
  : new Error(e instanceof TypeError
      ? 'Request blocked: the server does not allow cross-origin (CORS) reads, or the URL is unreachable.'
      : e.message);

async function get(url, signal) {
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`Source returned HTTP ${r.status}.`);
    return r;
  } catch (e) { throw netErr(e); }
}
const getText = async (u, s) => (await get(u, s)).text();
const getBuf = async (u, s) => { try { return new Uint8Array(await (await get(u, s)).arrayBuffer()); } catch (e) { throw netErr(e); } };

async function getStreamed(url, signal, onP) {
  const r = await get(url, signal);
  const total = +r.headers.get('content-length') || 0;
  if (total > MAX_MP4_BYTES) throw new Error('File is larger than 500 MB — too big to process in the browser.');
  const rd = r.body.getReader(); const chunks = []; let got = 0;
  try {
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      chunks.push(value); got += value.length;
      if (got > MAX_MP4_BYTES) throw new Error('File is larger than 500 MB — too big to process in the browser.');
      onP(total ? got / total : null);
    }
  } catch (e) { throw netErr(e); }
  return concat(chunks);
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------- HLS planning (VOD, clear streams only) ---------- */
export async function planHls(url, start, end, signal) {
  let base = url, text = await getText(url, signal);
  if (text.includes('#EXT-X-STREAM-INF')) {
    const L = text.split(/\r?\n/); let best = null;
    L.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF')) return;
      const bw = +(/BANDWIDTH=(\d+)/.exec(l)?.[1] || 0), u = L[i + 1]?.trim();
      if (u && (!best || bw > best.bw)) best = { bw, u };
    });
    if (!best) throw new Error('No playable variant found in the master playlist.');
    base = new URL(best.u, url).href; text = await getText(base, signal);
  }
  let t = 0, d = 0, init = null, ended = false; const segs = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l) continue;
    if (l.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(l))
      throw new Error('This stream is encrypted / DRM-protected. Export is not supported for protected streams.');
    if (l.startsWith('#EXT-X-BYTERANGE')) throw new Error('Byte-range HLS playlists are not supported for export.');
    if (l.startsWith('#EXT-X-MAP')) { const m = /URI="([^"]+)"/.exec(l); if (m) init = new URL(m[1], base).href; }
    else if (l.startsWith('#EXTINF')) d = parseFloat(l.slice(8)) || 0;
    else if (l.startsWith('#EXT-X-ENDLIST')) ended = true;
    else if (!l.startsWith('#')) { segs.push({ uri: new URL(l, base).href, t0: t, t1: t + d }); t += d; d = 0; }
  }
  if (!ended) throw new Error('Live HLS streams cannot be exported — only complete (VOD) streams.');
  const pick = segs.filter((s) => s.t1 > start && s.t0 < end);
  if (!pick.length) throw new Error('The selected range is outside the playlist.');
  return { init, pick, offset: start - pick[0].t0, ext: init ? 'mp4' : 'ts' };
}

/* ---------- ffmpeg ---------- */
async function getFF() {
  if (ff) return ff;
  const f = new FFmpeg();
  await f.load({ coreURL, wasmURL });
  ff = f; return f;
}
export function cancelExport() { try { ff?.terminate(); } catch {} ff = null; }

export async function exportClip({ url, kind, start, end, crop, size, onPhase, signal }) {
  const written = []; let ffm; const tail = [];
  const onLog = ({ message }) => { tail.push(message); if (tail.length > 6) tail.shift(); };
  const onProg = ({ progress }) => onPhase({ step: 3, label: 'Encoding clip', value: Math.min(1, Math.max(0, progress)) });
  const onAbort = () => cancelExport();
  signal.addEventListener('abort', onAbort);
  try {
    // Step 1: fetch only what is needed
    let data, inName, offset;
    onPhase({ step: 1, label: 'Downloading source', value: 0 });
    if (kind === 'hls') {
      const plan = await planHls(url, start, end, signal);
      const urls = [...(plan.init ? [plan.init] : []), ...plan.pick.map((s) => s.uri)];
      const out = new Array(urls.length); let next = 0, done = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < urls.length) {
          const k = next++; out[k] = await getBuf(urls[k], signal);
          onPhase({ step: 1, label: `Downloading segments (${++done}/${urls.length})`, value: done / urls.length });
        }
      }));
      data = concat(out); inName = `in.${plan.ext}`; offset = plan.offset;
    } else {
      data = await getStreamed(url, signal, (v) => onPhase({ step: 1, label: 'Downloading source', value: v }));
      inName = 'in.mp4'; offset = start;
    }
    signal.throwIfAborted();

    // Step 2: encoder
    onPhase({ step: 2, label: 'Loading encoder (one-time, ~30 MB)', value: null });
    ffm = await getFF();
    ffm.on('log', onLog); ffm.on('progress', onProg);
    await ffm.writeFile(inName, data); written.push(inName); data = null;

    // Step 3: crop + scale + encode
    onPhase({ step: 3, label: 'Encoding clip', value: 0 });
    const vf = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${size.w}:${size.h}:flags=lanczos,setsar=1`;
    const code = await ffm.exec([
      '-ss', offset.toFixed(3), '-i', inName, '-t', (end - start).toFixed(3),
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', 'out.mp4',
    ]);
    written.push('out.mp4');
    if (code !== 0) throw new Error(`Encoding failed. The source codec may be unsupported.\n${tail.join('\n')}`);
    const out = await ffm.readFile('out.mp4');
    return new Blob([out], { type: 'video/mp4' });
  } catch (e) {
    if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
    throw e;
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (ffm) {
      try { ffm.off('log', onLog); ffm.off('progress', onProg); } catch {}
      for (const f of written) { try { await ffm.deleteFile(f); } catch {} }
    }
  }
}
