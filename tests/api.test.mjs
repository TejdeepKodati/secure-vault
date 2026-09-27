/**
 * End-to-end tests. Zero dependencies: node:test + fetch against real server
 * processes, each on a random port with its own throwaway DATA_DIR.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN = '482915';
const tempDirs = [];
const running = [];

/* ------------------------------------------------------------- harness --- */

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const newDataDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vault-test-'));
  tempDirs.push(dir);
  return dir;
};

/** Explicit values for everything a stray .env could otherwise influence. */
const baseEnv = (extra) => ({
  ...process.env,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  JWT_SECRET: '',
  INITIAL_PIN: PIN,
  TRUST_PROXY: 'false',
  TRUST_PROXY_HOPS: '1',
  MAX_UPLOAD_BYTES: String(1024 * 1024 * 1024),
  LOGIN_MAX_ATTEMPTS: '5',
  LOGIN_WINDOW_SECONDS: '900',
  LOGIN_LOCKOUT_SECONDS: '300',
  LOGIN_GLOBAL_MAX_ATTEMPTS: '500',
  ALLOW_REINIT: '',
  LOG_LEVEL: 'error',
  ...extra,
});

async function startServer(extraEnv = {}, dataDir) {
  const dir = dataDir ?? (await newDataDir());
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: baseEnv({ DATA_DIR: dir, PORT: String(port), ...extraEnv }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  running.push(child);

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${output}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    base,
    dir,
    output: () => output,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
}

/** Run a server that is expected to refuse to start; resolves with exit code + output. */
function runExpectingExit(extraEnv, dataDir) {
  return new Promise(async (resolve) => {
    const dir = dataDir ?? (await newDataDir());
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: baseEnv({ DATA_DIR: dir, PORT: String(await freePort()), ...extraEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    running.push(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Tiny cookie-holding client. */
function client(base) {
  let cookie = '';
  const api = async (method, url, body, { headers = {}, csrf = true } = {}) => {
    const init = { method, headers: { ...headers } };
    if (csrf) init.headers['X-Requested-With'] = 'SecureVault';
    if (cookie) init.headers.Cookie = cookie;
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(base + url, init);
  };
  return {
    api,
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      cookie = value;
    },
    async login(pin = PIN) {
      const res = await api('POST', '/api/login', { pin });
      const set = res.headers.get('set-cookie');
      if (res.ok && set) cookie = set.split(';')[0];
      return res;
    },
  };
}

const json = (res) => res.json();
const upload = (c, dest, files) => {
  const form = new FormData();
  for (const [rel, content] of files) {
    if (rel.includes('/')) form.append('relativePath', rel);
    form.append('file', new Blob([content]), rel.split(/[/\\]/).pop());
  }
  return c.api('POST', `/api/upload?path=${encodeURIComponent(dest)}`, form);
};

after(async () => {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------- main behaviour --- */

describe('vault API', () => {
  let server;
  let c;
  before(async () => {
    server = await startServer();
    c = client(server.base);
  });
  after(() => server.stop());

  it('serves a public health check and security headers', async () => {
    const res = await fetch(`${server.base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { ok: true });
    const page = await fetch(`${server.base}/`);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  });

  it('rejects unauthenticated access', async () => {
    assert.equal((await c.api('GET', '/api/files')).status, 401);
    assert.equal((await json(await c.api('GET', '/api/session'))).authenticated, false);
  });

  it('enforces the CSRF header and same-origin Origin', async () => {
    const noHeader = await c.api('POST', '/api/login', { pin: PIN }, { csrf: false });
    assert.equal(noHeader.status, 403);
    const evil = await c.api('POST', '/api/login', { pin: PIN }, { headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
  });

  it('rejects a wrong PIN and accepts the right one with a hardened cookie', async () => {
    assert.equal((await c.login('000000')).status, 401);
    const res = await c.login();
    assert.equal(res.status, 200);
    const set = res.headers.get('set-cookie');
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    assert.equal((await json(await c.api('GET', '/api/session'))).authenticated, true);
  });

  it('creates folders and validates names', async () => {
    assert.equal((await c.api('POST', '/api/folder', { path: '', name: 'Docs' })).status, 201);
    assert.equal((await c.api('POST', '/api/folder', { path: '', name: 'Docs' })).status, 409);
    for (const bad of ['../evil', 'a/b', 'CON', '.hidden', 'trailing.', 'bad:name']) {
      assert.equal((await c.api('POST', '/api/folder', { path: '', name: bad })).status, 400, bad);
    }
  });

  it('uploads files, keeps folder hierarchy, never overwrites', async () => {
    let res = await upload(c, '', [['hello.txt', 'hello world']]);
    assert.equal(res.status, 201);
    res = await upload(c, '', [['hello.txt', 'second']]);
    assert.equal((await json(res)).uploaded[0].name, 'hello (1).txt');
    res = await upload(c, '', [['photos/2024/a.txt', 'A']]);
    assert.equal((await json(res)).uploaded[0].path, 'photos/2024/a.txt');
    res = await upload(c, '', [['..\\..\\evil.txt', 'e']]);
    assert.equal(res.status, 201);
    assert.ok(!(await json(res)).uploaded[0].path.includes('..'));
    assert.equal((await upload(c, 'nope', [['n.txt', 'n']])).status, 404);
    assert.equal((await upload(c, '../', [['n.txt', 'n']])).status, 403);
  });

  it('downloads as an attachment and supports byte ranges', async () => {
    const dl = await c.api('GET', '/api/download?path=hello.txt');
    assert.equal(await dl.text(), 'hello world');
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    assert.match(dl.headers.get('content-disposition'), /attachment/);

    const part = await c.api('GET', '/api/preview?path=hello.txt', undefined, { headers: { Range: 'bytes=0-4' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'hello');
    const bad = await c.api('GET', '/api/preview?path=hello.txt', undefined, { headers: { Range: 'bytes=999-' } });
    assert.equal(bad.status, 416);
    await bad.text();
  });

  it('never lets stored HTML or SVG run in the vault origin', async () => {
    await upload(c, '', [['x.html', '<script>alert(1)</script>'], ['x.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>']]);
    const html = await c.api('GET', '/api/preview?path=x.html');
    assert.match(html.headers.get('content-type'), /^text\/plain/);
    assert.match(html.headers.get('content-security-policy'), /sandbox/);
    await html.text();
    const svg = await c.api('GET', '/api/preview?path=x.svg');
    assert.match(svg.headers.get('content-security-policy'), /sandbox/);
    await svg.text();
  });

  it('blocks path traversal on API and static routes, and hides server data', async () => {
    for (const probe of ['../../../etc/passwd', '%2e%2e/%2e%2e/etc/passwd', '..\\..\\secret']) {
      const res = await c.api('GET', `/api/download?path=${encodeURIComponent(probe)}`);
      assert.notEqual(res.status, 200, probe);
      await res.text();
    }
    const staticEscape = await fetch(`${server.base}/%2e%2e/server.js`);
    assert.ok(!(await staticEscape.text()).includes('createServer'));
    assert.equal((await fetch(`${server.base}/data/user.json`)).status, 404);
  });

  it('reports recursive info for folders', async () => {
    const info = await json(await c.api('GET', '/api/info?path=photos'));
    assert.equal(info.fileCount, 1);
    assert.equal(info.folderCount, 1);
  });

  it('renames and moves without clobbering or cycles', async () => {
    assert.equal((await c.api('POST', '/api/rename', { path: 'hello (1).txt', newName: 'renamed.txt' })).status, 200);
    assert.equal((await c.api('POST', '/api/rename', { path: 'renamed.txt', newName: 'hello.txt' })).status, 409);
    assert.equal((await c.api('POST', '/api/move', { paths: ['renamed.txt'], destination: 'Docs' })).status, 200);
    assert.equal((await c.api('POST', '/api/move', { paths: ['Docs'], destination: 'Docs' })).status, 400);
    assert.equal((await c.api('POST', '/api/move', { paths: ['photos'], destination: 'photos/2024' })).status, 400);
  });

  it('round-trips the recycle bin', async () => {
    const del = await json(await c.api('DELETE', '/api/delete', { paths: ['Docs/renamed.txt', 'photos'] }));
    assert.equal(del.trashed.length, 2);
    const ids = del.trashed.map((entry) => entry.id);
    assert.equal((await json(await c.api('GET', '/api/trash'))).entries.length, 2);
    assert.equal((await c.api('POST', '/api/trash/restore', { ids: [ids[0]] })).status, 200);
    assert.equal((await c.api('POST', '/api/trash/restore', { ids: ['../../x'] })).status, 400);
    assert.equal((await json(await c.api('DELETE', '/api/empty-trash'))).removed, 1);
    assert.equal((await c.api('DELETE', '/api/delete', { paths: [''] })).status, 400);
  });

  it('does not leak absolute server paths in errors', async () => {
    const bodies = [];
    for (const url of ['/api/files?path=nope', '/api/info?path=nope', '/api/download?path=nope/x', '/api/preview?path=']) {
      bodies.push(await (await c.api('GET', url)).text());
    }
    assert.ok(!bodies.some((text) => text.includes(server.dir) || /\/(tmp|home|mnt|var)\//.test(text)));
  });

  it('keeps the bare SRS paths working as aliases', async () => {
    assert.equal((await c.api('GET', '/files')).status, 200);
  });

  it('changes the PIN, enforces policy, and retires other sessions', async () => {
    assert.equal((await c.api('POST', '/api/change-pin', { currentPin: 'wrong1', newPin: '739184' })).status, 400);
    assert.equal((await c.api('POST', '/api/change-pin', { currentPin: PIN, newPin: '1111' })).status, 400);
    const oldCookie = c.cookie;
    const res = await c.api('POST', '/api/change-pin', { currentPin: PIN, newPin: '739184' });
    assert.equal(res.status, 200);
    c.cookie = res.headers.get('set-cookie').split(';')[0];
    const stale = await fetch(`${server.base}/api/files`, { headers: { Cookie: oldCookie } });
    assert.equal(stale.status, 401);
    assert.equal((await c.api('GET', '/api/files')).status, 200);
  });

  it('logs out', async () => {
    await c.api('POST', '/api/logout');
    const res = await fetch(`${server.base}/api/files`, { headers: { Cookie: 'sv_session=' } });
    assert.equal(res.status, 401);
  });
});

/* -------------------------------------------------------------- limits --- */

describe('upload limits', () => {
  let server;
  let c;
  before(async () => {
    server = await startServer({ MAX_UPLOAD_BYTES: '1000' });
    c = client(server.base);
  });
  after(() => server.stop());

  it('answers 413 and leaves no partial file behind', async () => {
    await c.login();
    const big = await upload(c, '', [['big.bin', 'A'.repeat(5000)]]);
    assert.equal(big.status, 413);
    assert.equal((await upload(c, '', [['ok.bin', 'A'.repeat(500)]])).status, 201);
    const names = (await json(await c.api('GET', '/api/files'))).entries.map((entry) => entry.name);
    assert.deepEqual(names, ['ok.bin']);
  });
});

/* ------------------------------------------------------------ throttle --- */

describe('login throttling', () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(() => server.stop());

  it('locks out after the configured number of failures, with Retry-After', async () => {
    const c = client(server.base);
    const statuses = [];
    let last;
    for (let i = 0; i < 7; i += 1) {
      last = await c.login(`00000${i}`);
      statuses.push(last.status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429, 429]);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    // Even the right PIN is refused while locked out.
    assert.equal((await c.login()).status, 429);
  });
});

describe('login throttling under concurrency', () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(() => server.stop());

  it('cannot be bypassed by a burst of simultaneous guesses', async () => {
    const c = client(server.base);
    const burst = await Promise.all(Array.from({ length: 120 }, (_, i) => c.login(String(100000 + i)).then((r) => r.status)));
    const evaluated = burst.filter((status) => status === 401).length;
    assert.ok(evaluated <= 5, `expected at most 5 guesses to be evaluated, got ${evaluated}`);
    assert.ok(burst.filter((status) => status === 429).length >= 115);
  });
});

describe('PIN change throttling', () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(() => server.stop());

  it('counts wrong current-PIN guesses against the same budget', async () => {
    const c = client(server.base);
    assert.equal((await c.login()).status, 200);
    const statuses = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await c.api('POST', '/api/change-pin', { currentPin: `11111${i}`, newPin: '739184' })).status);
    }
    assert.deepEqual(statuses, [400, 400, 400, 400, 429, 429, 429]);
  });
});

describe('proxy handling', () => {
  let trusted;
  let untrusted;
  before(async () => {
    trusted = await startServer({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '1' });
    untrusted = await startServer({ TRUST_PROXY: 'false' });
  });
  after(async () => {
    await trusted.stop();
    await untrusted.stop();
  });

  const attempt = (base, forwarded, pin) =>
    fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SecureVault', 'X-Forwarded-For': forwarded },
      body: JSON.stringify({ pin }),
    }).then((res) => res.status);

  it('ignores a forged left-hand X-Forwarded-For entry behind one proxy', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i += 1) statuses.push(await attempt(trusted.base, `10.9.9.${i}, 203.0.113.7`, '000001'));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429, 429]);
  });

  it('still tells genuinely different clients apart', async () => {
    assert.equal(await attempt(trusted.base, '198.51.100.9', '000001'), 401);
  });

  it('ignores X-Forwarded-For entirely when TRUST_PROXY is off', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push(await attempt(untrusted.base, `10.9.9.${i}`, '000001'));
    assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429]);
  });
});

/* ------------------------------------------------- startup and recovery --- */

describe('startup guarantees', () => {
  it('a restart never resets an existing PIN, even with a different INITIAL_PIN', async () => {
    const dir = await newDataDir();
    let server = await startServer({ INITIAL_PIN: PIN }, dir);
    await server.stop();
    server = await startServer({ INITIAL_PIN: '111222' }, dir);
    const c = client(server.base);
    assert.equal((await c.login('111222')).status, 401);
    assert.equal((await c.login(PIN)).status, 200);
    await server.stop();
  });

  it('refuses to invent a new PIN when the vault has files but no user record', async () => {
    const dir = await newDataDir();
    const server = await startServer({}, dir);
    const c = client(server.base);
    await c.login();
    await upload(c, '', [['keep.txt', 'precious']]);
    await server.stop();
    await rm(path.join(dir, 'user.json'));

    const refused = await runExpectingExit({}, dir);
    assert.notEqual(refused.code, 0);
    assert.match(refused.output, /ALLOW_REINIT/);

    // The documented escape hatch works, and the files survive it.
    const recovered = await startServer({ ALLOW_REINIT: 'true', INITIAL_PIN: '555666' }, dir);
    const c2 = client(recovered.base);
    assert.equal((await c2.login('555666')).status, 200);
    assert.deepEqual((await json(await c2.api('GET', '/api/files'))).entries.map((e) => e.name), ['keep.txt']);
    await recovered.stop();
  });

  it('production refuses to start without JWT_SECRET', async () => {
    const result = await runExpectingExit({ NODE_ENV: 'production' });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /JWT_SECRET/);
  });

  it('production sets a Secure cookie and HSTS', async () => {
    const server = await startServer({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(48) });
    const c = client(server.base);
    const res = await c.login();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /; Secure/);
    assert.match(res.headers.get('strict-transport-security'), /max-age=/);
    await server.stop();
  });

  it('rejects a too-short JWT_SECRET', async () => {
    const result = await runExpectingExit({ JWT_SECRET: 'short' });
    assert.notEqual(result.code, 0);
  });
});
