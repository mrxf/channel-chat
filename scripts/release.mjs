#!/usr/bin/env node
// 发布新版本：改版本号 → 提交 → 打 tag → 推送。GitHub Actions 看到 v* tag 后自动打包并创建 Release。
//   npm run release            → 补丁号 +1（1.2.3 → 1.2.4）
//   npm run release minor      → 1.2.3 → 1.3.0
//   npm run release 2.0.0      → 指定版本
//   npm run release current    → 不改版本号，直接给当前版本打 tag（比如第一次发布）
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const run = (cmd, a) => execFileSync(cmd, a, { cwd: root, stdio: 'inherit' });
const fail = (msg) => { console.error(`\n  ✗ ${msg}\n`); process.exit(1); };
const version = () => JSON.parse(readFileSync(root + 'package.json', 'utf8')).version;

const arg = process.argv[2] || 'patch';

if (git('status', '--porcelain')) fail('还有没提交的改动，先提交或暂存（git stash）再发布');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') fail(`当前在 ${branch} 分支，请切到 main 再发布`);

if (arg !== 'current') {
  run('node', ['scripts/bump.mjs', arg]);
  run('git', ['add', 'package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'mobile/pubspec.yaml', 'mobile/lib/core/version.dart']);
  run('git', ['commit', '-q', '-m', `release: v${version()}`]);
}

const tag = `v${version()}`;
if (git('tag', '--list', tag)) fail(`tag ${tag} 已经存在。要重新发布同一个版本，先删掉：git tag -d ${tag} && git push origin :refs/tags/${tag}`);
run('git', ['tag', '-a', tag, '-m', tag]);
run('git', ['push', 'origin', 'HEAD', `refs/tags/${tag}`]);

const remote = git('remote', 'get-url', 'origin').replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
console.log(`\n  ✓ 已推送 ${tag}，打包进度：${remote}/actions\n    完成后在这里下载：${remote}/releases/tag/${tag}\n`);
