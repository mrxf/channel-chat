// Dart 加密 → JS 解密：node tool/check_dart_vectors.mjs <pass> <sealed>
import { deriveSession, open } from '../../src/crypto.js';
const s = await deriveSession(process.argv[2]);
console.log(JSON.stringify(open(s, process.argv[3])));
