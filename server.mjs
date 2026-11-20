// Code Mirror local service: reads git changes, has a model review them, tracks each finding
// until it is fixed, and serves the web page. Review engines: the Claude Code CLI, or any
// OpenAI-compatible service such as Ollama. Node built-ins only; listens on 127.0.0.1.
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const RUNS = path.join(HERE, 'data', 'runs');

const PORT = Number(process.env.PORT || 8795);
const HOST = process.env.HOST || '127.0.0.1';
const MODEL_URL = (process.env.MIRROR_MODEL_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
// e4b is about 7–8 GB; the untagged latest is 25 GB.
const MODEL = process.env.MIRROR_MODEL || 'nemotron-3.5-bolt:e4b';
const MODEL_KEY = process.env.MIRROR_MODEL_KEY || '';

function findClaude() {
  if (process.env.MIRROR_CLAUDE_BIN) return process.env.MIRROR_CLAUDE_BIN;
  const dirs = (process.env.PATH || '').split(path.delimiter).concat([path.join(os.homedir(), '.local', 'bin')]);
  for (const d of dirs) {
    const p = path.join(d, 'claude');
    if (d && existsSync(p)) return p;
  }
  return '';
}
const CLAUDE_BIN = findClaude();
const CLAUDE_MODEL = process.env.MIRROR_CLAUDE_MODEL || ''; // empty = the account's default model
const ENGINE = process.env.MIRROR_ENGINE === 'openai' || !CLAUDE_BIN ? 'openai' : 'claude';
// Max characters of diff per review; a small local model gets less.
const BUDGET = Number(process.env.MIRROR_REVIEW_BUDGET || (ENGINE === 'claude' ? 200000 : 60000));
const DEFAULT_REPO = process.env.MIRROR_REPO || '';
const MAX_PATCH = 1_500_000; // larger diffs are not rendered
const MAX_SCAN = 400; // max files read per review
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'go.sum', 'composer.lock']);

class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => new HttpError(code, message);

// ---------- git ----------
async function git(cwd, args, okCodes = [0]) {
  try {
    const { stdout } = await execFileP('git', args, { cwd, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    if (okCodes.includes(e.code) && e.stdout) return e.stdout;
    const msg = (e.stderr ? e.stderr.toString() : String(e.message || '')).trim();
    throw fail(400, msg || 'git 命令失败');
  }
}

async function resolveRepo(p) {
  if (!p || !path.isAbsolute(p)) throw fail(400, '仓库路径要写完整，从 / 开始');
  let st;
  try { st = await stat(p); } catch { throw fail(400, `找不到这个文件夹：${p}`); }
  if (!st.isDirectory()) throw fail(400, `这不是文件夹：${p}`);
  return (await git(p, ['rev-parse', '--show-toplevel'])).toString().trim();
}

async function verifyRef(root, ref) {
  if (!ref || ref.startsWith('-')) throw fail(400, `分支名不对：${ref || '（空）'}`);
  try { await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); }
  catch { throw fail(400, `仓库里找不到：${ref}`); }
}

function readMode(q) {
  const mode = q.mode === 'worktree' ? 'worktree' : 'refs';
  return { mode, base: q.base || '', head: q.head || '' };
}

async function repoInfo(p) {
  const root = await resolveRepo(p);
  const current = (await git(root, ['branch', '--show-current'])).toString().trim();
  // Skip refs/remotes/*/HEAD: its short name ("origin") looks like a branch.
  const refs = (await git(root, ['for-each-ref', '--format=%(refname)%09%(refname:short)', 'refs/heads', 'refs/remotes']))
    .toString().split('\n').map((s) => s.split('\t'))
    .filter(([full, short]) => full && short && !full.endsWith('/HEAD'))
    .map(([, short]) => short);
  return { root, current, branches: refs };
}

function parseNumstat(buf) {
  const parts = buf.toString('utf8').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    const add = m[1] === '-' ? null : Number(m[1]);
    const del = m[2] === '-' ? null : Number(m[2]);
    if (m[3] === '') { out.push({ oldPath: parts[i + 1], path: parts[i + 2], add, del }); i += 2; }
    else out.push({ path: m[3], add, del });
  }
  return out;
}

function parseNameStatus(buf) {
  const parts = buf.toString('utf8').split('\0');
  const out = new Map();
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const t = code[0];
    if (t === 'R' || t === 'C') { out.set(parts[i + 2], t); i += 2; }
    else { out.set(parts[i + 1], t); i += 1; }
  }
  return out;
}

async function untrackedFiles(root, only) {
  const args = ['ls-files', '--others', '--exclude-standard', '-z'];
  if (only) args.push('--', only);
  return (await git(root, args)).toString('utf8').split('\0').filter(Boolean);
}

async function countLines(file) {
  const st = await stat(file);
  if (st.size > 8 * 1024 * 1024) return { add: null, binary: true };
  const buf = await readFile(file);
  if (buf.includes(0)) return { add: null, binary: true };
  const text = buf.toString('utf8');
  if (!text) return { add: 0, binary: false };
  return { add: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), binary: false };
}

async function listChanges(root, mode, base, head) {
  const range = mode === 'worktree' ? ['HEAD'] : [`${base}...${head}`];
  const numstat = parseNumstat(await git(root, ['diff', '--numstat', '-z', '-M', ...range]));
  const status = parseNameStatus(await git(root, ['diff', '--name-status', '-z', '-M', ...range]));
  const files = numstat.map((f) => ({
    ...f,
    status: status.get(f.path) || 'M',
    binary: f.add === null || f.del === null,
  }));
  if (mode === 'worktree') {
    for (const p of await untrackedFiles(root)) {
      const c = await countLines(path.join(root, p));
      files.push({ path: p, add: c.add, del: c.binary ? null : 0, status: 'A', binary: c.binary, untracked: true });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const totals = { files: files.length, add: 0, del: 0 };
  for (const f of files) { totals.add += f.add || 0; totals.del += f.del || 0; }
  let ahead, behind;
  if (mode === 'refs') {
    const lr = (await git(root, ['rev-list', '--left-right', '--count', `${base}...${head}`])).toString().trim().split(/\s+/);
    behind = Number(lr[0]); ahead = Number(lr[1]);
  }
  return { root, mode, base, head, ahead, behind, files, totals };
}

async function getPatch(root, mode, base, head, file, oldPath, untracked) {
  if (!file || file.startsWith('-')) throw fail(400, '文件名不对');
  let buf;
  if (mode === 'worktree' && untracked) {
    const list = await untrackedFiles(root, file);
    if (!list.includes(file)) throw fail(400, `这个文件不在没提交的新文件里：${file}`);
    buf = await git(root, ['diff', '--no-index', '--', '/dev/null', file], [1]);
  } else {
    const range = mode === 'worktree' ? ['HEAD'] : [`${base}...${head}`];
    const paths = oldPath && oldPath !== file ? [oldPath, file] : [file];
    buf = await git(root, ['diff', '-M', ...range, '--', ...paths]);
  }
  if (buf.length > MAX_PATCH) return { patch: '', tooLarge: true, size: buf.length };
  return { patch: buf.toString('utf8') };
}

// ---------- Models ----------
const authHeaders = () => (MODEL_KEY ? { Authorization: `Bearer ${MODEL_KEY}` } : {});

async function claudeVersion() {
  const { stdout } = await execFileP(CLAUDE_BIN, ['--version'], { timeout: 10000 });
  return stdout.toString().trim();
}

async function modelStatus() {
  if (ENGINE === 'claude') {
    const label = `Claude Code（${CLAUDE_MODEL || '账号默认的模型'}）`;
    try {
      const version = await claudeVersion();
      return { engine: 'claude', url: CLAUDE_BIN, model: label, reachable: true, hasModel: true, version };
    } catch {
      return { engine: 'claude', url: CLAUDE_BIN, model: label, reachable: false, error: '这台电脑上的 Claude Code 命令行打不开' };
    }
  }
  const base = { engine: 'openai', url: MODEL_URL, model: MODEL };
  try {
    const r = await fetch(`${MODEL_URL}/models`, { headers: authHeaders(), signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ...base, reachable: false, error: `模型服务回了 HTTP ${r.status}` };
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id);
    return { ...base, reachable: true, hasModel: ids.some((id) => id === MODEL || id.startsWith(`${MODEL}:`)), models: ids };
  } catch (e) {
    return { ...base, reachable: false, error: e.name === 'TimeoutError' ? '连接模型服务超时' : '连不上模型服务' };
  }
}

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.sql', '.vue', '.svelte']);

function extractJson(text) {
  let t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1];
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const SEVERITY = new Set(['高', '中', '低']);

// Review result shape, enforced by Claude Code's --json-schema.
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    focusAreas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                line: { type: 'integer', minimum: 0 },
                side: { type: 'string', enum: ['additions', 'deletions'] },
                severity: { type: 'string', enum: ['高', '中', '低'] },
                title: { type: 'string' },
                detail: { type: 'string' },
                suggestion: { type: 'string' },
              },
              required: ['file', 'line', 'side', 'severity', 'title', 'detail', 'suggestion'],
            },
          },
        },
        required: ['title', 'why', 'findings'],
      },
    },
  },
  required: ['summary', 'focusAreas'],
};

// Runs the Claude Code CLI in print mode (-p) with JSON output.
// Review and recheck: no tools, run in a temp folder, no session kept.
// Fix: read/edit tools only, runs inside the repository, session kept for tracing.
function runClaude({ prompt, system, input = '', schema, cwd = os.tmpdir(), tools = '', permissionMode, persist = false }) {
  const args = ['-p', prompt, '--output-format', 'json', '--tools', tools, '--strict-mcp-config', '--setting-sources', 'project', '--permission-prompts', 'none'];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (system) args.push('--system-prompt', system);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (!persist) args.push('--no-session-persistence');
  if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const errs = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill('SIGINT'); }, 15 * 60 * 1000);
    child.stdout.on('data', (c) => { size += c.length; if (size < 50 * 1024 * 1024) chunks.push(c); });
    child.stderr.on('data', (c) => errs.push(c));
    child.on('error', (e) => { clearTimeout(timer); reject(fail(502, `Claude Code 没能启动：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const outText = Buffer.concat(chunks).toString('utf8').trim();
      const errText = Buffer.concat(errs).toString('utf8').trim();
      let j = null;
      try { j = JSON.parse(outText); } catch { /* handled below */ }
      if (!j) return reject(fail(502, `Claude Code 没给出结果（退出码 ${code}）：${(errText || outText).slice(0, 400)}`));
      if (j.is_error) return reject(fail(502, `Claude Code 报错：${String(j.result || errText).slice(0, 400)}`));
      const parsed = j.structured_output && typeof j.structured_output === 'object' ? j.structured_output : extractJson(j.result);
      resolve({ parsed, text: String(j.result || ''), usage: { cost_usd: j.total_cost_usd ?? null, session_id: j.session_id ?? null } });
    });
    child.stdin.on('error', () => { /* ignore if the child exits early */ });
    child.stdin.end(input);
  });
}

function askClaude(rules, user) {
  return runClaude({
    prompt: '审查标准输入里给出的 git 改动，按要求的格式给出结果。',
    system: rules.join('\n'),
    input: user,
    schema: REVIEW_SCHEMA,
  });
}

async function askOpenAI(rules, user) {
  const system = [...rules, '只输出一个 JSON 对象，不要输出别的文字。格式：{"summary":"…","focusAreas":[{"title":"…","why":"…","findings":[{"file":"…","line":0,"side":"additions","severity":"中","title":"…","detail":"…","suggestion":"…"}]}]}'].join('\n');
  return askOpenAIJson(system, user);
}

// Streamed: Node's fetch gives up after five minutes without response headers or between body
// chunks, and a thinking model can take longer than that before its answer starts.
async function askOpenAIJson(system, user) {
  let text = '';
  let usage = null;
  const take = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    text += j.choices?.[0]?.delta?.content ?? '';
    if (j.usage) usage = j.usage;
  };
  try {
    const r = await fetch(`${MODEL_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.2,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!r.ok) throw fail(502, `模型回了 HTTP ${r.status}：${(await r.text()).slice(0, 300)}`);
    if (!(r.headers.get('content-type') || '').includes('text/event-stream')) {
      // A service that ignores "stream" answers with one JSON body.
      const j = await r.json();
      text = j.choices?.[0]?.message?.content ?? '';
      usage = j.usage || null;
    } else {
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        lines.forEach(take);
      }
      take(buf + decoder.decode());
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw fail(502, e.name === 'TimeoutError' ? '模型 15 分钟还没答完，停了' : `没能从模型服务拿到回答（${e.cause?.code || e.message}）`);
  }
  return { parsed: extractJson(text), text, usage };
}

async function review(body) {
  const root = await resolveRepo(body.path);
  const { mode, base, head } = readMode(body);
  if (mode === 'refs') { await verifyRef(root, base); await verifyRef(root, head); }
  const status = await modelStatus();
  if (!status.reachable) throw fail(503, `模型没接通：${status.error}（${status.url}）`);
  if (!status.hasModel) throw fail(503, `模型服务里没有 ${MODEL}，现有：${(status.models || []).join('、') || '一个也没有'}`);

  const changes = await listChanges(root, mode, base, head);
  let candidates = changes.files;
  if (Array.isArray(body.files) && body.files.length) {
    const want = new Set(body.files);
    candidates = candidates.filter((f) => want.has(f.path));
  } else {
    candidates = [...candidates].sort((a, b) => {
      const ca = CODE_EXT.has(path.extname(a.path)) ? 0 : 1;
      const cb = CODE_EXT.has(path.extname(b.path)) ? 0 : 1;
      return ca - cb || ((a.add || 0) + (a.del || 0)) - ((b.add || 0) + (b.del || 0));
    });
  }

  const included = [];
  const skipped = [];
  const parts = [];
  let used = 0;
  let scanned = 0;
  for (const f of candidates) {
    const skip = (why) => skipped.push({ path: f.path, why });
    if (f.binary) { skip('二进制文件'); continue; }
    if (LOCKFILES.has(path.basename(f.path))) { skip('依赖锁文件'); continue; }
    if (f.status === 'D') { skip('整个文件被删掉'); continue; }
    if (used >= BUDGET * 0.95 || scanned >= MAX_SCAN) { skip('超出这次的审查量'); continue; }
    scanned++;
    const p = await getPatch(root, mode, base, head, f.path, f.oldPath, f.untracked);
    if (p.tooLarge || p.patch.length > BUDGET * 0.5) { skip('改动太大，要单独审'); continue; }
    if (used + p.patch.length > BUDGET) { skip('超出这次的审查量'); continue; }
    used += p.patch.length;
    included.push(f.path);
    parts.push(p.patch);
  }
  if (!included.length) throw fail(400, '没有能审的文本改动');

  const rules = [
    '你是一名严格、务实的代码审查员。只根据给出的改动说话，看不到的代码不要猜。',
    '找真正值得改的问题：会出错的、不安全的、性能差的、和周围写法不一致的。不要挑空格和措辞。',
    '用中文写。summary 用一两句话总结这次改动；问题按关注点分组放进 focusAreas，每条写清文件、行号、严重程度（高、中、低）、问题、原因、怎么改。',
    'file 必须是改动里出现的文件路径。行号写改动后文件里的行号，side 写 additions；说的是被删掉的代码时，写改动前的行号，side 写 deletions。没有问题就让 focusAreas 为空数组。',
  ];
  const user = `下面是 ${included.length} 个文件的改动（git diff 格式）：\n\n${parts.join('\n')}`;

  const started = Date.now();
  const out = ENGINE === 'claude' ? await askClaude(rules, user) : await askOpenAI(rules, user);
  const parsed = out.parsed;
  const text = out.text;

  const inChange = new Set(included);
  const focusAreas = (parsed?.focusAreas || []).map((a) => ({
    title: str(a?.title) || '没写名字的关注点',
    why: str(a?.why),
    findings: (Array.isArray(a?.findings) ? a.findings : []).map((f) => ({
      file: str(f?.file),
      line: Number.isInteger(f?.line) && f.line >= 0 ? f.line : 0,
      side: f?.side === 'deletions' ? 'deletions' : 'additions',
      severity: SEVERITY.has(str(f?.severity)) ? str(f.severity) : '未标',
      title: str(f?.title),
      detail: str(f?.detail),
      suggestion: str(f?.suggestion),
      inChange: inChange.has(str(f?.file)),
    })).filter((f) => f.title),
  }));

  const runRecord = {
    id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`,
    at: new Date().toISOString(),
    root, mode, base, head,
    engine: ENGINE,
    model: ENGINE === 'claude' ? status.model : MODEL,
    modelUrl: ENGINE === 'claude' ? CLAUDE_BIN : MODEL_URL,
    seconds: Math.round((Date.now() - started) / 1000),
    usage: out.usage || null,
    included, skipped,
    summary: str(parsed?.summary),
    focusAreas,
    parsed: Boolean(parsed),
    raw: parsed ? undefined : text.slice(0, 20000),
  };
  await mkdir(RUNS, { recursive: true });
  await writeFile(path.join(RUNS, `${runRecord.id}.json`), JSON.stringify(runRecord, null, 2));
  return runRecord;
}

async function listRuns(p) {
  const root = await resolveRepo(p);
  let names = [];
  try { names = (await readdir(RUNS)).filter((n) => n.endsWith('.json')).sort().reverse().slice(0, 50); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const r = JSON.parse(await readFile(path.join(RUNS, n), 'utf8'));
      if (r.root !== root) continue;
      out.push({ id: r.id, at: r.at, mode: r.mode, base: r.base, head: r.head, model: r.model, files: r.included.length, findings: r.focusAreas.reduce((s, a) => s + a.findings.length, 0) });
    } catch { /* skip unreadable files */ }
  }
  return out;
}

async function getRun(id) {
  if (!/^[\w-]+$/.test(id || '')) throw fail(400, '编号不对');
  try { return JSON.parse(await readFile(path.join(RUNS, `${id}.json`), 'utf8')); }
  catch { throw fail(404, '找不到这次审查'); }
}

// ---------- Work chain ----------
// One record per repository under data/work/: each finding's assignee, fix and recheck events.
const WORK = path.join(HERE, 'data', 'work');
const repoKey = (root) => crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
const workFile = (root) => path.join(WORK, `${repoKey(root)}.json`);
const findingKey = (f) => `${f.file}|${f.side}|${f.line}|${f.title}`;
const ASSIGNEES = { claude: 'Claude（自动去改）', agent: '别的 AI（复制过去）', self: '我自己' };
const BUSY = new Set(['处理中', '复查中']);
const running = new Set(); // `${root}|${id}` of jobs running in this process

async function loadWork(root) {
  try { return JSON.parse(await readFile(workFile(root), 'utf8')); }
  catch { return { root, next: 1, items: [] }; }
}

// Serialize read-modify-write per repository.
const workLocks = new Map();
function withWork(root, fn) {
  const prev = workLocks.get(root) || Promise.resolve();
  const next = prev.then(async () => {
    const w = await loadWork(root);
    const out = await fn(w);
    await mkdir(WORK, { recursive: true });
    await writeFile(workFile(root), JSON.stringify(w, null, 2));
    return out;
  });
  workLocks.set(root, next.catch(() => {}));
  return next;
}

function addEvent(item, who, what, detail) {
  item.events.push({ at: new Date().toISOString(), who, what, ...(detail ? { detail } : {}) });
}
function findItem(w, id) {
  const it = w.items.find((x) => x.id === id);
  if (!it) throw fail(404, `没有这个工单：${id}`);
  return it;
}

async function workList(p) {
  const root = await resolveRepo(p);
  return withWork(root, (w) => {
    // A busy item with no running job was cut off by a restart.
    for (const it of w.items) {
      if (BUSY.has(it.status) && !running.has(`${root}|${it.id}`)) {
        addEvent(it, '代码镜子', `${it.status}的时候服务停过，这一步断了`);
        it.status = '中断了';
      }
    }
    return { items: w.items };
  });
}

async function workFromRun(body) {
  const root = await resolveRepo(body.path);
  const run = await getRun(body.runId);
  if (run.root !== root) throw fail(400, '这次审查不是这个仓库的');
  const want = Array.isArray(body.keys) && body.keys.length ? new Set(body.keys) : null;
  return withWork(root, (w) => {
    const have = new Map(w.items.map((x) => [x.key, x.id]));
    const ids = [];
    for (const a of run.focusAreas) {
      for (const f of a.findings) {
        const key = findingKey(f);
        if (want && !want.has(key)) continue;
        if (have.has(key)) { ids.push(have.get(key)); continue; }
        const item = {
          id: `W${w.next++}`, key, area: a.title, finding: f,
          run: { id: run.id, at: run.at, mode: run.mode, base: run.base, head: run.head, model: run.model },
          status: '待分配', assignee: null, events: [],
        };
        addEvent(item, `审查（${run.model}）`, '发现问题', `${f.severity} · ${f.file}${f.line ? `:${f.line}` : ''} · ${f.title}`);
        w.items.push(item);
        have.set(key, item.id);
        ids.push(item.id);
      }
    }
    return { ids, items: w.items };
  });
}

async function workAssign(id, body) {
  const root = await resolveRepo(body.path);
  const to = body.to;
  if (!ASSIGNEES[to]) throw fail(400, '分配给谁不对');
  if (to === 'claude' && ENGINE !== 'claude') throw fail(400, '现在审查用的不是 Claude Code，没法交给它自动去改');
  const item = await withWork(root, (w) => {
    const it = findItem(w, id);
    if (BUSY.has(it.status)) throw fail(409, `${id} 正在${it.status}，等它完了再分配`);
    it.assignee = to;
    it.status = to === 'claude' ? '处理中' : '已分配';
    addEvent(it, '你', `分配给 ${ASSIGNEES[to]}`, str(body.note) || undefined);
    return it;
  });
  if (to === 'claude') background(root, id, () => runFix(root, id));
  return item;
}

async function workDone(id, body, what) {
  const root = await resolveRepo(body.path);
  const item = await withWork(root, (w) => {
    const it = findItem(w, id);
    if (BUSY.has(it.status)) throw fail(409, `${id} 正在${it.status}，等它完了再说`);
    it.status = '复查中';
    addEvent(it, '你', what, str(body.note) || undefined);
    return it;
  });
  background(root, id, () => runRecheck(root, id));
  return item;
}

async function workClose(id, body) {
  const root = await resolveRepo(body.path);
  return withWork(root, (w) => {
    const it = findItem(w, id);
    if (BUSY.has(it.status)) throw fail(409, `${id} 正在${it.status}，等它完了再关`);
    it.status = '已关闭';
    addEvent(it, '你', '关掉了', str(body.note) || undefined);
    return it;
  });
}

// Runs a job without blocking the request; a failure is recorded on the item.
function background(root, id, job) {
  const k = `${root}|${id}`;
  running.add(k);
  job()
    .catch(async (e) => {
      await withWork(root, (w) => {
        const it = findItem(w, id);
        it.status = '出错了';
        addEvent(it, '代码镜子', '出错了', String(e?.message || e).slice(0, 500));
      }).catch(() => {});
    })
    .finally(() => running.delete(k));
}

async function fileHash(root, file) {
  try { return crypto.createHash('sha1').update(await readFile(path.join(root, file))).digest('hex'); }
  catch { return 'missing'; }
}

function insideRepo(root, file) {
  const p = path.normalize(path.join(root, file));
  if (!file || !p.startsWith(root + path.sep)) throw new Error(`文件不在仓库里：${file}`);
  return p;
}

// Has Claude Code fix one finding: read/edit tools only, no shell, no commits.
async function runFix(root, id) {
  const item = await withWork(root, (w) => structuredClone(findItem(w, id)));
  const f = item.finding;
  insideRepo(root, f.file);
  const before = await fileHash(root, f.file);
  const prompt = [
    '请在这个仓库里修一个代码审查发现的问题。只改和这个问题有关的地方，不要改别的文件，不要提交。',
    `文件：${f.file}${f.line ? `（第 ${f.line} 行附近）` : ''}`,
    `问题：${f.title}`,
    f.detail ? `原因：${f.detail}` : '',
    f.suggestion ? `建议：${f.suggestion}` : '',
    '改完用一两句中文说你改了什么；如果你认为不该改，就不改，并说明原因。',
  ].filter(Boolean).join('\n');
  const out = await runClaude({ prompt, cwd: root, tools: 'Read,Edit,Glob,Grep', permissionMode: 'acceptEdits', persist: true });
  const changed = before !== (await fileHash(root, f.file));
  await withWork(root, (w) => {
    const it = findItem(w, id);
    it.fixSession = out.usage?.session_id || null;
    addEvent(it, 'Claude（自动去改）', changed ? '改完了' : '没有改这个文件',
      [out.text.trim().slice(0, 1500), it.fixSession ? `会话编号：${it.fixSession}` : ''].filter(Boolean).join('\n'));
    it.status = changed ? '复查中' : '没改动';
  });
  if (changed) await runRecheck(root, id);
}

const RECHECK_SCHEMA = {
  type: 'object',
  properties: { fixed: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['fixed', 'reason'],
};

// Asks the reviewer whether the finding still applies to the file's current content.
async function runRecheck(root, id) {
  const item = await withWork(root, (w) => structuredClone(findItem(w, id)));
  const f = item.finding;
  insideRepo(root, f.file);
  let content;
  try {
    const text = await readFile(path.join(root, f.file), 'utf8');
    // Numbered so the reviewer's reason cites the right lines.
    content = text.replace(/\n$/, '').split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
  } catch { content = '（这个文件现在不存在了）'; }
  if (content.length > 150000) content = `${content.slice(0, 150000)}\n……（后面太长，截掉了）`;
  const input = [
    '之前审查发现的问题：',
    `文件：${f.file}${f.line ? `，当时在第 ${f.line} 行附近` : ''}`,
    `问题：${f.title}`,
    f.detail ? `原因：${f.detail}` : '',
    '',
    '这个文件现在的全部内容（每行开头是行号）：',
    content,
  ].join('\n');
  const system = '你是严格的代码复查员。只根据给出的文件内容判断那个问题还在不在，看不到的不要猜。原因用中文写一两句话。';
  let parsed;
  if (ENGINE === 'claude') {
    parsed = (await runClaude({ prompt: '判断标准输入里说的那个问题，在文件现在的内容里还在不在，按格式回答。', system, input, schema: RECHECK_SCHEMA })).parsed;
  } else {
    parsed = (await askOpenAIJson(`${system}\n只输出一个 JSON 对象：{"fixed":true 或 false,"reason":"…"}`, input)).parsed;
  }
  const fixed = typeof parsed?.fixed === 'boolean' ? parsed.fixed : null;
  await withWork(root, (w) => {
    const it = findItem(w, id);
    const who = `复查（${ENGINE === 'claude' ? 'Claude' : MODEL}）`;
    if (fixed === null) { it.status = '出错了'; addEvent(it, who, '复查没给出结论'); return; }
    it.status = fixed ? '已解决' : '复查没过';
    addEvent(it, who, fixed ? '复查通过，问题没了' : '复查没过，问题还在', str(parsed.reason));
  });
}

// ---------- HTTP ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png',
};

async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST + path.sep)) return sendText(res, 403, '不允许');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    return res.end(data);
  } catch {
    if (!path.extname(rel)) {
      try {
        const data = await readFile(path.join(DIST, 'index.html'));
        res.writeHead(200, { 'Content-Type': TYPES['.html'] });
        return res.end(data);
      } catch { return sendText(res, 500, '网页还没打包：先在这个文件夹里运行 npm run build'); }
    }
    return sendText(res, 404, '没有这个文件');
  }
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw fail(413, '请求太大');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw fail(400, '请求不是 JSON'); }
}

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedHosts.has(req.headers.host || '')) return sendText(res, 403, '只允许本机访问');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = Object.fromEntries(url.searchParams);
    const p = url.pathname;
    if (!p.startsWith('/api/')) return serveStatic(res, p);

    if (req.method === 'GET' && p === '/api/config') return sendJson(res, 200, { defaultRepo: DEFAULT_REPO, engine: ENGINE, model: ENGINE === 'claude' ? 'Claude Code' : MODEL, budget: BUDGET });
    if (req.method === 'GET' && p === '/api/model') return sendJson(res, 200, await modelStatus());
    if (req.method === 'GET' && p === '/api/repo') return sendJson(res, 200, await repoInfo(q.path));
    if (req.method === 'GET' && p === '/api/changes') {
      const root = await resolveRepo(q.path);
      const { mode, base, head } = readMode(q);
      if (mode === 'refs') { await verifyRef(root, base); await verifyRef(root, head); }
      return sendJson(res, 200, await listChanges(root, mode, base, head));
    }
    if (req.method === 'GET' && p === '/api/patch') {
      const root = await resolveRepo(q.path);
      const { mode, base, head } = readMode(q);
      if (mode === 'refs') { await verifyRef(root, base); await verifyRef(root, head); }
      return sendJson(res, 200, await getPatch(root, mode, base, head, q.file, q.old, q.untracked === '1'));
    }
    if (req.method === 'POST' && p === '/api/review') return sendJson(res, 200, await review(await readBody(req)));
    if (req.method === 'GET' && p === '/api/work') return sendJson(res, 200, await workList(q.path));
    if (req.method === 'POST' && p === '/api/work/from-run') return sendJson(res, 200, await workFromRun(await readBody(req)));
    const wm = /^\/api\/work\/(W\d+)\/(assign|done|recheck|close)$/.exec(p);
    if (req.method === 'POST' && wm) {
      const body = await readBody(req);
      if (wm[2] === 'assign') return sendJson(res, 200, await workAssign(wm[1], body));
      if (wm[2] === 'done') return sendJson(res, 200, await workDone(wm[1], body, '说改好了，交给复查'));
      if (wm[2] === 'recheck') return sendJson(res, 200, await workDone(wm[1], body, '要求再复查一次'));
      return sendJson(res, 200, await workClose(wm[1], body));
    }
    if (req.method === 'GET' && p === '/api/runs') return sendJson(res, 200, await listRuns(q.path));
    if (req.method === 'GET' && p.startsWith('/api/runs/')) return sendJson(res, 200, await getRun(p.slice('/api/runs/'.length)));
    return sendJson(res, 404, { error: '没有这个接口' });
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 500;
    if (code === 500) console.error(e);
    return sendJson(res, code, { error: e.message || '出错了' });
  }
});
server.requestTimeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`代码镜子已启动：http://${HOST}:${PORT}`);
  console.log(ENGINE === 'claude'
    ? `审查用：Claude Code 命令行（${CLAUDE_BIN}，${CLAUDE_MODEL || '账号默认的模型'}）`
    : `审查用：${MODEL}（${MODEL_URL}）`);
});
