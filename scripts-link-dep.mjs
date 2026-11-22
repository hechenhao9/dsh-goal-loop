// One-shot: make the profile's dependency record match the junction we install.
// 一次性：把 profile 的依赖记录补成和 junction 一致的形式（link: + 正斜杠）。
// `remove` 作为第四个参数时改为删掉这条记录（卸载用）。
import fs from 'node:fs';

const manifestPath = process.argv[2];
const tree = process.argv[3];
const mode = process.argv[4] ?? 'add';
if (!manifestPath || !tree) throw new Error('usage: node scripts-link-dep.mjs <profile/package.json> <plugin-tree> [remove]');

const raw = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
const manifest = JSON.parse(raw);
const spec = 'link:' + tree.replace(/\\/g, '/');

manifest.dependencies = manifest.dependencies || {};
const before = manifest.dependencies['dsh-goal-loop'];
if (mode === 'remove') delete manifest.dependencies['dsh-goal-loop'];
else manifest.dependencies['dsh-goal-loop'] = spec;

const out = JSON.stringify(manifest, null, 2) + '\n';
fs.writeFileSync(manifestPath, out, 'utf8');

const back = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
console.log('before=' + (before ?? '(none)'));
console.log('after =' + back.dependencies['dsh-goal-loop']);
console.log('deps  =' + Object.keys(back.dependencies).length);
console.log('bundle_last=' + back.dsh.profile.bundles.at(-1));
