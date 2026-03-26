const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const http = require('http');

const BASE = '/tmp/fsbrowse-test-' + Date.now();
let server, port;

function assert(label, condition) {
  if (!condition) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`PASS: ${label}`);
}

async function req(method, urlPath, opts = {}) {
  const url = `http://localhost:${port}/files${urlPath}`;
  const res = await fetch(url, { method, ...opts });
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
}

function multipart(fields, files) {
  const boundary = '----Boundary' + Math.random().toString(36).slice(2);
  let parts = [];
  for (const [name, val] of Object.entries(fields || {})) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}`);
  }
  for (const [name, { filename, content }] of Object.entries(files || {})) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}`);
  }
  parts.push(`--${boundary}--`);
  return {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: parts.join('\r\n'),
  };
}

async function setup() {
  await fsp.mkdir(BASE, { recursive: true });
  await fsp.mkdir(path.join(BASE, 'subdir'), { recursive: true });
  await fsp.writeFile(path.join(BASE, 'hello.txt'), 'Hello World');
  await fsp.writeFile(path.join(BASE, 'data.json'), '{"key":"value"}');
  await fsp.writeFile(path.join(BASE, 'code.js'), 'console.log("hi")');
  await fsp.writeFile(path.join(BASE, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fsp.writeFile(path.join(BASE, 'subdir', 'nested.txt'), 'nested content');
  try { await fsp.unlink(path.join(BASE, 'link.txt')); } catch {}
  await fsp.symlink(path.join(BASE, 'hello.txt'), path.join(BASE, 'link.txt'));

  delete require.cache[require.resolve('./index.js')];
  const fsbrowse = require('./index.js');
  const app = express();
  app.use('/files', fsbrowse({ baseDir: BASE }));
  return new Promise(resolve => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
}

async function cleanup() {
  server?.close();
  await fsp.rm(BASE, { recursive: true, force: true });
}

async function testSanitizePath() {
  const { sanitizePath, makeResolver } = (() => {
    function sanitizePath(p) { return path.normalize(p).replace(/^(\.\.(\/|\\|$))+/, ''); }
    function makeResolver(baseDir) {
      return function(relPath) {
        const sanitized = sanitizePath(relPath);
        const fullPath = path.resolve(baseDir, sanitized);
        if (!fullPath.startsWith(baseDir)) return { ok: false, error: 'EPATHINJECTION' };
        return { ok: true, path: fullPath };
      };
    }
    return { sanitizePath, makeResolver };
  })();

  const resolve = makeResolver(BASE);

  assert('sanitize: normal path resolves', resolve('hello.txt').ok);
  assert('sanitize: subdir resolves', resolve('subdir/nested.txt').ok);
  assert('sanitize: dot-slash resolves', resolve('./hello.txt').ok);
  assert('sanitize: ../ stays in base', resolve('../etc/passwd').ok && resolve('../etc/passwd').path.startsWith(BASE));
  assert('sanitize: ../../ stays in base', resolve('../../etc/passwd').ok && resolve('../../etc/passwd').path.startsWith(BASE));
  assert('sanitize: ..\\ stays in base', resolve('..\\etc\\passwd').ok && resolve('..\\etc\\passwd').path.startsWith(BASE));
  assert('sanitize: ./../ stays in base', resolve('./../etc/passwd').ok && resolve('./../etc/passwd').path.startsWith(BASE));
  assert('sanitize: empty string resolves to base', resolve('').ok && resolve('').path === BASE);
}

async function testApiList() {
  const { status, body } = await req('GET', '/api/list/./');
  assert('list: root ok', body.ok === true);
  assert('list: root is dir', body.value.type === 'dir');
  assert('list: has children', body.value.children.length > 0);

  const names = body.value.children.map(c => c.name);
  assert('list: contains hello.txt', names.includes('hello.txt'));
  assert('list: contains subdir', names.includes('subdir'));

  const dirIdx = body.value.children.findIndex(c => c.name === 'subdir');
  const fileIdx = body.value.children.findIndex(c => c.name === 'hello.txt');
  assert('list: dirs sorted before files', dirIdx < fileIdx);

  const hello = body.value.children.find(c => c.name === 'hello.txt');
  assert('list: file has size', hello.size === 11);
  assert('list: file has type', hello.type === 'text');
  assert('list: file has permissions', Array.isArray(hello.permissions));
  assert('list: file has timestamps', hello.time && hello.time.modified);

  const link = body.value.children.find(c => c.name === 'link.txt');
  assert('list: symlink detected', link?.type === 'symlink');

  const sub = await req('GET', '/api/list/subdir');
  assert('list: subdir ok', sub.body.ok === true);
  assert('list: subdir has nested.txt', sub.body.value.children.some(c => c.name === 'nested.txt'));

  const single = await req('GET', '/api/list/hello.txt');
  assert('list: single file returns info', single.body.ok && single.body.value.name === 'hello.txt');

  const missing = await req('GET', '/api/list/nonexistent');
  assert('list: 404 for missing', missing.status === 404);

  const traversal = await req('GET', '/api/list/../etc/passwd');
  assert('list: traversal blocked', traversal.status === 400 || traversal.status === 404);
}

async function testApiUpload() {
  const mp = multipart({}, { files: { filename: 'uploaded.txt', content: 'upload test content' } });
  const { body } = await req('POST', '/api/upload?path=./', mp);
  assert('upload: success', body.ok === true);
  assert('upload: file exists on disk', fs.existsSync(path.join(BASE, 'uploaded.txt')));
  assert('upload: content correct', fs.readFileSync(path.join(BASE, 'uploaded.txt'), 'utf-8') === 'upload test content');

  const missing = multipart({}, { files: { filename: 'x.txt', content: 'x' } });
  const misRes = await req('POST', '/api/upload?path=nonexistent', missing);
  assert('upload: 404 for missing dir', misRes.status === 404);

  const trav = multipart({}, { files: { filename: '../escape.txt', content: 'bad' } });
  await req('POST', '/api/upload?path=subdir', trav);
  assert('upload: traversal filename sanitized', !fs.existsSync(path.join(BASE, 'escape.txt')));
}

async function testApiDownload() {
  const { body, headers } = await req('GET', '/api/download/hello.txt');
  assert('download: returns content', body.includes('Hello World'));

  const dir = await req('GET', '/api/download/subdir');
  assert('download: rejects directory', dir.status === 400);

  const missing = await req('GET', '/api/download/nonexistent.txt');
  assert('download: 404 for missing', missing.status === 404);

  const trav = await req('GET', '/api/download/../etc/passwd');
  assert('download: traversal blocked', trav.status === 400 || trav.status === 404);
}

async function testApiView() {
  const { body } = await req('GET', '/api/view/hello.txt');
  assert('view: returns content', body.ok && body.value === 'Hello World');
  assert('view: has size', body.size === 11);

  const json = await req('GET', '/api/view/data.json');
  assert('view: json content', json.body.ok && json.body.value.includes('"key"'));

  const binary = await req('GET', '/api/view/image.png');
  assert('view: binary detected', binary.body.ok && binary.body.value.includes('[Binary file'));

  const dir = await req('GET', '/api/view/subdir');
  assert('view: rejects directory', dir.status === 400);

  const missing = await req('GET', '/api/view/nonexistent.txt');
  assert('view: 404 for missing', missing.status === 404);

  const bigFile = path.join(BASE, 'big.bin');
  await fsp.writeFile(bigFile, Buffer.alloc(6 * 1024 * 1024));
  const big = await req('GET', '/api/view/big.bin');
  assert('view: rejects >5MB', big.status === 413);
  await fsp.unlink(bigFile);
}

async function testApiDelete() {
  await fsp.writeFile(path.join(BASE, 'todelete.txt'), 'bye');
  const { body } = await req('DELETE', '/api/file/todelete.txt');
  assert('delete: success', body.ok === true);
  assert('delete: file removed', !fs.existsSync(path.join(BASE, 'todelete.txt')));

  await fsp.mkdir(path.join(BASE, 'deldir', 'child'), { recursive: true });
  await fsp.writeFile(path.join(BASE, 'deldir', 'child', 'f.txt'), 'x');
  const dirDel = await req('DELETE', '/api/file/deldir');
  assert('delete: recursive dir', dirDel.body.ok && !fs.existsSync(path.join(BASE, 'deldir')));

  const missing = await req('DELETE', '/api/file/nonexistent');
  assert('delete: 404 for missing', missing.status === 404);

  const trav = await req('DELETE', '/api/file/../../../tmp/important');
  assert('delete: traversal blocked', trav.status === 400 || trav.status === 404);
}

async function testApiRename() {
  await fsp.writeFile(path.join(BASE, 'torename.txt'), 'rename me');
  const mp = multipart({ path: 'torename.txt', name: 'renamed.txt' });
  const { body } = await req('POST', '/api/rename', mp);
  assert('rename: success', body.ok === true);
  assert('rename: old gone', !fs.existsSync(path.join(BASE, 'torename.txt')));
  assert('rename: new exists', fs.existsSync(path.join(BASE, 'renamed.txt')));

  await fsp.writeFile(path.join(BASE, 'dup1.txt'), 'a');
  await fsp.writeFile(path.join(BASE, 'dup2.txt'), 'b');
  const dupMp = multipart({ path: 'dup1.txt', name: 'dup2.txt' });
  const dup = await req('POST', '/api/rename', dupMp);
  assert('rename: EEXIST on duplicate', dup.body.error === 'EEXIST');

  const emptyMp = multipart({});
  const empty = await req('POST', '/api/rename', emptyMp);
  assert('rename: MISSING_FIELDS', empty.body.error === 'MISSING_FIELDS');
}

async function testApiMove() {
  await fsp.writeFile(path.join(BASE, 'tomove.txt'), 'move me');
  const mp = multipart({ source: 'tomove.txt', destination: 'subdir' });
  const { body } = await req('POST', '/api/move', mp);
  assert('move: success', body.ok === true);
  assert('move: src gone', !fs.existsSync(path.join(BASE, 'tomove.txt')));
  assert('move: dest exists', fs.existsSync(path.join(BASE, 'subdir', 'tomove.txt')));

  const missMp = multipart({ source: 'nope.txt', destination: 'subdir' });
  const miss = await req('POST', '/api/move', missMp);
  assert('move: SOURCE_NOT_FOUND', miss.body.error === 'SOURCE_NOT_FOUND');

  const emptyMp = multipart({});
  const empty = await req('POST', '/api/move', emptyMp);
  assert('move: MISSING_FIELDS', empty.body.error === 'MISSING_FIELDS');
}

async function testApiMkdir() {
  const mp = multipart({ path: 'newdir' });
  const { body } = await req('POST', '/api/mkdir', mp);
  assert('mkdir: success', body.ok === true);
  assert('mkdir: dir exists', fs.existsSync(path.join(BASE, 'newdir')));

  const dupMp = multipart({ path: 'newdir' });
  const dup = await req('POST', '/api/mkdir', dupMp);
  assert('mkdir: EEXIST on duplicate', dup.body.error === 'EEXIST');

  const nestedMp = multipart({ path: 'deep/nested/dir' });
  const nested = await req('POST', '/api/mkdir', nestedMp);
  assert('mkdir: nested creation', nested.body.ok && fs.existsSync(path.join(BASE, 'deep', 'nested', 'dir')));

  const emptyMp = multipart({});
  const empty = await req('POST', '/api/mkdir', emptyMp);
  assert('mkdir: MISSING_FIELDS', empty.body.error === 'MISSING_FIELDS');
}

async function testHtmlInjection() {
  delete require.cache[require.resolve('./index.js')];
  const fsbrowse = require('./index.js');
  const app = express();
  app.use('/xss', fsbrowse({ baseDir: BASE, name: '<img onerror=alert(1)>', themeKeys: "x';alert(2);//" }));
  const xssServer = app.listen(0);
  const xssPort = xssServer.address().port;

  const res = await fetch(`http://localhost:${xssPort}/xss/`);
  const html = await res.text();

  assert('html: name escaped in title', html.includes('&lt;img onerror=alert(1)&gt;'));
  assert('html: no raw script tag from name', !html.includes('<img onerror=alert(1)>'));
  assert('html: themeKeys does not break JS string', !html.includes("x';alert(2)"));

  const tkMatch = html.match(/window\.THEME_KEYS='([^']*)'/);
  assert('html: THEME_KEYS is valid JS string', !!tkMatch);

  xssServer.close();
}

async function testCliParseArgs() {
  const src = fs.readFileSync(path.join(__dirname, 'bin.js'), 'utf-8');
  const fnBody = src.match(/function parseArgs\(argv\) \{[\s\S]*?^}/m)[0];
  const parseArgs = new Function('return ' + fnBody)();

  assert('cli: -p maps to port', parseArgs(['-p', '8080']).port === '8080');
  assert('cli: --port maps to port', parseArgs(['--port', '9090']).port === '9090');
  assert('cli: -d maps to dir', parseArgs(['-d', '/data']).dir === '/data');
  assert('cli: --dir maps to dir', parseArgs(['--dir', '/data']).dir === '/data');
  assert('cli: -h maps to hostname', parseArgs(['-h', '0.0.0.0']).hostname === '0.0.0.0');
  assert('cli: -b maps to basepath', parseArgs(['-b', '/app']).basepath === '/app');
  assert('cli: multiple args', (() => {
    const a = parseArgs(['-p', '80', '-d', '/x']);
    return a.port === '80' && a.dir === '/x';
  })());
  assert('cli: non-flag args skipped', Object.keys(parseArgs(['foo', 'bar'])).length === 0);
}

async function testFileTypeDetection() {
  const { body } = await req('GET', '/api/list/./');
  const children = body.value.children;

  const typeOf = name => children.find(c => c.name === name)?.type;
  assert('filetype: .txt is text', typeOf('hello.txt') === 'text');
  assert('filetype: .json is text', typeOf('data.json') === 'text');
  assert('filetype: .js is code', typeOf('code.js') === 'code');
  assert('filetype: .png is image', typeOf('image.png') === 'image');
  assert('filetype: subdir is dir', typeOf('subdir') === 'dir');
  assert('filetype: symlink detected', typeOf('link.txt') === 'symlink');
}

async function testBasepathHandling() {
  delete require.cache[require.resolve('./index.js')];
  const fsbrowse = require('./index.js');

  const app1 = express();
  app1.use('/custom/path', fsbrowse({ baseDir: BASE }));
  const s1 = app1.listen(0);
  const p1 = s1.address().port;

  const res = await fetch(`http://localhost:${p1}/custom/path/`);
  const html = await res.text();
  assert('basepath: BASEPATH injected', html.includes("window.BASEPATH='/custom/path'"));
  assert('basepath: style.css path rewritten', html.includes('href="/custom/path/style.css"'));
  assert('basepath: app.js path rewritten', html.includes('src="/custom/path/app.js"'));

  const api = await fetch(`http://localhost:${p1}/custom/path/api/list/./`);
  const data = await api.json();
  assert('basepath: API works at custom path', data.ok === true);

  s1.close();
}

async function testResponseFormat() {
  const ok = await req('GET', '/api/list/./');
  assert('format: success has ok=true', ok.body.ok === true);
  assert('format: success has value', 'value' in ok.body);

  const err = await req('GET', '/api/list/nonexistent');
  assert('format: error has ok=false', err.body.ok === false);
  assert('format: error has error field', 'error' in err.body);
}

(async () => {
  try {
    await setup();
    await testSanitizePath();
    await testApiList();
    await testApiUpload();
    await testApiDownload();
    await testApiView();
    await testApiDelete();
    await testApiRename();
    await testApiMove();
    await testApiMkdir();
    await testHtmlInjection();
    await testCliParseArgs();
    await testFileTypeDetection();
    await testBasepathHandling();
    await testResponseFormat();
  } catch (e) {
    console.error('FATAL:', e);
    process.exitCode = 1;
  } finally {
    await cleanup();
    console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
  }
})();
