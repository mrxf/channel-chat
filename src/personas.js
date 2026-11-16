// 伪装场景：按工种生成不同的假历史记录、后台任务、工具行和老板键对话。
// 每个场景包含：
//   tasks   侧栏 Recents 里的假任务
//   tools   对方消息上方的假工具行（n 为稳定的随机数）
//   runner  顶部假后台任务：titles 标题池，steps [步骤名, 日志生成器]
//   decoy   老板键（Esc）显示的假对话，返回 HTML；decoyTask 是它在侧栏里对应的任务名

const r = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[r(a.length)];
const secs = () => (Math.random() * 3 + 0.2).toFixed(1);
const num = (n) => n.toLocaleString('en-US');

/* ---------------- 研发 ---------------- */
const DIRS = ['auth', 'billing', 'api', 'core', 'utils', 'workers', 'db', 'middleware', 'services', 'components'];
const FILES = ['index', 'session', 'client', 'handler', 'schema', 'queue', 'config', 'router', 'store', 'helpers', 'retry', 'cache'];
const SYMS = ['createClient', 'rotateToken', 'withRetry', 'parseConfig', 'useSession', 'enqueueJob', 'buildQuery', 'validateInput'];
const src = (ext = 'ts') => `src/${pick(DIRS)}/${pick(FILES)}.${ext}`;

const dev = {
  label: '研发',
  decoyTask: '重构会话中间件',
  tasks: [
    '重构会话中间件', '修复支付模块不稳定的测试', '配置文件迁移到 TOML',
    '给 Webhook 任务加重试', '排查索引服务内存泄漏', '构建升级到 Vite 8',
    '补充下单流程 E2E 测试', '优化图片处理流水线', '清理过期的功能开关',
  ],
  tools: [
    (n) => `Thought for ${(n % 9) + 2}s`, () => 'Read 2 files', () => 'Searched codebase',
    (n) => `Edited src/lib/util.ts  +${(n % 30) + 3} −${(n % 7) + 1}`, () => 'Ran npm test', () => 'Explored project structure',
  ],
  runner: {
    titles: [
      '运行全量单元测试', '分析依赖关系图', '生成数据库迁移脚本', '重构鉴权模块', '修复 CI 构建失败',
      '优化首屏加载性能', '补全接口类型定义', '排查线上慢查询', '升级第三方依赖', '清理废弃代码路径',
    ],
    steps: [
      ['分析项目结构', () => pick([`Explored src/${pick(DIRS)}/ · ${r(30) + 4} files`, 'Read package.json', `Listed src/${pick(DIRS)}`, 'Read tsconfig.json'])],
      ['读取相关代码', () => pick([`Read ${src()}`, `Searched for "${pick(SYMS)}" · ${r(14) + 1} results`, `Read ${src()}`, `Grep "${pick(SYMS)}(" in src/`])],
      ['制定修改计划', () => pick(['Thinking…', `Planned ${r(8) + 3} edits across ${r(5) + 2} files`, 'Reviewing call sites…', 'Comparing approaches…'])],
      ['修改代码', () => pick([`Edited ${src()}  +${r(40) + 2} −${r(15)}`, `Edited ${src()}  +${r(12) + 1} −${r(6) + 1}`, `Created ${src('test.ts')}  +${r(80) + 20}`])],
      ['类型检查', () => pick(['$ tsc --noEmit', `✓ No type errors (${secs()}s)`, '$ eslint src --fix', `✓ ${r(3)} warnings, 0 errors`])],
      ['运行测试', () => pick([`$ npm test -- ${pick(DIRS)}`, `✓ PASS ${src('test.ts')} (${secs()}s)`, `✓ PASS ${src('test.ts')} (${secs()}s)`, `Tests: ${r(60) + 20} passed, 0 failed`])],
      ['整理变更说明', () => pick(['Writing summary…', `Updated CHANGELOG.md  +${r(10) + 2}`, 'Prepared commit message'])],
    ],
  },
  decoy: ({ mark, esc }) => {
    const code = esc(`export function withSession(handler: Handler): Handler {
  return async (req, res) => {
    const token = readToken(req);
    if (!token) return res.status(401).end();

    const session = await sessions.verify(token);
    if (session.expiresIn < ROTATE_WINDOW) {
      const next = await rotateToken(session);
      setTokenCookie(res, next);
    }
    return handler({ ...req, session }, res);
  };
}`);
    return `
    <div class="msg user"><div class="bubble">帮我把会话中间件重构一下，改用新的 <code>rotateToken</code> 工具函数，对外 API 保持不变，顺便补上测试。</div></div>
    <div class="msg agent">
      <div class="agent-head">${mark}<span class="tool">Thought for 6s <i>›</i></span></div>
      <div class="tools"><div>Read <code>src/middleware/session.ts</code></div><div>Searched for <code>rotateToken</code> · 4 results</div><div>Read <code>src/auth/tokens.ts</code></div></div>
      <div class="prose">我会保留 <code>withSession</code> 作为对外入口，把 token 轮换逻辑收到它内部。现有测试依赖 cookie 名称，这部分不做改动。<br><br>更新后的中间件如下：
      <pre><code>${code}</code></pre></div>
      <div class="tools"><div class="diff">Edited <code>src/middleware/session.ts</code> <b class="add">+18</b> <b class="del">−7</b></div><div class="diff">Created <code>src/middleware/session.test.ts</code> <b class="add">+64</b></div><div>Ran <code>npm test -- session</code> · 12 passed</div></div>
      <div class="prose">改动小结：<ul><li>剩余有效期小于 <code>ROTATE_WINDOW</code> 的 token 会在响应中自动轮换。</li><li>过期或缺失的 token 仍返回 <code>401</code>，行为与之前一致。</li><li>新增 5 个测试，覆盖轮换、过期和无 cookie 三种情况。</li></ul>需要我把轮换相关的指标也接到现有监控面板上吗？</div>
    </div>`;
  },
};

/* ---------------- 文字创作（文案 / 编辑 / 写作） ---------------- */
const DOCS = ['新闻稿_v3.docx', '品牌风格指南.pdf', '采访转写_0412.txt', '产品手册_第3章.docx', '公众号选题表.xlsx', '术语表.md', '活动方案.docx'];
const PARTS = ['导语', '第 1 节', '第 2 节', '第 3 节', '结尾段', '标题', '小标题', '金句'];

const writer = {
  label: '文字创作',
  decoyTask: '新品发布会新闻稿润色',
  tasks: [
    '新品发布会新闻稿润色', '公众号推文：年度盘点', '产品手册第 3 章改写',
    '活动主视觉文案 5 版', '创始人访谈稿整理精简', '海外邮件本地化翻译',
    '短视频脚本与分镜', '用户调研报告摘要', '统一术语表与风格指南',
  ],
  tools: [
    (n) => `Thought for ${(n % 9) + 2}s`, () => 'Read 品牌风格指南.pdf', () => 'Searched 素材库',
    (n) => `Edited 正文 · +${(n % 300) + 80} 字 −${(n % 90) + 10} 字`, () => 'Checked 错别字与标点', () => 'Compared 2 versions',
  ],
  runner: {
    titles: [
      '润色新闻稿全文', '改写产品手册第 3 章', '生成 5 版活动标题', '整理访谈录音转写', '统一全文术语与语气',
      '撰写公众号推文初稿', '翻译并本地化海外邮件', '精简调研报告摘要', '校对排版终稿', '撰写短视频口播脚本',
    ],
    steps: [
      ['阅读素材', () => pick([`Read ${pick(DOCS)}`, `Read ${pick(['新闻稿_v3.docx', '采访转写_0412.txt', '产品手册_第3章.docx', '活动方案.docx'])} · ${num(r(9000) + 2000)} 字`, `Searched 素材库 "${pick(['用户故事', '发布会', '数据亮点', '客户证言'])}" · ${r(9) + 2} results`, 'Read 品牌调性说明'])],
      ['梳理结构', () => pick(['Thinking…', `Outlined ${r(4) + 4} sections`, '对比两种叙事顺序…', `Reordered ${pick(PARTS)} ↔ ${pick(PARTS)}`])],
      ['撰写初稿', () => pick([`Drafted ${pick(PARTS)} · ${r(500) + 180} 字`, `Drafted ${pick(PARTS)} · ${r(300) + 120} 字`, 'Writing…', `Generated ${r(4) + 3} 个标题备选`])],
      ['润色语言', () => pick([`Edited ${pick(PARTS)}  +${r(120) + 20} 字 −${r(90) + 10} 字`, `Rewrote ${r(6) + 2} 处长句`, `替换口语化表达 ${r(9) + 2} 处`, 'Adjusting tone…'])],
      ['事实核查', () => pick([`Verified 引用数据 ${r(6) + 2} 处`, `Checked 人名 / 职务 ${r(5) + 2} 处`, '✓ 数据来源均已标注', `Cross-checked ${pick(DOCS)}`])],
      ['校对', () => pick(['$ 错别字检查', `✓ 错别字 0 处 · 标点修正 ${r(6) + 1} 处`, `✓ 术语统一 ${r(8) + 2} 处`, `✓ 全文 ${num(r(3000) + 1800)} 字 · 阅读时长 ${r(5) + 4} 分钟`])],
      ['输出终稿', () => pick(['Writing summary…', `Exported ${pick(['终稿_v4.docx', '推文_定稿.docx', '脚本_v2.docx'])}`, '整理修改说明'])],
    ],
  },
  decoy: ({ mark }) => `
    <div class="msg user"><div class="bubble">帮我把新闻稿的导语润色一下，要更有力一点，控制在 120 字以内，不要用"重磅""震撼"这类词。</div></div>
    <div class="msg agent">
      <div class="agent-head">${mark}<span class="tool">Thought for 5s <i>›</i></span></div>
      <div class="tools"><div>Read <code>新闻稿_v3.docx</code> · 2,140 字</div><div>Read <code>品牌风格指南.pdf</code></div><div>Searched 素材库 "客户证言" · 3 results</div></div>
      <div class="prose">原导语的问题是信息堆得太满，读者读到第三行还不知道新品解决了什么。我把核心价值提到第一句，参数放到第二段展开。<br><br>修改后的导语（116 字）：
      <blockquote>11 月 18 日，团队正式发布新一代智能协作平台。它把会议、文档和任务放进同一个工作区：会议结束时，纪要和待办已经自动分配到人。内测期间，200 多家企业的跨部门沟通时间平均缩短了三分之一。</blockquote>
      另外给你一个更短的备选（68 字），适合做社交媒体摘要：
      <blockquote>会议一结束，纪要和待办就已经分好了。新一代智能协作平台今天发布，内测企业的沟通时间平均缩短三分之一。</blockquote></div>
      <div class="tools"><div class="diff">Edited <code>新闻稿_v3.docx</code> · 导语 <b class="add">+116 字</b> <b class="del">−183 字</b></div><div>Checked 错别字与标点 · 0 处</div></div>
      <div class="prose">修改说明：<ul><li>去掉了"业界领先""全面升级"等空泛表述，换成可验证的数据。</li><li>"三分之一"来自内测报告第 4 页，建议发稿前请产品同事再确认一次口径。</li><li>第二段的参数介绍我也顺了一遍语序，没有改动内容。</li></ul>需要我按同样的风格把标题也出 3 个备选吗？</div>
    </div>`,
};

/* ---------------- 通用 · 办公 ---------------- */
const OFFICE_FILES = ['周会录音转写.txt', '报销明细_10月.xlsx', 'Q4 汇报大纲.pptx', '客户邮件往来.eml', '排期表.xlsx', '会议议程.docx', '供应商报价.xlsx'];

const office = {
  label: '通用 · 办公',
  decoyTask: '整理周会纪要和待办',
  tasks: [
    '整理周会纪要和待办', '起草 Q4 汇报 PPT 大纲', '回复客户邮件：交付延期说明',
    '合并 3 份报销明细表', '制定下月项目排期', '季度复盘会议程准备',
    '供应商比价表整理', '项目周报自动汇总', '新人入职材料清单核对',
  ],
  tools: [
    (n) => `Thought for ${(n % 9) + 2}s`, () => 'Read 2 files', () => 'Searched 共享盘',
    (n) => `Updated 排期表.xlsx · ${(n % 30) + 3} rows`, () => 'Drafted email', () => 'Checked calendar',
  ],
  runner: {
    titles: [
      '整理本周会议纪要', '汇总各组周报', '合并报销明细并核对', '生成 Q4 汇报大纲', '更新项目排期表',
      '起草客户回复邮件', '整理供应商报价对比', '核对入职材料清单', '准备季度复盘议程', '归档本月合同文件',
    ],
    steps: [
      ['读取文件', () => pick([`Read ${pick(OFFICE_FILES)}`, `Read ${pick(['报销明细_10月.xlsx', '排期表.xlsx', '供应商报价.xlsx'])} · ${r(6) + 2} sheets`, `Searched 共享盘 "${pick(['周报', '合同', '报价', '纪要'])}" · ${r(12) + 3} results`, 'Opened 团队日历'])],
      ['提取要点', () => pick(['Thinking…', `Extracted ${r(8) + 4} 条待办`, `识别负责人 ${r(5) + 3} 位`, '归纳讨论结论…'])],
      ['整理表格', () => pick([`Merged ${r(3) + 2} sheets · ${r(300) + 80} rows`, `$ 去重 · 移除重复行 ${r(15) + 2} 条`, `Sorted by 截止日期`, `Calculated 合计 ¥${num(r(90000) + 8000)}`])],
      ['生成文档', () => pick([`Drafted ${pick(['会议纪要.docx', '周报汇总.docx', '回复邮件', '汇报大纲.pptx'])}`, `Created ${r(8) + 6} 页幻灯片大纲`, 'Writing…', `Filled 模板 · ${r(10) + 4} fields`])],
      ['检查核对', () => pick([`✓ 金额核对一致`, `✓ 日期冲突 0 处`, `Flagged 缺失发票 ${r(3) + 1} 张`, `✓ 收件人与抄送已确认`])],
      ['汇总输出', () => pick(['Writing summary…', `Saved to 共享盘/${pick(['周会', '财务', '项目'])}/`, `Scheduled 提醒 ${r(4) + 2} 条`])],
    ],
  },
  decoy: ({ mark }) => `
    <div class="msg user"><div class="bubble">帮我把今天周会的录音转写整理成纪要，待办按负责人列出来，截止时间也标上。</div></div>
    <div class="msg agent">
      <div class="agent-head">${mark}<span class="tool">Thought for 7s <i>›</i></span></div>
      <div class="tools"><div>Read <code>周会录音转写.txt</code> · 52 分钟</div><div>Read <code>排期表.xlsx</code> · 3 sheets</div><div>Checked calendar · 本周</div></div>
      <div class="prose"><b>周会纪要 · 11 月 15 日</b><br>参会：产品、设计、研发、运营共 8 人<br><br>主要结论：<ul><li>新版本上线时间维持 11 月 28 日不变，灰度比例第一周控制在 10%。</li><li>活动页改版延后到下个迭代，本周优先处理客户反馈的导出问题。</li><li>周五前确认年会场地，预算按去年标准上浮 10%。</li></ul>
      待办事项：
      <table><thead><tr><th>事项</th><th>负责人</th><th>截止</th></tr></thead><tbody>
      <tr><td>输出灰度方案和回滚预案</td><td>研发 · 陈工</td><td>11/20</td></tr>
      <tr><td>导出功能问题排查与修复</td><td>研发 · 小刘</td><td>11/18</td></tr>
      <tr><td>活动页新稿评审</td><td>设计 · Amy</td><td>11/22</td></tr>
      <tr><td>年会场地比价并确认</td><td>行政 · 王姐</td><td>11/17</td></tr>
      </tbody></table></div>
      <div class="tools"><div class="diff">Created <code>周会纪要_1115.docx</code> <b class="add">+1 页</b></div><div class="diff">Updated <code>排期表.xlsx</code> <b class="add">+4 rows</b></div></div>
      <div class="prose">录音里第 34 分钟关于预算的讨论有两种说法，我按最后的结论记录了，建议会后找财务再确认一下。需要我把纪要直接发到项目群，并给各负责人建日历提醒吗？</div>
    </div>`,
};

/* ---------------- 通用 · 调研分析 ---------------- */
const RES_FILES = ['用户反馈_10月.csv', '销售明细_Q3.xlsx', '行业报告_2026.pdf', '问卷结果.csv', '竞品功能清单.xlsx', '访谈记录汇总.docx'];

const research = {
  label: '通用 · 调研分析',
  decoyTask: '10 月用户反馈分类分析',
  tasks: [
    '竞品功能对比调研', '行业报告要点提炼', '10 月用户反馈分类分析',
    'Q3 销售数据复盘', '问卷结果交叉统计', '政策文件解读摘要',
    '目标市场规模估算', '渠道转化漏斗分析', '文献综述：远程协作效率',
  ],
  tools: [
    (n) => `Thought for ${(n % 9) + 2}s`, () => 'Searched web', () => 'Read 行业报告_2026.pdf',
    (n) => `Analyzed ${num((n % 4000) + 800)} rows`, () => 'Created chart', () => 'Ran analysis.py',
  ],
  runner: {
    titles: [
      '分析 10 月用户反馈', '汇总竞品功能对比', '提炼行业报告要点', '计算渠道转化漏斗', '问卷数据交叉统计',
      '复盘 Q3 销售数据', '估算目标市场规模', '整理访谈洞察', '生成月度数据看板', '核对引用与数据来源',
    ],
    steps: [
      ['检索资料', () => pick([`Searched web "${pick(['协作软件 市场规模', '竞品 定价策略', '用户留存 基准', '行业白皮书 2026'])}" · ${r(15) + 5} results`, `Fetched ${pick(['行业报告_2026.pdf', '政策解读.pdf', '竞品白皮书.pdf'])} · ${r(60) + 12} 页`, `Read ${pick(RES_FILES)}`])],
      ['清洗数据', () => pick([`$ python clean.py ${pick(['feedback_10.csv', 'sales_q3.xlsx', 'survey.csv'])}`, `Loaded ${pick(['用户反馈_10月.csv', '销售明细_Q3.xlsx', '问卷结果.csv'])} · ${num(r(8000) + 1200)} rows`, `Dropped 空值 / 重复 ${r(120) + 10} 行`, `Normalized ${r(6) + 3} columns`])],
      ['统计分析', () => pick(['Thinking…', `Grouped by ${pick(['渠道', '地区', '月份', '用户类型'])} · ${r(8) + 4} groups`, `Computed 同比 / 环比`, `$ python analysis.py --by ${pick(['channel', 'region', 'month'])}`, 'Checking outliers…'])],
      ['生成图表', () => pick([`Created chart ${pick(['月度趋势.png', '渠道占比.png', '漏斗.png', '分类分布.png'])}`, `Built 透视表 · ${r(12) + 4} × ${r(6) + 3}`, `✓ 图表 ${r(4) + 2} 张已生成`])],
      ['撰写结论', () => pick([`Drafted 结论 ${r(4) + 3} 条`, 'Writing…', `Summarized ${r(5) + 3} 个关键发现`, '对比上季度结论…'])],
      ['核对来源', () => pick([`✓ 引用 ${r(9) + 4} 处均可溯源`, `Verified 关键数据 ${r(5) + 2} 处`, 'Writing summary…', `Exported 分析报告.pdf`])],
    ],
  },
  decoy: ({ mark }) => `
    <div class="msg user"><div class="bubble">帮我分析一下 10 月的用户反馈，按问题类型分类，看看哪几类最多，和 9 月相比有什么变化。</div></div>
    <div class="msg agent">
      <div class="agent-head">${mark}<span class="tool">Thought for 8s <i>›</i></span></div>
      <div class="tools"><div>Read <code>用户反馈_10月.csv</code> · 3,412 rows</div><div>Read <code>用户反馈_9月.csv</code> · 2,987 rows</div><div>Ran <code>python analysis.py --by category</code></div></div>
      <div class="prose">去掉重复提交和无效内容后，10 月有效反馈 3,186 条，比 9 月多 13.4%。按问题类型分布如下：
      <table><thead><tr><th>类型</th><th>10 月</th><th>占比</th><th>环比</th></tr></thead><tbody>
      <tr><td>导出 / 打印异常</td><td>742</td><td>23.3%</td><td class="up">+41%</td></tr>
      <tr><td>同步延迟</td><td>615</td><td>19.3%</td><td class="down">−8%</td></tr>
      <tr><td>功能建议</td><td>588</td><td>18.5%</td><td class="up">+6%</td></tr>
      <tr><td>登录与账号</td><td>401</td><td>12.6%</td><td class="down">−15%</td></tr>
      <tr><td>其他</td><td>840</td><td>26.3%</td><td>+3%</td></tr>
      </tbody></table>
      主要发现：<ul><li>导出问题增长最明显，集中在 10 月 12 日版本发布之后，约 70% 来自 Windows 客户端。</li><li>同步延迟和登录问题都在下降，说明 9 月的两次修复是有效的。</li><li>功能建议里提得最多的是"批量编辑"（126 条），可以考虑排进下个季度。</li></ul></div>
      <div class="tools"><div class="diff">Created <code>反馈分类趋势.png</code></div><div class="diff">Created <code>10月反馈分析.xlsx</code> <b class="add">+3 sheets</b></div></div>
      <div class="prose">需要我把导出问题的原始反馈按客户端版本再拆一层，方便研发定位吗？</div>
    </div>`,
};

export const PERSONAS = { dev, writer, office, research };
export const DEFAULT_PERSONA = 'dev';
export const getPersona = (key) => PERSONAS[key] || PERSONAS[DEFAULT_PERSONA];
