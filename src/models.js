// 桌面端对话界面右下角「模型选择器」伪装模块
// 包含 deepseek-flash、gpt-6.1-sol、claude-sonnet-5-5 等多模型选择，营造逼真的 AI 客户端体验。
import { t } from './i18n.js';

export const MODELS = [
  { id: 'deepseek-flash', label: 'deepseek-flash', dot: '#3b82f6' },
  { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol', dot: '#10b981' },
  { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5', dot: '#d97757' },
];

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function resolveModel(id) {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === DEFAULT_MODEL) || MODELS[0];
}

export function createModelPicker({ btnEl, popEl, initialModel, onSelect }) {
  let current = resolveModel(initialModel).id;

  function render() {
    const m = resolveModel(current);
    if (btnEl) {
      btnEl.title = t('composer.modelTitle');
      btnEl.innerHTML = `<i class="model-dot" style="background:${m.dot}"></i><span>${m.label}</span><svg class="model-chev" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5L6 7.5L9 4.5"/></svg>`;
    }
    if (popEl) {
      popEl.innerHTML = `
        <div class="model-pop-head">${t('composer.modelMenuTitle')}</div>
        <div class="model-list">
          ${MODELS.map((item) => {
            const active = item.id === current;
            const desc = t(`model.${item.id}.desc`);
            return `<button type="button" class="model-opt${active ? ' active' : ''}" data-model="${item.id}">
              <i class="model-dot" style="background:${item.dot}"></i>
              <span class="model-opt-main">
                <b>${item.label}</b>
                <small>${desc}</small>
              </span>
              <span class="model-check">${active ? '✓' : ''}</span>
            </button>`;
          }).join('')}
        </div>`;
    }
  }

  if (popEl) {
    popEl.addEventListener('click', (e) => {
      const opt = e.target.closest('.model-opt');
      if (!opt) return;
      const picked = resolveModel(opt.dataset.model);
      current = picked.id;
      render();
      popEl.hidden = true;
      onSelect?.(picked.id);
    });
  }

  render();

  return {
    get value() { return current; },
    set(id) { current = resolveModel(id).id; render(); },
    render,
  };
}
