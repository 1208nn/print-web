#!/usr/bin/env node
/**
 * print-web — 通用在线打印服务（CUPS 前端）
 *
 *   浏览器 ──HTTP──► node ──lp──► CUPS 队列 ──► 打印机
 *
 * 任何 CUPS 队列都可以用。网页提交的作业与 AirPrint、桌面客户端
 * 共用同一个队列和同一条过滤链。
 *
 * 无 npm 依赖；需要 node >= 18、cups-client，PostScript 输入还需要 ghostscript。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

const CFG = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 80),
  queue: process.env.CUPS_QUEUE || '', // 留空则用 lpstat -d 的默认队列
  server: process.env.CUPS_SERVER || '', // 非本机 CUPS 时填 host:port
  lp: process.env.LP || 'lp',
  lpstat: process.env.LPSTAT || 'lpstat',
  cancel: process.env.CANCEL || 'cancel',
  gs: process.env.GS || 'gs',
  rsvg: process.env.RSVG || 'rsvg-convert',
  unite: process.env.PDFUNITE || 'pdfunite',
  maxBytes: Number(process.env.MAX_MB || 50) * 1024 * 1024,
  queueMax: Number(process.env.QUEUE_MAX || 20),
  dryRun: process.env.DRY_RUN === '1',
  defaults: {
    duplex: pick(process.env.DEFAULT_DUPLEX, ['off', 'long', 'short'], 'long'),
    paper: pick(process.env.DEFAULT_PAPER, ['auto', 'a4', 'letter', 'legal', 'a5'], 'auto'),
    resolution: pick(process.env.DEFAULT_RESOLUTION, ['300', '600', '1200'], '600'),
  },
};

const TMP = os.tmpdir();
const HAVE_PDFINFO = spawnSync('pdfinfo', ['-v'], { stdio: 'ignore' }).status === 0;
const HAVE_QR = spawnSync('qrencode', ['-V'], { stdio: 'ignore' }).status === 0;
const HAVE_RSVG = spawnSync(CFG.rsvg, ['--version'], { stdio: 'ignore' }).status === 0;
const HAVE_UNITE = spawnSync(CFG.unite, ['-v'], { stdio: 'ignore' }).status === 0;
const LAN_HOST = lanHost();

const cupsArgs = () => CFG.server ? ['-h', CFG.server] : [];

const QUEUE = CFG.queue || await defaultQueue();

async function defaultQueue() {
  try {
    const out = await run(CFG.lpstat, [...cupsArgs(), '-d']);
    const m = out.match(/destination:\s*(\S+)/i);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/* OpenWrt 的 dnsmasq 解析 <hostname>.lan；解析不到就用本机局域网 IPv4。 */
async function lanHost() {
  const name = `${os.hostname()}.lan`;
  try {
    await run('getent', ['hosts', name]);
    return name;
  } catch {
    return primaryIPv4();
  }
}

function primaryIPv4() {
  const score = (a) => a.startsWith('192.168.') ? 0
    : a.startsWith('10.') ? 1
    : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3;
  const list = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
    .map((n) => n.address)
    .sort((a, b) => score(a) - score(b));
  return list[0] || 'localhost';
}

/* ------------------------------------------------------------------ 任务状态 */

/** @type {Map<string, any>} */
const jobs = new Map();
const queue = [];
let active = null;
let seq = 0;
let pollTimer = null;

function newJob(fields) {
  const job = {
    id: crypto.randomBytes(4).toString('hex'),
    no: ++seq,
    name: 'print',
    size: 0,
    status: 'queued',
    stage: '',
    pages: 0,
    copies: 1,
    cupsId: '',
    error: '',
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
    ...fields,
  };
  jobs.set(job.id, job);
  queue.push(job);
  if (jobs.size > 100) {
    for (const [id, j] of jobs) {
      if (jobs.size <= 100) break;
      if (j.status === 'done' || j.status === 'error' || j.status === 'canceled') jobs.delete(id);
    }
  }
  return job;
}

function publicJob(j) {
  return {
    id: j.id, no: j.no, name: j.name, size: j.size, status: j.status, stage: j.stage,
    pages: j.pages, copies: j.copies, cupsId: j.cupsId, error: j.error,
    createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
  };
}

function pump() {
  if (active) return;
  const job = queue.shift();
  if (!job) return;
  if (job.status === 'canceled') { pump(); return; }
  active = job;
  job.startedAt = Date.now();
  runJob(job)
    .catch((err) => {
      job.status = 'error';
      job.error = err?.message || String(err);
    })
    .finally(() => {
      job.stage = '';
      if (job.status !== 'done' && job.status !== 'canceled') job.finishedAt = Date.now();
      active = null;
      startPolling();
      pump();
    });
}

async function runJob(job) {
  try {
    const src = job.__tmp;
    const ext = extFor(job.kind);
    const file = path.join(TMP, `printweb-${job.id}.${ext}`);
    await fsp.rename(src, file);
    job.__tmp = '';
    job.__file = file;

    const args = [...cupsArgs(), '-d', QUEUE];
    if (job.name) args.push('-t', job.name);
    if (job.opts.sides) args.push('-o', `sides=${job.opts.sides}`);
    if (job.opts.media) args.push('-o', `media=${job.opts.media}`);
    if (job.opts.resolution) args.push('-o', `Resolution=${job.opts.resolution}`);
    if (job.copies > 1) args.push('-n', String(job.copies));
    args.push(file);

    job.status = 'sending';
    job.stage = '提交到 CUPS';

    if (CFG.dryRun) {
      job.cupsId = `${QUEUE}-dry-${job.no}`;
      job.stage = '试运行';
      job.status = 'done';
      job.finishedAt = Date.now();
      return;
    }

    const out = await run(CFG.lp, args);
    const m = out.match(/request id is (\S+)/i);
    if (!m) throw new Error(`lp 没有返回作业号: ${out.trim()}`);
    job.cupsId = m[1];
    job.stage = 'CUPS 队列中';
  } finally {
    if (job.__file) { try { await fsp.unlink(job.__file); } catch {} }
    if (job.__tmp) { try { await fsp.unlink(job.__tmp); } catch {} }
  }
}

function extFor(kind) {
  return { pdf: 'pdf', ps: 'ps', jpeg: 'jpg', png: 'png', text: 'txt' }[kind] || 'bin';
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { if (err.length < 4000) err += c.toString(); });
    child.on('error', (e) => {
      if (e.code === 'ENOENT') return reject(new Error(`找不到 ${cmd}，请确认已安装`));
      reject(e);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} 退出码 ${code}: ${(err || out).trim().slice(0, 500)}`));
    });
  });
}

/* ------------------------------------------------------------------ 状态同步 */

function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    const pendingJobs = [...jobs.values()].filter((j) => j.status === 'sending' && j.cupsId);
    if (!pendingJobs.length) { pollTimer = null; return; }
    try {
      const [pending, completed] = await Promise.all([
        listJobs('not-completed'),
        listJobs('completed'),
      ]);
      for (const j of pendingJobs) {
        if (pending.has(j.cupsId)) {
          j.stage = 'CUPS 队列中';
        } else if (completed.has(j.cupsId)) {
          j.status = 'done';
          j.finishedAt = Date.now();
          j.stage = '';
        } else {
          // 历史被清理或作业被外部取消：不再假装还在跑
          j.status = 'done';
          j.stage = '已离开队列';
          j.finishedAt = Date.now();
        }
      }
    } catch { /* CUPS 暂时不可用时保持现状，下个 tick 再试 */ }
    pollTimer = setTimeout(tick, 1500);
  };
  pollTimer = setTimeout(tick, 800);
}

async function listJobs(which) {
  const out = await run(CFG.lpstat, [...cupsArgs(), '-W', which, '-o']);
  const ids = new Set();
  for (const line of out.split('\n')) {
    const id = line.trim().split(/\s+/)[0];
    if (id && id !== 'no') ids.add(id);
  }
  return ids;
}

async function queueState() {
  if (!QUEUE) return { printer: '', ok: false, state: 'unconfigured' };
  try {
    const out = await run(CFG.lpstat, [...cupsArgs(), '-l', '-p', QUEUE]);
    const desc = out.match(/Description:\s*(.+)/i);
    const printer = desc ? desc[1].trim() : QUEUE;
    if (/is idle/i.test(out)) return { printer, ok: true, state: 'idle' };
    if (/now printing/i.test(out)) return { printer, ok: true, state: 'printing' };
    if (/disabled/i.test(out)) return { printer, ok: false, state: 'disabled' };
    return { printer, ok: false, state: 'unknown' };
  } catch (e) {
    return { printer: QUEUE, ok: false, state: 'missing', error: e.message };
  }
}

/* ------------------------------------------------------------------ 工具 */

function detectKind(head) {
  const hex = head.subarray(0, 4).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'jpeg';
  if (hex === '89504e47') return 'png';
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (head.subarray(0, 2).toString('latin1') === '%!') return 'ps';
  if (head.subarray(0, 2).toString('latin1') === 'PK') return 'zip';
  return 'text';
}

async function countPages(file, kind) {
  try {
    if (kind === 'pdf' && HAVE_PDFINFO) {
      const out = await run('pdfinfo', [file]);
      const m = out.match(/^Pages:\s+(\d+)/m);
      return m ? Number(m[1]) : 0;
    }
    if (kind === 'jpeg' || kind === 'png') return 1;
    const buf = await fsp.readFile(file);
    const n = (buf.toString('latin1').match(/showpage/g) || []).length;
    return n || 0;
  } catch {
    return 0;
  }
}

/*
 * 有些 PPD 没有 *cupsFilter，PostScript 会被 cupsd 原样直通给打印机：
 * pdftops / pstops 都不运行，双面等选项就没人写进数据流。
 * 所以 PS 一律先转成 PDF，让所有输入走同一条过滤链。
 */
async function psToPdf(file) {
  const out = `${file}.pdf`;
  await run(CFG.gs, ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-o', out, file]);
  await fsp.unlink(file).catch(() => {});
  return out;
}

function parseOpts(url) {
  const p = url.searchParams;
  const d = CFG.defaults;
  const duplex = ['off', 'long', 'short'].includes(p.get('duplex')) ? p.get('duplex') : d.duplex;
  const sides = {
    off: 'one-sided',
    long: 'two-sided-long-edge',
    short: 'two-sided-short-edge',
  }[duplex];
  const media = { a4: 'A4', letter: 'Letter', legal: 'Legal', a5: 'A5' }[p.get('paper') || d.paper] || '';
  const copies = Math.min(99, Math.max(1, parseInt(p.get('copies') || '1', 10) || 1));
  const resolution = { 300: '300dpi', 600: '600dpi', 1200: '1200dpi' }[p.get('resolution') || d.resolution] || '600dpi';
  return { duplex, sides, media, copies, resolution };
}

/* ------------------------------------------------------------------ HTTP */

const INDEX = await fsp.readFile(path.join(ROOT, 'public', 'index.html'));

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function saveBody(req, dest) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const ws = fs.createWriteStream(dest);
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      req.unpipe(ws);
      ws.destroy();
      req.pause();
      reject(err);
    };
    req.on('data', (c) => {
      n += c.length;
      if (n > CFG.maxBytes) fail(Object.assign(new Error(`文件超过 ${CFG.maxBytes / 1048576} MB`), { code: 413 }));
    });
    req.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => { if (!failed) resolve(n); });
    req.pipe(ws);
  });
}

async function acceptUpload(req, res, name) {
  if (!QUEUE) return json(res, 503, { error: '服务器没有配置打印队列' });
  if (queue.length >= CFG.queueMax) return json(res, 429, { error: '队列已满，请稍后再试' });
  const opts = parseOpts(new URL(req.url, 'http://localhost'));
  const tmp = path.join(TMP, `printweb-up-${crypto.randomBytes(6).toString('hex')}`);
  let size = 0;
  try {
    size = await saveBody(req, tmp);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    const code = e.code === 413 ? 413 : 400;
    const buf = Buffer.from(JSON.stringify({ error: e.message }));
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, connection: 'close' });
    return res.end(buf);
  }
  if (!size) { try { await fsp.unlink(tmp); } catch {} return json(res, 400, { error: '空文件' }); }

  const fh = await fsp.open(tmp, 'r');
  const head = Buffer.alloc(8);
  await fh.read(head, 0, 8, 0);
  await fh.close();
  let kind = detectKind(head);

  if (kind === 'zip') {
    try { await fsp.unlink(tmp); } catch {}
    return json(res, 415, { error: '这是 Office/压缩包文件，请先另存为 PDF 再打印' });
  }
  if (kind === 'text') {
    const text = await fsp.readFile(tmp, 'utf8');
    if (/[^\x00-\x7F]/.test(text.slice(0, 20000))) {
      try { await fsp.unlink(tmp); } catch {}
      return json(res, 415, { error: '纯文本含非 ASCII 字符（中文等），请先“打印成 PDF”再上传' });
    }
  }

  let src = tmp;
  if (kind === 'ps') {
    try {
      src = await psToPdf(tmp);
      kind = 'pdf';
    } catch (e) {
      try { await fsp.unlink(tmp); } catch {}
      return json(res, 415, { error: `PostScript 转换失败：${e.message}` });
    }
  }

  const pages = await countPages(src, kind);
  const job = newJob({ name, size, kind, pages, copies: opts.copies, opts, __tmp: src });
  res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ job: publicJob(job) }));
  pump();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(INDEX);
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const q = await queueState();
      return json(res, 200, {
        queue: QUEUE,
        ...q,
        defaults: CFG.defaults,
        busy: !!active,
        queued: queue.filter((j) => j.status === 'queued').length,
        dryRun: CFG.dryRun,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      return json(res, 200, {
        jobs: [...jobs.values()].sort((a, b) => b.no - a.no).slice(0, 30).map(publicJob),
        busy: !!active,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const name = decodeURIComponent(url.searchParams.get('name') || 'print');
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > CFG.maxBytes) return json(res, 413, { error: `文件超过 ${CFG.maxBytes / 1048576} MB` });
      return acceptUpload(req, res, name);
    }

    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (!job) return json(res, 404, { error: '没有这个任务' });
      if (job.status === 'queued') {
        job.status = 'canceled';
        job.stage = '已取消';
        job.finishedAt = Date.now();
        return json(res, 200, { job: publicJob(job) });
      }
      if (job.status === 'sending' && job.cupsId && !CFG.dryRun) {
        try {
          await run(CFG.cancel, [...cupsArgs(), job.cupsId]);
          job.status = 'canceled';
          job.stage = '';
          job.finishedAt = Date.now();
          return json(res, 200, { job: publicJob(job) });
        } catch (e) {
          return json(res, 500, { error: e.message });
        }
      }
      return json(res, 409, { error: '任务已结束或已在打印，无法取消' });
    }

    if (req.method === 'POST' && url.pathname === '/api/test') {
      if (!QUEUE) return json(res, 503, { error: '服务器没有配置打印队列' });
      if (!HAVE_RSVG || !HAVE_UNITE) return json(res, 500, { error: '测试页需要 rsvg-convert 和 pdfunite' });
      const opts = parseOpts(url);
      let src;
      try {
        src = await buildTestPage(await pageUrl());
      } catch (e) {
        return json(res, 500, { error: `测试页生成失败：${e.message}` });
      }
      const size = (await fsp.stat(src)).size;
      const job = newJob({ name: '测试页', size, kind: 'pdf', pages: 2, copies: 1, opts, __tmp: src });
      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ job: publicJob(job) }));
      pump();
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err?.message || 'internal error' });
    else res.end();
  }
});

async function pageUrl() {
  const host = await LAN_HOST;
  return `http://${host}${CFG.port === 80 ? '' : `:${CFG.port}`}`;
}

const FONT = "'DejaVu Sans','WenQuanYi Zen Hei','Noto Sans CJK SC','Source Han Sans SC',sans-serif";
const xml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svgText = (x, y, size, text, attrs = '') =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${attrs}>${xml(text)}</text>`;
const svgPage = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="595" height="842" viewBox="0 0 595 842">` +
  `<rect width="595" height="842" fill="#fff"/>${inner}</svg>`;

/* qrencode 的 ASCII 输出每个模块两列，按行合并连续暗块后画成一个 path。 */
function qrSvg(ascii, x, y, size) {
  const rows = ascii.replace(/\n+$/, '').split('\n');
  const n = rows.length;
  const m = size / n;
  const d = [];
  rows.forEach((row, r) => {
    let c = 0;
    while (c * 2 < row.length) {
      if (row[c * 2] !== '#') { c++; continue; }
      const start = c;
      while (c * 2 < row.length && row[c * 2] === '#') c++;
      const w = ((c - start) * m).toFixed(2);
      d.push(`M${(x + start * m).toFixed(2)} ${(y + r * m).toFixed(2)}h${w}v${m.toFixed(2)}h-${w}z`);
    }
  });
  return `<path fill="#000" d="${d.join('')}"/>`;
}

async function testPages(url) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  let qr = '';
  if (HAVE_QR) {
    try {
      const ascii = await run('qrencode', ['-t', 'ASCII', '-m', '2', '-o', '-', url]);
      qr = qrSvg(ascii, 396, 430, 148)
        + svgText(396, 598, 11, '扫码打开打印页面', ' font-weight="bold"')
        + svgText(396, 615, 9, url);
    } catch { /* 二维码失败不影响测试页 */ }
  }

  const first = svgPage([
    svgText(72, 96, 22, '打印测试页 · Print-Web Test Page', ' font-weight="bold"'),
    svgText(72, 132, 12, '打印机连接正常 · The printer is working.'),
    svgText(72, 154, 10, stamp, ' fill="#555"'),
    svgText(72, 198, 12, '第 1 页，共 2 页 · Page 1 of 2'),
    svgText(72, 220, 11, '双面打印时，背面是第 2 页 · With duplex on, the back is page 2.', ' fill="#555"'),
    qr,
  ].join(''));

  const second = svgPage([
    svgText(72, 96, 22, '第 2 页 · Page 2', ' font-weight="bold"'),
    svgText(72, 132, 12, '能看到这页，说明双面打印正常。'),
    svgText(72, 154, 12, 'Seeing this on the BACK of the sheet means duplex works.'),
  ].join(''));

  return [first, second];
}

/* 两页 SVG 各转一份 PDF，再用 pdfunite 合并成作业文件（保留嵌入字体）。 */
async function buildTestPage(url) {
  const id = crypto.randomBytes(4).toString('hex');
  const svg = [1, 2].map((n) => path.join(TMP, `printweb-test-${id}-${n}.svg`));
  const pdf = svg.map((f) => f.replace(/\.svg$/, '.pdf'));
  try {
    const pages = await testPages(url);
    await fsp.writeFile(svg[0], pages[0]);
    await fsp.writeFile(svg[1], pages[1]);
    for (let i = 0; i < 2; i++) await run(CFG.rsvg, ['-f', 'pdf', '-o', pdf[i], svg[i]]);
    const out = path.join(TMP, `printweb-test-${id}.pdf`);
    await run(CFG.unite, [...pdf, out]);
    return out;
  } finally {
    for (const f of [...svg, ...pdf]) { try { await fsp.unlink(f); } catch {} }
  }
}

server.listen(CFG.port, CFG.host, async () => {
  console.log(`print-web  http://${CFG.host}:${CFG.port}`);
  console.log(`queue      ${QUEUE || '(未配置)'}${CFG.dryRun ? '  (DRY RUN)' : ''}`);
  console.log(`test page  ${HAVE_RSVG && HAVE_UNITE ? (HAVE_QR ? 'bilingual + QR' : 'bilingual, no QR (install qrencode)') : 'disabled (install rsvg-convert and poppler-utils)'}`);
  LAN_HOST.then((host) => console.log(`lan host   ${host}`));
  if (!QUEUE) {
    console.warn('没有找到打印队列：设置 CUPS_QUEUE，或先在 CUPS 里配置默认队列。');
    return;
  }
  const q = await queueState();
  console.log(`cups       ${q.state}${q.error ? ` (${q.error})` : ''}`);
});
