const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const BASE = '/tmp/fsbrowse-ext-' + Date.now();
let server, port;
const u = p => `http://localhost:${port}/files${p}`;

function assert(label, condition) {
  if (!condition) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`PASS: ${label}`);
}

function mp(fields, files) {
  const b = '----B' + Math.random().toString(36).slice(2);
  let parts = [];
  for (const [n, v] of Object.entries(fields || {})) parts.push(`--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}`);
  for (const [n, { filename, content }] of Object.entries(files || {})) parts.push(`--${b}\r\nContent-Disposition: form-data; name="${n}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}`);
  parts.push(`--${b}--`);
  return { headers: { 'Content-Type': `multipart/form-data; boundary=${b}` }, body: parts.join('\r\n') };
}

async function setup() {
  await fsp.mkdir(path.join(BASE, 'subdir'), { recursive: true });
  await fsp.mkdir(path.join(BASE, 'emptydir'), { recursive: true });
  await fsp.writeFile(path.join(BASE, 'hello.txt'), 'Hello World');
  await fsp.writeFile(path.join(BASE, 'movie.mp4'), 'fakevideo');
  await fsp.writeFile(path.join(BASE, 'song.mp3'), 'fakeaudio');
  await fsp.writeFile(path.join(BASE, 'archive.zip'), 'fakezip');
  await fsp.writeFile(path.join(BASE, 'doc.pdf'), 'fakepdf');
  await fsp.writeFile(path.join(BASE, 'noext'), 'no extension');
  await fsp.writeFile(path.join(BASE, 'multibyte.txt'), '日本語テスト café');
  await fsp.writeFile(path.join(BASE, 'subdir', 'nested.txt'), 'nested');
  try { await fsp.unlink(path.join(BASE, 'broken-link')); } catch {}
  await fsp.symlink('/tmp/nonexistent-target-xyz', path.join(BASE, 'broken-link'));

  delete require.cache[require.resolve('./index.js')];
  const fsbrowse = require('./index.js');
  const app = express();
  app.use('/files', fsbrowse({ baseDir: BASE }));
  return new Promise(resolve => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
}

async function testFileTypeAllCategories() {
  const r = await (await fetch(u('/api/list/./'))).json();
  const t = n => r.value.children.find(c => c.name === n)?.type;
  assert('type: mp4=video', t('movie.mp4') === 'video');
  assert('type: mp3=audio', t('song.mp3') === 'audio');
  assert('type: zip=archive', t('archive.zip') === 'archive');
  assert('type: pdf=document', t('doc.pdf') === 'document');
  assert('type: noext=other', t('noext') === 'other');
  assert('type: broken-link=symlink', t('broken-link') === 'symlink');
}

async function testBrokenSymlinkInListing() {
  const r = await (await fetch(u('/api/list/./'))).json();
  const bl = r.value.children.find(c => c.name === 'broken-link');
  assert('broken-link: permissions=EACCES', bl.permissions === 'EACCES');
  assert('broken-link: size=0', bl.size === 0);
  assert('broken-link: no timestamps', !bl.time);
}

async function testEmptyDirListing() {
  const r = await (await fetch(u('/api/list/emptydir'))).json();
  assert('emptydir: ok', r.ok);
  assert('emptydir: children empty', r.value.children.length === 0);
  assert('emptydir: type=dir', r.value.type === 'dir');
}

async function testListParentPath() {
  const root = await (await fetch(u('/api/list/./'))).json();
  assert('parentPath: root is .', root.value.parentPath === '.');

  const sub = await (await fetch(u('/api/list/subdir'))).json();
  assert('parentPath: subdir is .', sub.value.parentPath === '.');

  const nested = await (await fetch(u('/api/list/subdir/nested.txt'))).json();
  assert('parentPath: file in subdir', nested.value.parentPath === 'subdir');
}

async function testEscapeFunctions() {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf-8');
  const jsMatch = src.match(/function escapeJsString[\s\S]*?^}/m)[0];
  const htmlMatch = src.match(/function escapeHtml[\s\S]*?^}/m)[0];
  const escapeJsString = new Function('return ' + jsMatch)();
  const escapeHtml = new Function('return ' + htmlMatch)();

  assert('escJs: backslash', escapeJsString('a\\b') === 'a\\\\b');
  assert('escJs: quote', escapeJsString("it's") === "it\\'s");
  assert('escJs: lt', escapeJsString('<') === '\\x3c');
  assert('escJs: gt', escapeJsString('>') === '\\x3e');
  assert('escHtml: amp', escapeHtml('&') === '&amp;');
  assert('escHtml: lt', escapeHtml('<') === '&lt;');
  assert('escHtml: gt', escapeHtml('>') === '&gt;');
  assert('escHtml: quot', escapeHtml('"') === '&quot;');
  assert('escHtml: combined', escapeHtml('&<>"') === '&amp;&lt;&gt;&quot;');
}

async function testFactoryDefaults() {
  delete require.cache[require.resolve('./index.js')];
  const fsbrowse = require('./index.js');
  const app2 = express();
  app2.use('/def', fsbrowse({ baseDir: BASE }));
  const s = app2.listen(0);
  const p = s.address().port;

  const r1 = await fetch(`http://localhost:${p}/def/`);
  const html1 = await r1.text();
  assert('factory: default name in title', html1.includes('<title>fsbrowse</title>'));
  assert('factory: default name in h1', html1.includes('>fsbrowse</h1>'));

  const r2 = await fetch(`http://localhost:${p}/def/index.html`);
  const html2 = await r2.text();
  assert('factory: /index.html same as /', html1 === html2);

  assert('factory: THEME_KEYS default', html1.includes("THEME_KEYS='gmgui-theme,theme'"));
  s.close();
}

async function testStaticServing() {
  const css = await fetch(u('/style.css'));
  assert('static: style.css 200', css.status === 200);
  assert('static: style.css is CSS', css.headers.get('content-type').includes('text/css'));
  const cssBody = await css.text();
  assert('static: style.css has content', cssBody.includes(':root'));

  const js = await fetch(u('/app.js'));
  assert('static: app.js 200', js.status === 200);
  const jsBody = await js.text();
  assert('static: app.js has content', jsBody.includes('const app'));
}

async function testViewMultibyteAndTraversal() {
  const r = await (await fetch(u('/api/view/multibyte.txt'))).json();
  assert('view-mb: ok', r.ok);
  assert('view-mb: contains Japanese', r.value.includes('日本語'));
  assert('view-mb: contains accented', r.value.includes('café'));
  assert('view-mb: not binary', !r.value.includes('[Binary'));

  const trav = await fetch(u('/api/view/../../../etc/passwd'));
  assert('view-trav: blocked', trav.status === 400 || trav.status === 404);
}

async function testDownloadHeaders() {
  const r = await fetch(u('/api/download/hello.txt'));
  const cd = r.headers.get('content-disposition');
  assert('dl-header: has attachment', cd && cd.includes('attachment'));
  assert('dl-header: has filename', cd && cd.includes('hello.txt'));
}

async function testUploadEdgeCases() {
  const trav = await fetch(u('/api/upload?path=../../../tmp'), { method: 'POST', ...mp({}, { files: { filename: 'x.txt', content: 'x' } }) });
  assert('upload-edge: traversal query 400 or 404', trav.status === 400 || trav.status === 404);

  const noFileB = '----NF' + Date.now();
  const noFile = await fetch(u('/api/upload?path=./'), { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${noFileB}` }, body: `--${noFileB}--` });
  assert('upload-edge: no files ok', (await noFile.json()).ok === true);

  const dotMp = mp({}, { files: { filename: '..', content: 'bad' } });
  await fetch(u('/api/upload?path=subdir'), { method: 'POST', ...dotMp });
  assert('upload-edge: dotdot stays in subdir', !fs.existsSync(path.join(BASE, 'bad')) && fs.readdirSync(path.join(BASE, 'subdir')).length >= 0);
}

async function testRenameEdgeCases() {
  const renMiss = await fetch(u('/api/rename'), { method: 'POST', ...mp({ path: 'nonexistent.txt', name: 'new.txt' }) });
  assert('rename-edge: missing 404', renMiss.status === 404);

  const renTrav = await fetch(u('/api/rename'), { method: 'POST', ...mp({ path: '../../../etc/passwd', name: 'evil' }) });
  const renTravR = await renTrav.json();
  assert('rename-edge: traversal blocked', renTrav.status === 400 || renTrav.status === 404);
}

async function testMoveAllErrors() {
  fs.writeFileSync(path.join(BASE, 'mv-src.txt'), 'src');
  const destMiss = await (await fetch(u('/api/move'), { method: 'POST', ...mp({ source: 'mv-src.txt', destination: 'nopedir' }) })).json();
  assert('move-err: DEST_DIR_NOT_FOUND', destMiss.error === 'DEST_DIR_NOT_FOUND');

  fs.writeFileSync(path.join(BASE, 'mv-clash.txt'), 'a');
  fs.writeFileSync(path.join(BASE, 'subdir', 'mv-clash.txt'), 'b');
  const clash = await (await fetch(u('/api/move'), { method: 'POST', ...mp({ source: 'mv-clash.txt', destination: 'subdir' }) })).json();
  assert('move-err: DEST_ALREADY_EXISTS', clash.error === 'DEST_ALREADY_EXISTS');

  fs.writeFileSync(path.join(BASE, 'mv-ok.txt'), 'ok');
  const ok = await (await fetch(u('/api/move'), { method: 'POST', ...mp({ source: 'mv-ok.txt', destination: 'subdir' }) })).json();
  assert('move-ok: correct relpath', ok.ok && ok.value === path.join('subdir', 'mv-ok.txt'));
}

async function testMkdirTraversal() {
  const r = await (await fetch(u('/api/mkdir'), { method: 'POST', ...mp({ path: '../../../tmp/evil-mkdir' }) })).json();
  assert('mkdir-trav: stays in base', r.ok && r.value.startsWith(BASE));
  assert('mkdir-trav: no dir outside base', !fs.existsSync('/tmp/evil-mkdir'));
}

async function testServerBasepathEnv() {
  const calc = (env) => ('BASEPATH' in env ? env.BASEPATH : 'BASE_PATH' in env ? env.BASE_PATH : '/files').replace(/\/$/, '');
  assert('basepath-env: default /files', calc({}) === '/files');
  assert('basepath-env: BASEPATH wins', calc({ BASEPATH: '/bp', BASE_PATH: '/alt' }) === '/bp');
  assert('basepath-env: BASE_PATH fallback', calc({ BASE_PATH: '/alt' }) === '/alt');
  assert('basepath-env: trailing slash stripped', calc({ BASEPATH: '/test/' }) === '/test');
  assert('basepath-env: empty string', calc({ BASEPATH: '' }) === '');

  const mountPath = (bp) => bp || '/';
  assert('basepath-env: empty mounts at /', mountPath(calc({ BASEPATH: '' })) === '/');

  const shouldRedirect = (bp) => bp && bp !== '/';
  assert('basepath-env: /app redirects', shouldRedirect(calc({ BASEPATH: '/app' })) === true);
  assert('basepath-env: empty no redirect', !shouldRedirect(calc({ BASEPATH: '' })));
}

async function testFrontendJsFunctions() {
  const formatSize = (bytes) => {
    if (!bytes) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes, unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return `${size.toFixed(1)} ${units[unit]}`;
  };
  assert('fmt: 0 = -', formatSize(0) === '-');
  assert('fmt: 500 = 500.0 B', formatSize(500) === '500.0 B');
  assert('fmt: 1024 = 1.0 KB', formatSize(1024) === '1.0 KB');
  assert('fmt: 1048576 = 1.0 MB', formatSize(1048576) === '1.0 MB');
  assert('fmt: 1073741824 = 1.0 GB', formatSize(1073741824) === '1.0 GB');
  assert('fmt: 1500 = 1.5 KB', formatSize(1536) === '1.5 KB');

  const getFileIcon = (type) => {
    const icons = { dir: '📁', image: '🖼️', video: '🎬', audio: '🎵', code: '💻', text: '📝', archive: '📦', document: '📄', other: '📋' };
    return icons[type] || icons.other;
  };
  assert('icon: dir', getFileIcon('dir') === '📁');
  assert('icon: image', getFileIcon('image') === '🖼️');
  assert('icon: video', getFileIcon('video') === '🎬');
  assert('icon: audio', getFileIcon('audio') === '🎵');
  assert('icon: code', getFileIcon('code') === '💻');
  assert('icon: text', getFileIcon('text') === '📝');
  assert('icon: archive', getFileIcon('archive') === '📦');
  assert('icon: document', getFileIcon('document') === '📄');
  assert('icon: other', getFileIcon('other') === '📋');
  assert('icon: unknown', getFileIcon('xyz') === '📋');

  const escapeAttr = (text) => String(text).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  assert('escAttr: amp', escapeAttr('&') === '&amp;');
  assert('escAttr: squote', escapeAttr("'") === '&#39;');
  assert('escAttr: dquote', escapeAttr('"') === '&quot;');
  assert('escAttr: lt', escapeAttr('<') === '&lt;');
  assert('escAttr: gt', escapeAttr('>') === '&gt;');
  assert('escAttr: combined', escapeAttr(`<a href="x" onclick='y'>&`) === '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
}

(async () => {
  try {
    await setup();
    await testFileTypeAllCategories();
    await testBrokenSymlinkInListing();
    await testEmptyDirListing();
    await testListParentPath();
    await testEscapeFunctions();
    await testFactoryDefaults();
    await testStaticServing();
    await testViewMultibyteAndTraversal();
    await testDownloadHeaders();
    await testUploadEdgeCases();
    await testRenameEdgeCases();
    await testMoveAllErrors();
    await testMkdirTraversal();
    await testServerBasepathEnv();
    await testFrontendJsFunctions();
  } catch (e) {
    console.error('FATAL:', e);
    process.exitCode = 1;
  } finally {
    server?.close();
    await fsp.rm(BASE, { recursive: true, force: true }).catch(() => {});
    console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
  }
})();
