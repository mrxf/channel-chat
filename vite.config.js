import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const buildTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

// Tauri 开发约定：固定端口、不清屏、不监听 src-tauri
export default defineConfig({
  clearScreen: false,
  // 版本号和打包时间注入前端，显示在设置里，并在握手时告诉对方
  define: { __APP_VERSION__: JSON.stringify(version), __BUILD_TIME__: JSON.stringify(buildTime) },
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/server/**'] } },
  build: { target: 'safari15', outDir: 'dist', emptyOutDir: true },
});
