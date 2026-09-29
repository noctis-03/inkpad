#!/usr/bin/env node
/**
 * HandNote — public/index.html 재조립기
 *   build/shell.html  (마크업 + CSS + 설정 블록)
 * + build/app1.js + build/app2.js + build/app3.js
 * = public/index.html
 *
 * 사용:  node tools/build.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const parts = ['build/app1.js', 'build/app2.js', 'build/app3.js'];
const shell = read('build/shell.html');
const js = parts.map(read).join('\n');

const out = shell + '\n<script>\n' + js + '\n</script>\n</body>\n</html>\n';
fs.writeFileSync(path.join(root, 'public/index.html'), out, 'utf8');
fs.writeFileSync(path.join(root, 'build/all.js'), js, 'utf8');

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log('public/index.html  ' + kb(out));
console.log('  inline js        ' + kb(js));
console.log('  shell            ' + kb(shell));
