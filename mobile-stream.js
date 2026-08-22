// mobile-stream.js — server-side renderer for port 3006
//
// Puppeteer opens the 3D viewer (localhost:3007) in headless Chrome at 854×480,
// takes a screenshot every second, and streams JPEG frames to phone clients via
// WebSocket. The phone just displays an updating image — no WebGL on device.

const puppeteer  = require('puppeteer-core');
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');

const CHROME = '/home/prizmo/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome';
const SOURCE_URL = 'http://localhost:3009/'; // first-person viewer (internal)
const WIDTH  = 854;
const HEIGHT = 480;
const FPS_MS      = 333;  // ~3 fps when clients connected
const IDLE_FPS_MS = 1000; // 1 fps when nobody is watching

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#000; width:100vw; height:100vh; display:flex; align-items:center; justify-content:center; }
  img { max-width:100%; max-height:100%; display:block; }
  #status { position:fixed; top:8px; left:8px; color:#fff; font:12px monospace; background:rgba(0,0,0,.5); padding:2px 6px; border-radius:3px; }
</style>
</head>
<body>
<div id="status">connecting…</div>
<img id="frame" alt="">
<script>
  const img = document.getElementById('frame');
  const status = document.getElementById('status');
  let prev = null;
  let frames = 0; let t0 = Date.now();

  function connect() {
    const ws = new WebSocket('ws://' + location.host + '/stream');
    ws.binaryType = 'blob';

    ws.onopen = () => { status.textContent = 'live'; };

    ws.onmessage = e => {
      const url = URL.createObjectURL(e.data);
      img.src = url;
      if (prev) URL.revokeObjectURL(prev);
      prev = url;
      frames++;
      if (Date.now() - t0 >= 5000) {
        status.textContent = 'live · ' + (frames / ((Date.now()-t0)/1000)).toFixed(1) + ' fps';
        frames = 0; t0 = Date.now();
      }
    };

    ws.onclose = () => {
      status.textContent = 'reconnecting…';
      setTimeout(connect, 2000);
    };
  }
  connect();
</script>
</body>
</html>`;

let browser = null;
let page    = null;
let timer   = null;
const clients = new Set();

async function startBrowser() {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',  // new headless mode — supports WebGL via ANGLE/SwiftShader
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-angle=swiftshader',   // software WebGL that works in new headless mode
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-software-rasterizer',
      '--window-size=' + WIDTH + ',' + HEIGHT,
    ],
  });
  page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  await page.goto(SOURCE_URL, { waitUntil: 'networkidle0', timeout: 30000 });
  // Wait for chunks to stream in and WebGL scene to render
  await new Promise(r => setTimeout(r, 10000));

  // Throttle requestAnimationFrame so SwiftShader renders at our screenshot
  // rate instead of 60fps. Without this, the GPU process burns 12+ CPU cores
  // doing software rendering nobody ever sees between screenshots.
  await page.evaluate((activeMs, idleMs) => {
    const _raf = window.requestAnimationFrame.bind(window);
    let lastFire = 0;
    window.__setStreamRate = (ms) => { window.__rafMs = ms; };
    window.__setStreamRate(idleMs);
    window.requestAnimationFrame = function (cb) {
      const now    = performance.now();
      const delay  = Math.max(0, (window.__rafMs || idleMs) - (now - lastFire));
      setTimeout(() => {
        lastFire = performance.now();
        _raf(cb);
      }, delay);
    };
  }, FPS_MS, IDLE_FPS_MS);

  console.log('[STREAM] Headless Chrome opened', SOURCE_URL);
}

async function setRafRate(ms) {
  if (page) await page.evaluate((ms) => window.__setStreamRate?.(ms), ms).catch(() => {});
}

async function captureLoop() {
  if (!page) return;

  if (clients.size === 0) {
    // No viewers — slow render loop to near-idle to save CPU
    await setRafRate(IDLE_FPS_MS);
    timer = setTimeout(captureLoop, IDLE_FPS_MS);
    return;
  }

  await setRafRate(FPS_MS);
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
    }
  } catch (e) {
    console.error('[STREAM] Screenshot error:', e.message);
  }
  timer = setTimeout(captureLoop, FPS_MS);
}

async function startStream(port) {
  const app    = express();
  const server = http.createServer(app);
  const wss    = new WebSocket.Server({ server, path: '/stream' });

  app.get('/', (req, res) => res.send(HTML));

  wss.on('connection', ws => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });

  await startBrowser();
  captureLoop();

  server.listen(port, () => console.log('[STREAM] Mobile stream → http://localhost:' + port));

  return () => {
    clearTimeout(timer);
    for (const ws of clients) ws.terminate();
    server.close();
    browser?.close();
  };
}

module.exports = { startStream };
