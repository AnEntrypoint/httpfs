const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const BASE = '/tmp/fsbrowse-final-' + Date.now();
let server, port;
const u = p => `http://localhost:${port}/files${p}`;

function assert(label, condition) {
  if (!condition) { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`PASS: ${label}`);
}

function mkmp(fields, files) {
  const b = '----B' + Math.random().toString(36).slice(2);
  let parts = [];
  for (const [n, v] of Object.entries(fields || {})) parts.push(`--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}`);
  for (const [n, { filename, content }] of Object.entries(files || {})) parts.push(`--${b}\r\nContent-Disposition: form-data; name="${n}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}`);
  parts.push(`--${b}--`);
  return { headers: { 'Content-Type': `multipart/form-data; boundary=${b}` }, body: parts.join('\r\n') };
}

async function setup() {
  await fsp.mkdir(path.join(BASE, 'dir_b'), { recursive: true });
  await fsp.mkdir(path.join(BASE, 'dir_a'), { recursive: true });
  await fsp.mkdir(path.join(BASE, 'sub'), { recursive: true });
  await fsp.mkdir(path.join(BASE, 'dest'), { recursive: true });
  await fsp.mkdir(path.join(BASE, 'movedir', 'child'), { recursive: true });
  await fsp.writeFile(path.join(BASE, 'file_c.txt'), 'c');
  await fsp.writeFile(path.join(BASE, 'file_a.txt'), 'a');
  await fsp.writeFile(path.join(BASE, 'file_b.txt'), 'b');
  await fsp.writeFile(path.join(BASE, 'spaces in name.txt'), 'spaces');
  await fsp.writeFile(path.join(BASE, '日本語.txt'), 'unicode content');
  await fsp.writeFile(path.join(BASE, 'parens (1).txt'), 'parens');
  await fsp.writeFile(path.join(BASE, 'sub', 'victim.txt'), 'sensitive');
  await fsp.writeFile(path.join(BASE, 'movedir', 'child', 'deep.txt'), 'deep');
  await fsp.writeFile(path.join(BASE, 'exact5mb.bin'), Buffer.alloc(5 * 1024 * 1024, 0x41));
  await fsp.writeFile(path.join(BASE, 'over5mb.bin'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x41));

  delete require.cache[require.resolve('./index.js')];
  const fsbrowse = require('./index.js');
  const app = express();
  app.use('/files', fsbrowse({ baseDir: BASE }));
  return new Promise(resolve => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
}

async function testRenameTraversalFix() {
  const r = await (await fetch(u('/api/rename'), { method: 'POST', ...mkmp({ path: 'sub/victim.txt', name: '../../escaped.txt' }) })).json();
  assert('rename-trav: no escape to parent', !fs.existsSync(path.join(BASE, '..', 'escaped.txt')));
  assert('rename-trav: basename used, stays in subdir', fs.existsSync(path.join(BASE, 'sub', 'escaped.txt')));
  assert('rename-trav: return path correct', r.value === 'sub/escaped.txt');

  await fsp.writeFile(path.join(BASE, 'dottest.txt'), 'x');
  const dot = await (await fetch(u('/api/rename'), { method: 'POST', ...mkmp({ path: 'dottest.txt', name: '..' }) })).json();
  assert('rename-trav: dotdot rejected', dot.error === 'INVALID_NAME');

  const dot2 = await (await fetch(u('/api/rename'), { method: 'POST', ...mkmp({ path: 'dottest.txt', name: '.' }) })).json();
  assert('rename-trav: dot rejected', dot2.error === 'INVALID_NAME');
}

async function testSortAlphaWithinType() {
  const r = await (await fetch(u('/api/list/./'))).json();
  const dirs = r.value.children.filter(c => c.type === 'dir').map(c => c.name);
  const files = r.value.children.filter(c => c.type !== 'dir').map(c => c.name);
  assert('sort: dirs alphabetical', JSON.stringify(dirs) === JSON.stringify([...dirs].sort()));
  assert('sort: files alphabetical', JSON.stringify(files) === JSON.stringify([...files].sort()));
  assert('sort: dirs come first', r.value.children.findIndex(c => c.type === 'dir') < r.value.children.findIndex(c => c.type !== 'dir'));
}

async function testSpecialFilenames() {
  const r = await (await fetch(u('/api/list/./'))).json();
  assert('special: spaces listed', r.value.children.some(c => c.name === 'spaces in name.txt'));
  assert('special: unicode listed', r.value.children.some(c => c.name === '日本語.txt'));
  assert('special: parens listed', r.value.children.some(c => c.name === 'parens (1).txt'));

  const dl = await fetch(u('/api/download/' + encodeURIComponent('spaces in name.txt')));
  assert('special: download spaces 200', dl.status === 200);

  const vw = await (await fetch(u('/api/view/' + encodeURIComponent('日本語.txt')))).json();
  assert('special: view unicode ok', vw.ok && vw.value === 'unicode content');

  const vwP = await (await fetch(u('/api/view/' + encodeURIComponent('parens (1).txt')))).json();
  assert('special: view parens ok', vwP.ok && vwP.value === 'parens');
}

async function testMultiFileUpload() {
  const b = '----MF' + Date.now();
  const body = `--${b}\r\nContent-Disposition: form-data; name="files"; filename="multi1.txt"\r\nContent-Type: text/plain\r\n\r\none\r\n--${b}\r\nContent-Disposition: form-data; name="files"; filename="multi2.txt"\r\nContent-Type: text/plain\r\n\r\ntwo\r\n--${b}--`;
  const r = await (await fetch(u('/api/upload?path=./'), { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${b}` }, body })).json();
  assert('multi-upload: ok', r.ok);
  assert('multi-upload: file1 exists', fs.existsSync(path.join(BASE, 'multi1.txt')));
  assert('multi-upload: file2 exists', fs.existsSync(path.join(BASE, 'multi2.txt')));
  assert('multi-upload: file1 content', fs.readFileSync(path.join(BASE, 'multi1.txt'), 'utf-8') === 'one');
  assert('multi-upload: file2 content', fs.readFileSync(path.join(BASE, 'multi2.txt'), 'utf-8') === 'two');
}

async function testUploadDefaultPath() {
  const r = await (await fetch(u('/api/upload'), { method: 'POST', ...mkmp({}, { files: { filename: 'nopath.txt', content: 'default' } }) })).json();
  assert('upload-default: ok', r.ok);
  assert('upload-default: in root', fs.existsSync(path.join(BASE, 'nopath.txt')));
}

async function testReturnValues() {
  await fsp.writeFile(path.join(BASE, 'fordel.txt'), 'x');
  const del = await (await fetch(u('/api/file/fordel.txt'), { method: 'DELETE' })).json();
  assert('retval: delete value', del.value === 'fordel.txt');

  await fsp.writeFile(path.join(BASE, 'forren.txt'), 'x');
  const ren = await (await fetch(u('/api/rename'), { method: 'POST', ...mkmp({ path: 'forren.txt', name: 'renval.txt' }) })).json();
  assert('retval: rename value', ren.value === 'renval.txt');

  await fsp.writeFile(path.join(BASE, 'formov.txt'), 'x');
  const mov = await (await fetch(u('/api/move'), { method: 'POST', ...mkmp({ source: 'formov.txt', destination: 'sub' }) })).json();
  assert('retval: move value', mov.value === path.join('sub', 'formov.txt'));

  const mkd = await (await fetch(u('/api/mkdir'), { method: 'POST', ...mkmp({ path: 'retdir' }) })).json();
  assert('retval: mkdir value', mkd.value.startsWith(BASE) && mkd.value.endsWith('retdir'));
}

async function testView5mbBoundary() {
  const exact = await fetch(u('/api/view/exact5mb.bin'));
  assert('5mb: exact 5MB allowed', exact.status === 200);

  const over = await fetch(u('/api/view/over5mb.bin'));
  assert('5mb: 5MB+1 rejected 413', over.status === 413);
}

async function testRenameMoveDirectories() {
  const ren = await (await fetch(u('/api/rename'), { method: 'POST', ...mkmp({ path: 'dir_a', name: 'dir_renamed' }) })).json();
  assert('dir-rename: ok', ren.ok);
  assert('dir-rename: new exists', fs.existsSync(path.join(BASE, 'dir_renamed')));
  assert('dir-rename: old gone', !fs.existsSync(path.join(BASE, 'dir_a')));

  const mov = await (await fetch(u('/api/move'), { method: 'POST', ...mkmp({ source: 'movedir', destination: 'dest' }) })).json();
  assert('dir-move: ok', mov.ok);
  assert('dir-move: deep file preserved', fs.existsSync(path.join(BASE, 'dest', 'movedir', 'child', 'deep.txt')));
  assert('dir-move: src gone', !fs.existsSync(path.join(BASE, 'movedir')));
}

async function testMoveInvalidPath() {
  await fsp.writeFile(path.join(BASE, 'movsrc.txt'), 'x');
  const r = await (await fetch(u('/api/move'), { method: 'POST', ...mkmp({ source: 'movsrc.txt', destination: 'nonexistent' }) })).json();
  assert('move-inv: DEST_DIR_NOT_FOUND', r.error === 'DEST_DIR_NOT_FOUND');
}

async function testFactoryNullOpts() {
  delete require.cache[require.resolve('./index.js')];
  const fsbrowse = require('./index.js');
  let ok = true;
  try { fsbrowse(null); } catch { ok = false; }
  assert('factory: null no crash', ok);
  try { fsbrowse(undefined); } catch { ok = false; }
  assert('factory: undefined no crash', ok);
  try { fsbrowse(); } catch { ok = false; }
  assert('factory: no args no crash', ok);
}

async function testConcurrentRequests() {
  const results = await Promise.all(Array(10).fill().map(() => fetch(u('/api/list/./')).then(r => r.json())));
  assert('concurrent: all 10 ok', results.every(r => r.ok));
  assert('concurrent: all have children', results.every(r => Array.isArray(r.value.children)));

  await fsp.writeFile(path.join(BASE, 'conc1.txt'), '');
  await fsp.writeFile(path.join(BASE, 'conc2.txt'), '');
  await fsp.writeFile(path.join(BASE, 'conc3.txt'), '');
  const delResults = await Promise.all(['conc1.txt', 'conc2.txt', 'conc3.txt'].map(f => fetch(u(`/api/file/${f}`), { method: 'DELETE' }).then(r => r.json())));
  assert('concurrent: parallel deletes ok', delResults.every(r => r.ok));
}

(async () => {
  try {
    await setup();
    await testRenameTraversalFix();
    await testSortAlphaWithinType();
    await testSpecialFilenames();
    await testMultiFileUpload();
    await testUploadDefaultPath();
    await testReturnValues();
    await testView5mbBoundary();
    await testRenameMoveDirectories();
    await testMoveInvalidPath();
    await testFactoryNullOpts();
    await testConcurrentRequests();
  } catch (e) {
    console.error('FATAL:', e);
    process.exitCode = 1;
  } finally {
    server?.close();
    await fsp.rm(BASE, { recursive: true, force: true }).catch(() => {});
    console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
  }
})();
