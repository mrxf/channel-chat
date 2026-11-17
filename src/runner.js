// 伪装用的「后台任务」面板：假装 ChatBuddy 正在执行任务，定时滚动日志、推进进度。
// 任务标题和步骤来自伪装场景（personas.js），可以随时用 setProfile 切换。
import { t } from './i18n.js';

const r = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[r(a.length)];

export function createRunner(root, { profile, open = true, onToggle = () => {} } = {}) {
  let { titles: TITLES, steps: STEPS } = profile;
  root.innerHTML = `
    <div class="runner-head">
      <span class="r-icon"><span class="spin"></span></span>
      <span class="r-state"></span>
      <span class="r-title"></span>
      <span class="spacer"></span>
      <span class="r-meta"></span>
      <span class="r-pct">0%</span>
      <span class="r-chev">⌄</span>
    </div>
    <div class="runner-bar"><i></i></div>
    <div class="r-log"></div>`;
  const $ = (s) => root.querySelector(s);
  const log = $('.r-log');
  let plan = [], idx = 0, started = 0, timer = null, clock = null, done = false;

  root.classList.toggle('open', open);
  $('.runner-head').onclick = () => { root.classList.toggle('open'); onToggle(root.classList.contains('open')); };

  const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const renderState = () => {
    $('.r-state').textContent = done ? t('runner.done') : t('runner.running');
  };
  const meta = () => {
    if (!plan.length) return;
    const step = plan[Math.min(idx, plan.length - 1)].step;
    $('.r-meta').textContent = done
      ? t('runner.completedIn', { time: fmt(Date.now() - started) })
      : `${STEPS[step][0]} · ${step + 1}/${STEPS.length} · ${fmt(Date.now() - started)}`;
  };
  renderState();

  function newTask() {
    done = false; idx = 0; started = Date.now();
    plan = [];
    STEPS.forEach(([, gen], step) => { for (let i = 0, n = r(4) + 2; i < n; i++) plan.push({ step, line: gen() }); });
    root.classList.remove('done');
    renderState();
    $('.r-title').textContent = pick(TITLES);
    $('.runner-bar i').style.width = '0%';
    $('.r-pct').textContent = '0%';
    log.innerHTML = '';
    meta();
    schedule();
  }

  function schedule() {
    const last = plan[idx - 1]?.line || '';
    const wait = last.endsWith('…') ? 3500 + r(5000) : 1000 + r(3500);
    timer = setTimeout(stepOnce, wait);
  }

  function stepOnce() {
    const { line } = plan[idx++];
    const el = document.createElement('div');
    el.className = line.startsWith('$') ? 'cmd' : line.startsWith('✓') || line.startsWith('PASS') ? 'ok' : '';
    el.textContent = line;
    log.appendChild(el);
    while (log.children.length > 40) log.firstChild.remove();
    log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
    const pct = Math.round((idx / plan.length) * 100);
    $('.runner-bar i').style.width = pct + '%';
    $('.r-pct').textContent = pct + '%';
    if (idx >= plan.length) {
      done = true;
      root.classList.add('done');
      renderState();
      meta();
      timer = setTimeout(newTask, 7000 + r(8000));
    } else {
      meta();
      schedule();
    }
  }

  return {
    start() { this.stop(); newTask(); clock = setInterval(() => !done && meta(), 1000); },
    stop() { clearTimeout(timer); clearInterval(clock); },
    setProfile(p) { ({ titles: TITLES, steps: STEPS } = p); },
    refreshLang() { renderState(); meta(); },
  };
}
