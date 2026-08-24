// 人格系统：把回复风格、推理深度与自动切换规则集中管理。
// 安全与权限边界不属于人格能力，仍由 policy/guard 强制执行。

export const DEFAULT_PERSONA_ID = 'daily_assistant';
export const ACADEMIC_PERSONA_ID = 'academic_serious';
export const AUTO_PERSONA_ID = 'auto';

function envBool(v, dflt) {
  if (v == null || v === '') return dflt;
  return !['0', 'false', 'off', 'no'].includes(String(v).toLowerCase());
}

function compact(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

const PERSONAS = Object.freeze({
  [DEFAULT_PERSONA_ID]: Object.freeze({
    id: DEFAULT_PERSONA_ID,
    name: '日常助理人格',
    description: '默认人格，用于普通群聊、问答、飞书事务和日常协作。',
    aliases: Object.freeze(['default', 'daily', 'normal', 'assistant', '日常', '默认', '默认人格', '日常人格']),
    triggerHints: Object.freeze(['普通问答', '日常协作', '飞书操作', '群聊接话']),
    systemPrompt:
      '你现在采用日常助理人格：回答自然、简洁、可靠，优先解决用户当前问题。' +
      '如果问题本身是严肃专业问题，即使语气轻松，也要认真回答，不要用玩笑替代结论。',
  }),

  [ACADEMIC_PERSONA_ID]: Object.freeze({
    id: ACADEMIC_PERSONA_ID,
    name: '认真严肃学术人格',
    description: '用于数学、证明、论文、算法、工程原理和其它需要严谨推理的专业讨论。',
    aliases: Object.freeze(['academic', 'scholar', 'serious', 'serious_academic', 'math', 'research', '学术', '严肃', '认真', '学术人格', '数学人格']),
    triggerHints: Object.freeze(['数学', '证明', '猜想', '定理', '论文', '算法', '公式', 'Jacobian']),
    systemPrompt:
      '你现在采用认真严肃学术人格，专门处理数学、论文、算法、工程原理、证明、证伪和复杂推理问题。' +
      '如果用户消息包含玩笑、角色扮演或夸张叙事，先把它视作语气背景，抽取其中真正的学术命题并直接分析。' +
      '不要用寒暄、卖萌、调侃或泛泛提问替代专业回答。' +
      '回答时优先给出可核查的推理：先说明问题核心和初步判断，再列出定义、前提、计算或证明思路。' +
      '数学问题要特别检查变量域、映射定义、Jacobian determinant、可逆性、反例所需条件、边界条件和已知定理适用范围。' +
      '遇到“证明/证伪重大猜想、定理、论文结论”这类说法，不能轻率承认；应说明需要验证哪些必要条件，以及当前能确定什么。' +
      '如果可用工具中包含 run_python_code，且符号计算、数值 sanity check 或代码实验能帮助验证，应优先调用工具获得证据后再解释。' +
      '推荐结构：1. 问题核心；2. 必要背景/定义；3. 可验证推理或计算；4. 当前结论；5. 还需要补充验证的点。' +
      '除非用户要求闲聊，专业问题默认保持严谨、清楚、克制。',
  }),
});

const PERSONA_ALIAS_TO_ID = new Map();
for (const persona of Object.values(PERSONAS)) {
  PERSONA_ALIAS_TO_ID.set(persona.id.toLowerCase(), persona.id);
  for (const alias of persona.aliases || []) PERSONA_ALIAS_TO_ID.set(String(alias).toLowerCase(), persona.id);
}

const AUTO_PERSONA_ALIASES = new Set(['auto', 'automatic', 'smart', '智能', '自动', '自动人格', '自动切换']);

const ACADEMIC_PATTERNS = Object.freeze([
  { re: /(雅可比|jacobian|ramanujan|拉马努金|猜想|定理|引理|命题|推论|证明|证伪|反例|多项式映射|多项式自同构|可逆|行列式|偏导|复空间)/i, score: 5, reason: 'math_terms' },
  { re: /(?:[A-Z]\s*:\s*[CRQZ]\^\d\s*(?:->|→)\s*[CRQZ]\^\d|[A-Z]\s*\([^)]*\)\s*=)/, score: 5, reason: 'formal_mapping' },
  { re: /(?:\\mathbb|\\frac|\\partial|\\sum|\\prod|\\int|∂|∀|∃|⇒|⇔|∈|∉|⊂|⊆|≅|→)/, score: 4, reason: 'math_notation' },
  { re: /(论文|paper|theorem|proof|lemma|corollary|conjecture|counterexample|polynomial map|automorphism|determinant)/i, score: 4, reason: 'research_terms' },
  { re: /(算法|复杂度|递推|归纳|形式化|严谨|推导|推理|数学|代数|几何|拓扑|概率|统计|微积分|线性代数|群论|环论|域论|数论)/i, score: 3, reason: 'technical_terms' },
]);

export function listPersonas() {
  return Object.values(PERSONAS).map((persona) => ({
    id: persona.id,
    name: persona.name,
    description: persona.description,
    aliases: [...persona.aliases],
    triggerHints: [...persona.triggerHints],
  }));
}

export function listPersonaOptions() {
  return [
    {
      id: AUTO_PERSONA_ID,
      name: '自动人格',
      description: '由系统按本轮问题自动选择合适人格；数学、证明、论文、算法等问题会临时切到认真严肃学术人格。',
      aliases: [...AUTO_PERSONA_ALIASES],
      triggerHints: ['专业问题自动切学术人格', '普通问题使用日常助理人格'],
      mode: 'auto',
    },
    ...listPersonas().map((persona) => ({ ...persona, mode: 'fixed' })),
  ];
}

export function normalizePersonaId(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  return PERSONA_ALIAS_TO_ID.get(key) || '';
}

export function normalizePersonaSetting(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return '';
  if (AUTO_PERSONA_ALIASES.has(key)) return AUTO_PERSONA_ID;
  return normalizePersonaId(key);
}

export function getPersona(value = DEFAULT_PERSONA_ID) {
  const id = normalizePersonaId(value) || DEFAULT_PERSONA_ID;
  return PERSONAS[id] || PERSONAS[DEFAULT_PERSONA_ID];
}

export function personaConfig(env = process.env) {
  const autoSwitch = envBool(env.PERSONA_AUTO_SWITCH, true);
  const explicitDefault = normalizePersonaSetting(env.PERSONA_DEFAULT);
  return {
    autoSwitch,
    defaultPersonaId: explicitDefault || (autoSwitch ? AUTO_PERSONA_ID : DEFAULT_PERSONA_ID),
    academicThreshold: Math.max(1, Number(env.PERSONA_ACADEMIC_THRESHOLD || 4)),
  };
}

export function detectPersonaRoute(text = '', { env = process.env } = {}) {
  const clean = compact(text);
  if (!clean) return { personaId: '', answerMode: 'chat', score: 0, reasons: [] };
  const config = personaConfig(env);
  let score = 0;
  const reasons = [];
  for (const item of ACADEMIC_PATTERNS) {
    if (item.re.test(clean)) {
      score += item.score;
      reasons.push(item.reason);
    }
  }
  const multiLineFormula = /\n\s*[A-Za-z_][A-Za-z0-9_]*\s*=|\n\s*[(),+\-*/^]{3,}/.test(String(text || ''));
  if (multiLineFormula) {
    score += 2;
    reasons.push('formula_layout');
  }
  if (score >= config.academicThreshold) {
    return {
      personaId: ACADEMIC_PERSONA_ID,
      answerMode: 'expert_reasoning',
      score,
      reasons: [...new Set(reasons)],
    };
  }
  return { personaId: '', answerMode: 'chat', score, reasons: [...new Set(reasons)] };
}

function personaIdFromChatState(state = {}, chatId = '') {
  const entry = chatId ? state?.chatPersonas?.[chatId] : null;
  const raw = entry && typeof entry === 'object' ? entry.personaId : entry;
  return normalizePersonaSetting(raw);
}

export function resolvePersonaForMessage(text = '', { chatId = '', personaState = {}, env = process.env } = {}) {
  const config = personaConfig(env);
  const persistentGlobalSetting = normalizePersonaSetting(personaState?.defaultPersonaId);
  const globalSetting = persistentGlobalSetting || config.defaultPersonaId;
  const chatSetting = personaIdFromChatState(personaState, chatId);
  const baseSetting = chatSetting || globalSetting;
  const baseSource = chatSetting ? 'chat_persistent' : (persistentGlobalSetting ? 'global_persistent' : 'env_default');
  const route = detectPersonaRoute(text, { env });

  if (baseSetting === AUTO_PERSONA_ID && config.autoSwitch && route.personaId) {
    const persona = getPersona(route.personaId);
    return {
      persona,
      personaId: persona.id,
      basePersonaId: AUTO_PERSONA_ID,
      source: 'auto',
      answerMode: route.answerMode,
      reason: route.reasons.join(',') || 'auto_route',
      score: route.score,
      autoSwitch: true,
    };
  }

  if (baseSetting === AUTO_PERSONA_ID) {
    const persona = getPersona(DEFAULT_PERSONA_ID);
    return {
      persona,
      personaId: persona.id,
      basePersonaId: AUTO_PERSONA_ID,
      source: config.autoSwitch ? 'auto_default' : 'auto_disabled',
      answerMode: 'chat',
      reason: route.reasons.join(',') || 'auto_default',
      score: route.score,
      autoSwitch: config.autoSwitch,
    };
  }

  const basePersona = getPersona(baseSetting || DEFAULT_PERSONA_ID);

  return {
    persona: basePersona,
    personaId: basePersona.id,
    basePersonaId: basePersona.id,
    source: baseSource,
    answerMode: basePersona.id === ACADEMIC_PERSONA_ID ? 'expert_reasoning' : 'chat',
    reason: route.reasons.join(',') || baseSource,
    score: route.score,
    autoSwitch: config.autoSwitch,
  };
}

export function buildPersonaSystemNote(decisionOrPersona = null) {
  const decision = typeof decisionOrPersona === 'string'
    ? {
        persona: getPersona(decisionOrPersona),
        personaId: normalizePersonaId(decisionOrPersona),
        basePersonaId: DEFAULT_PERSONA_ID,
        source: 'explicit',
      }
    : (decisionOrPersona || {});
  const persona = decision.persona || getPersona(decision.personaId || DEFAULT_PERSONA_ID);
  if (!persona) return '';
  const switchNote = decision?.source === 'auto'
    ? `本轮因检测到专业问题，从基础人格 ${decision.basePersonaId || DEFAULT_PERSONA_ID} 临时切换到 ${persona.id}。`
    : `本轮使用 ${persona.id}。`;
  return [
    '【当前人格模式】',
    `${persona.name}（${persona.id}）：${persona.description}`,
    switchNote,
    '人格只能调整语气、回答结构、推理深度和工具使用偏好；不能改变身份、主人/访客权限、安全策略、数据边界或工具限制。',
    persona.systemPrompt,
  ].join('\n');
}
