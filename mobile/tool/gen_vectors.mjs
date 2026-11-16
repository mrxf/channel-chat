// 用桌面端的 crypto.js 生成交叉验证向量：node mobile/tool/gen_vectors.mjs > mobile/test/vectors.json
import { deriveSession, seal, sealChunk } from '../../src/crypto.js';
const out = [];
for (const pass of ['abcd-efgh-jkmn-pqrs', '测试口令１２３', 'pass word']) {
  const s = await deriveSession(pass);
  const chunk = new Uint8Array(1000).map((_, i) => i & 255);
  out.push({
    pass, key: Buffer.from(s.key).toString('hex'), roomId: s.roomId, fingerprint: s.fingerprint,
    sealed: seal(s, { t: 'msg', id: '0123456789abcdef', text: '你好 hello', ts: 1 }),
    chunk: Buffer.from(sealChunk(s, '0011223344556677', 3, 9, chunk)).toString('base64'),
  });
}
console.log(JSON.stringify(out, null, 1));
