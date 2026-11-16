#!/usr/bin/env node
// 版本号统一来源：package.json（tauri.conf.json 直接引用它），同时同步 Cargo.toml 和 Cargo.lock。
//   node scripts/bump.mjs            → 补丁号 +1（1.2.3 → 1.2.4）
//   node scripts/bump.mjs minor      → 1.2.3 → 1.3.0
//   node scripts/bump.mjs major      → 1.2.3 → 2.0.0
//   node scripts/bump.mjs 2.0.0      → 指定版本
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkgPath = root + 'package.json';
const cargoPath = root + 'src-tauri/Cargo.toml';
const lockPath = root + 'src-tauri/Cargo.lock';

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const arg = process.argv[2] || 'patch';
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!m) throw new Error(`package.json 里的版本号格式不对：${pkg.version}`);
let [maj, min, pat] = m.slice(1).map(Number);

let next;
if (arg === 'patch') next = `${maj}.${min}.${pat + 1}`;
else if (arg === 'minor') next = `${maj}.${min + 1}.0`;
else if (arg === 'major') next = `${maj + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else throw new Error(`用法：bump.mjs [patch|minor|major|x.y.z]，收到 ${arg}`);

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const cargo = readFileSync(cargoPath, 'utf8');
// 只改 [package] 段里的第一个 version
writeFileSync(cargoPath, cargo.replace(/^(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m, `$1"${next}"`));

// Cargo.lock 里本项目那一条也一起改，免得提交后 CI 里又冒出一个改动
const lock = readFileSync(lockPath, 'utf8');
writeFileSync(lockPath, lock.replace(/(\[\[package\]\]\nname = "agent"\nversion = )"[^"]*"/, `$1"${next}"`));

console.log(`版本号：${m[0]} → ${next}`);
