// ============================================================================
// Video Downloader Server — Node.js + Express + yt-dlp
// ============================================================================
// Downloads videos from YouTube, Facebook, TikTok, Instagram, X and any other
// site yt-dlp supports, and streams them back to the visitor as an mp4 file.
//
// No API keys, no tokens, no accounts, nothing stored.
// The video is downloaded to a temp file, streamed to the visitor, then deleted.
//
// Endpoints:
//   GET  /                  health check            { ok, service, activeJobs, maxJobs }
//   GET  /api/info?url=...  video info (title, duration, uploader, thumbnail, formats)
//   POST /api/download      { url, quality }        -> streams the mp4 back as a download
//
// Environment:
//   PORT        Render sets this automatically (default 3000)
//   YTDLP_PATH  path to the yt-dlp binary (default: ./yt-dlp next to this file)
// ============================================================================

const express = require('express');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || path.join(__dirname, 'yt-dlp');

const MAX_CONCURRENT_JOBS = 5;               // max downloads running at once
const MAX_DURATION_SECONDS = 3 * 60 * 60;    // 3 hours
const MAX_FILE_BYTES = 500 * 1024 * 1024;    // ~500 MB
const INFO_TIMEOUT_MS = 60 * 1000;           // 60s to read video info
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;  // 20 min to finish a download
const QUALITIES = { '360': 360, '480': 480, '720': 720 };

let activeJobs = 0;

const app = express();
app.use(express.json({ limit: '64kb' }));

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// CORS — the static downloader website calls this server from any origin
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// URL validation — only http/https, no localhost / private network addresses
// ---------------------------------------------------------------------------
function validateUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 'الرابط فارغ';
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return 'الرابط غير صحيح';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'الرابط يجب أن يبدأ بـ http أو https';
  }
  const host = u.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    return 'الروابط الداخلية غير مسموحة';
  }
  return null; // valid
}

// ---------------------------------------------------------------------------
// yt-dlp helpers
// ---------------------------------------------------------------------------
function runYtdlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').toString().slice(0, 500);
        return reject(new Error(msg || 'فشل yt-dlp'));
      }
      resolve(stdout);
    });
  });
}

async function fetchInfo(url) {
  const baseArgs = ['--no-playlist', '--no-warnings', '--dump-json', url];
  try {
    const out = await runYtdlp(baseArgs, INFO_TIMEOUT_MS);
    return JSON.parse(out);
  } catch (e) {
    // YouTube sometimes answers "Sign in to confirm you're not a bot" from
    // datacenter IPs. The embedded-TV player client bypasses that check
    // most often, so retry with it first, then with the mobile clients.
    if (!isBotCheckError(e.message)) throw e;
    for (const client of ['tv_embedded', 'android,ios']) {
      try {
        log('INFO bot-check, retrying with player_client=' + client, url);
        const out = await runYtdlp(
          ['--no-playlist', '--no-warnings',
           '--extractor-args', 'youtube:player_client=' + client,
           '--dump-json', url],
          INFO_TIMEOUT_MS
        );
        return JSON.parse(out);
      } catch (e2) {
        if (!isBotCheckError(e2.message)) throw e2;
        // fall through to the next client
      }
    }
    throw e;
  }
}

function isBotCheckError(msg) {
  const m = (msg || '').toLowerCase();
  return m.includes("sign in to confirm") || m.includes('not a bot') || m.includes('confirm you');
}

function safeFileName(title) {
  const base = (title || 'video')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[^\w\u0600-\u06FF\- .()]/g, '')
    .trim()
    .slice(0, 80);
  return base || 'video';
}

function pickFormats(info) {
  return (info.formats || [])
    .filter((f) => f.vcodec && f.vcodec !== 'none' && f.ext)
    .map((f) => ({
      format_id: f.format_id,
      ext: f.ext,
      height: f.height || null,
      width: f.width || null,
      fps: f.fps || null,
      filesize: f.filesize || f.filesize_approx || null,
    }))
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .slice(0, 30);
}

function downloadVideo(url, quality, tmpDir, playerClient) {
  // Best video at or below the requested height + best audio, merged to mp4.
  // Using yt-dlp's own best-match logic (not hardcoded format IDs) because
  // audio track IDs differ per video (e.g. 140 vs 140-1 for Arabic tracks).
  const selector =
    `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]` +
    `/bestvideo[height<=${quality}]+bestaudio` +
    `/best[height<=${quality}][ext=mp4]/best`;
  const args = [
    '--no-playlist',
    '--no-warnings',
  ];
  if (playerClient) {
    args.push('--extractor-args', 'youtube:player_client=' + playerClient);
  }
  args.push(
    '-f', selector,
    '--merge-output-format', 'mp4',
    '-o', path.join(tmpDir, 'video.%(ext)s'),
    url,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { timeout: DOWNLOAD_TIMEOUT_MS });
    let errText = '';
    child.stderr.on('data', (d) => { errText += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const err = new Error(errText.slice(-500) || `yt-dlp خرج بالكود ${code}`);
      err.botCheck = isBotCheckError(errText);
      reject(err);
    });
  });
}

function tooBusy(res) {
  return res.status(429).json({ ok: false, error: 'السيرفر مشغول الآن، جرّب بعد دقيقة' });
}

// ---------------------------------------------------------------------------
// GET / — health check
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'video-downloader', activeJobs, maxJobs: MAX_CONCURRENT_JOBS });
});

// ---------------------------------------------------------------------------
// GET /api/info?url=... — video title / duration / uploader / thumbnail / formats
// ---------------------------------------------------------------------------
app.get('/api/info', async (req, res) => {
  const url = req.query.url;
  const bad = validateUrl(url);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  if (activeJobs >= MAX_CONCURRENT_JOBS) return tooBusy(res);

  activeJobs++;
  try {
    log('INFO', url);
    const info = await fetchInfo(url);
    if (info.duration && info.duration > MAX_DURATION_SECONDS) {
      return res.status(400).json({ ok: false, error: 'الفيديو أطول من 3 ساعات' });
    }
    res.json({
      ok: true,
      title: info.title || '',
      duration: info.duration || null,
      uploader: info.uploader || '',
      thumbnail: info.thumbnail || '',
      webpage_url: info.webpage_url || url,
      formats: pickFormats(info),
    });
  } catch (e) {
    log('INFO ERROR', url, e.message);
    res.status(502).json({
      ok: false,
      error: 'تعذّر قراءة الرابط — جرّب رابطاً آخر أو أعد المحاولة بعد قليل',
      detail: e.message,
    });
  } finally {
    activeJobs--;
  }
});

// ---------------------------------------------------------------------------
// POST /api/download { url, quality } and GET /api/download?url=&quality=
// — downloads and streams the mp4 back (GET is the plain-link form the site uses)
async function handleDownload(req, res) {
  const { url, quality } = { ...(req.body || {}), ...(req.query || {}) };
  const bad = validateUrl(url);
  if (bad) return res.status(400).json({ ok: false, error: bad });
  const q = QUALITIES[String(quality)] || 480;
  if (activeJobs >= MAX_CONCURRENT_JOBS) return tooBusy(res);

  activeJobs++;
  const jobId = crypto.randomBytes(6).toString('hex');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `vd-${jobId}-`));
  const cleanup = () => {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  };

  try {
    log('DOWNLOAD START', jobId, 'quality=' + q, url);

    // 1) Read info first: title + duration/size guards
    const info = await fetchInfo(url);
    if (info.duration && info.duration > MAX_DURATION_SECONDS) {
      return res.status(400).json({ ok: false, error: 'الفيديو أطول من 3 ساعات' });
    }
    const est = info.filesize || info.filesize_approx || null;
    if (est && est > MAX_FILE_BYTES) {
      return res.status(400).json({ ok: false, error: 'الفيديو أكبر من 500 ميغا' });
    }
    const filename = safeFileName(info.title) + '.mp4';

    // 2) Download best video <= requested height + best audio, merged to mp4.
    // Retry chain on bot-check: embedded-TV player first, then mobile clients.
    let lastErr = null;
    for (const client of [null, 'tv_embedded', 'android,ios']) {
      try {
        await downloadVideo(url, q, tmpDir, client);
        lastErr = null;
        break;
      } catch (e) {
        if (!e.botCheck) throw e;
        log('DOWNLOAD bot-check, retrying with player_client=' + (client === null ? 'default->tv_embedded' : client), jobId);
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;

    // 3) Find the finished file, check its size, and stream it to the visitor
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith('video.'));
    if (!files.length) throw new Error('لم يظهر ملف بعد التنزيل');
    const filePath = path.join(tmpDir, files[0]);
    const size = fs.statSync(filePath).size;
    if (size > MAX_FILE_BYTES) {
      return res.status(400).json({ ok: false, error: 'الفيديو أكبر من 500 ميغا' });
    }
    log('DOWNLOAD DONE', jobId, filename, (size / 1024 / 1024).toFixed(1) + 'MB');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', size);
    res.download(filePath, filename, (err) => {
      if (err) log('SEND ERROR', jobId, err.message);
      cleanup(); // temp file deleted right after it reaches the visitor
    });
  } catch (e) {
    log('DOWNLOAD ERROR', jobId, e.message);
    cleanup();
    if (!res.headersSent) {
      res.status(502).json({
        ok: false,
        error: 'تعذّر تنزيل الفيديو — جرّب رابطاً آخر أو أعد المحاولة بعد قليل',
        detail: e.message,
      });
    }
  } finally {
    activeJobs--;
  }
}

app.post('/api/download', handleDownload);
app.get('/api/download', handleDownload);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  log(`video-downloader server listening on port ${PORT}`);
  log(`yt-dlp: ${YTDLP}`);
  // Self-check: confirm yt-dlp actually runs, so a broken binary is visible
  // in the logs immediately instead of failing on the first visitor.
  execFile(YTDLP, ['--version'], { timeout: 15000 }, (err, stdout) => {
    if (err) log('WARNING: yt-dlp did not start:', err.message);
    else log('yt-dlp version:', stdout.toString().trim());
  });
});

// Graceful shutdown (Render sends SIGTERM when it stops the service)
function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
