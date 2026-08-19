import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const sourceDir = process.argv[2] || 'E:/kolforge-data/manual-douyin/20260813-sanguosha-wuhu-all';
const outputDir = process.argv[3] || 'C:/Users/10847/Documents/MKT大师/output/wuhu-grounded-player-context-20260813';

const commentsPath = path.join(sourceDir, 'all-comments.csv');
const videosPath = path.join(sourceDir, 'videos-summary.csv');
const metadataDir = path.join(sourceDir, 'metadata');
const manifestPath = path.join(sourceDir, 'manifest.json');

const reportPath = path.join(outputDir, '三国杀WUHU联盟卡宝玩家语境扎根内容分析报告.html');
const summaryPath = path.join(outputDir, 'wuhu-grounded-player-context-analysis.json');
const codebookPath = path.join(outputDir, '三国杀玩家语境扎根编码手册.md');
const codedCommentsPath = path.join(outputDir, 'wuhu-grounded-coded-comments.csv');
const artifactManifestPath = path.join(outputDir, 'artifact-manifest.json');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  const [rawHeaders, ...body] = rows;
  const headers = rawHeaders.map((header) => header.replace(/^\uFEFF/, ''));
  return body
    .filter((values) => values.some((value) => value !== ''))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function number(value) {
  const parsed = Number(String(value ?? '').replace(/^[\s']+/, '').replace(/[, +]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function quantile(values, probability) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const index = (ordered.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + ((ordered[upper] - ordered[lower]) * (index - lower));
}

function percent(value, total, digits = 1) {
  return total ? `${((value / total) * 100).toFixed(digits)}%` : '0.0%';
}

function formatInteger(value) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Math.round(value));
}

function formatDecimal(value, digits = 1) {
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\[[^\]]{1,12}\]/g, '')
    .replace(/[\s\u200b-\u200d\ufeff]+/g, '')
    .replace(/[，。！？、,.!?~～…：:；;“”"'‘’（）()【】\[\]]+/g, '')
    .toLowerCase();
}

function truncate(value, maxLength = 128) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function deidentifyText(value) {
  return String(value ?? '')
    .replace(/^['“”‘’]?@[^:：\r\n]{1,40}[:：]\s*/u, '')
    .replace(/@[^\s,，。！？!?、:：；;]{1,40}/gu, '@用户')
    .replace(/@(?!用户)/gu, '@用户')
    // Remove identifier-shaped numbers before retaining text as evidence.
    .replace(/(?<![0-9A-Za-z])\d{17}[\dXx](?![0-9A-Za-z])/gu, '[证件号码已脱敏]')
    .replace(/(?<!\d)\d{7,}(?!\d)/gu, '[长数字已脱敏]');
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function userKey(comment) {
  return comment['评论用户URL'] || `name:${comment['评论用户']}`;
}

function testRegex(regex, value) {
  return new RegExp(regex.source, regex.flags.replace('g', '')).test(String(value ?? ''));
}

function isCanonAudit(value) {
  const text = String(value ?? '').trim();
  if (text.length < 8) return false;
  if (testRegex(/这才是正史|三国志.{0,10}假的|总有一条时间线|完美时间线|历史总是惊人的相似|三国志.{0,12}致敬|如果历史上|符合史实|亦有记载|没看过三国志|绿豆/g, text)) return false;
  const sourceOrObject = /正史|历史上|史实|三国志|演义|时间线|建模|设定|服饰|头盔|出生|去世|太守|造反|反间计|卧底|三姓家奴/;
  const correction = /错|不对|有误|不是|并非|没有|没什么|没造过|从来没|不可能|见不到|应该是|不应该|怎么(?:会|能|当)|哪条|主流观点|其实.{0,8}(?:是|并不是)|还没|已经|有争议|建议看看|不要说|只有.{0,8}(?:一个|左边)|并不|并未/;
  const explicitAnchor = /正史|历史上|史实|三国志|演义|时间线|建模|设定|服饰|头盔|出生|去世|太守/;
  const disputedObject = /造反|反间计|卧底|三姓家奴/;
  if (!explicitAnchor.test(text) && disputedObject.test(text)) {
    return /哪条|有争议|主流观点|并没有|并非|不是|没有真|没有反心|从来没说/.test(text);
  }
  return sourceOrObject.test(text) && correction.test(text);
}

function readMetadata(directory) {
  const records = new Map();
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      const metadata = parsed.metadata ?? {};
      if (metadata.video_id) records.set(String(metadata.video_id), metadata);
    } catch {
      // Invalid metadata is excluded and recorded through the observed count.
    }
  }
  return records;
}

const CHARACTER_GROUPS = [
  { id: 'cao_cao', label: '曹操 / 阿瞒', canonical: ['曹操'], aliases: ['阿瞒', '操操'] },
  { id: 'guo_jia', label: '郭嘉 / 奉孝', canonical: ['郭嘉'], aliases: ['奉孝', '嘉嘉', '郭奉孝'] },
  { id: 'jiang_wei', label: '姜维 / 伯约', canonical: ['姜维'], aliases: ['伯约'] },
  { id: 'zhong_hui', label: '钟会 / 士季', canonical: ['钟会'], aliases: ['士季'] },
  { id: 'zhou_yu', label: '周瑜 / 公瑾 / 大嘟嘟', canonical: ['周瑜'], aliases: ['公瑾', '大嘟嘟', '嘟嘟'] },
  { id: 'sun_ce', label: '孙策 / 伯符 / 孙笨', canonical: ['孙策'], aliases: ['伯符', '孙笨'] },
  { id: 'jia_xu', label: '贾诩 / 文和', canonical: ['贾诩'], aliases: ['文和'] },
  { id: 'xun_yu', label: '荀彧 / 文若 / 荀令君', canonical: ['荀彧'], aliases: ['文若', '荀令君', '令君'] },
  { id: 'sima_yi', label: '司马懿 / 仲达', canonical: ['司马懿'], aliases: ['仲达'] },
  { id: 'sima_zhao', label: '司马昭 / 小昭昭', canonical: ['司马昭'], aliases: ['小昭昭'] },
  { id: 'cao_mao', label: '曹髦 / 小髦髦', canonical: ['曹髦'], aliases: ['小髦髦'] },
  { id: 'liu_bei', label: '刘备 / 玄德 / 备备', canonical: ['刘备'], aliases: ['玄德', '备备', '阿备备'] },
  { id: 'zhao_yun', label: '赵云 / 子龙', canonical: ['赵云'], aliases: ['子龙'] },
  { id: 'zhuge_liang', label: '诸葛亮 / 孔明', canonical: ['诸葛亮'], aliases: ['孔明', '亮亮', '小诸葛'] },
  { id: 'wei_yan', label: '魏延 / 文长', canonical: ['魏延'], aliases: ['文长'] },
  { id: 'liu_shan', label: '刘禅 / 阿斗', canonical: ['刘禅'], aliases: ['阿斗'] },
  { id: 'deng_ai', label: '邓艾 / 士载', canonical: ['邓艾'], aliases: ['士载'] },
  { id: 'cao_pi', label: '曹丕 / 子桓', canonical: ['曹丕'], aliases: ['子桓'] },
  { id: 'cao_zhi', label: '曹植 / 子建', canonical: ['曹植'], aliases: ['子建'] },
  { id: 'xi_zhi_cai', label: '戏志才 / 志才', canonical: ['戏志才'], aliases: ['志才'] },
  { id: 'huang_gai', label: '黄盖 / 公覆', canonical: ['黄盖'], aliases: ['公覆'] },
  { id: 'ma_chao', label: '马超 / 孟起', canonical: ['马超'], aliases: ['孟起'] },
  { id: 'lu_bu', label: '吕布 / 奉先', canonical: ['吕布'], aliases: ['奉先'] },
  { id: 'zhang_xiu', label: '张绣', canonical: ['张绣'], aliases: [] },
  { id: 'cao_chong', label: '曹冲', canonical: ['曹冲'], aliases: [] },
  { id: 'sun_quan', label: '孙权 / 仲谋', canonical: ['孙权'], aliases: ['仲谋'] },
  { id: 'lu_xun', label: '陆逊 / 伯言 / 陆老板', canonical: ['陆逊'], aliases: ['伯言', '陆老板'] },
  { id: 'xu_sheng', label: '徐盛 / 文向 / 大宝', canonical: ['徐盛'], aliases: ['文向', '大宝'] },
  { id: 'guan_yu', label: '关羽 / 云长', canonical: ['关羽'], aliases: ['云长'] },
  { id: 'zhang_fei', label: '张飞 / 翼德 / 小飞飞', canonical: ['张飞'], aliases: ['翼德', '小飞飞'] },
  { id: 'da_qiao', label: '大乔', canonical: ['大乔'], aliases: [] },
  { id: 'xiao_qiao', label: '小乔', canonical: ['小乔'], aliases: [] },
  { id: 'diao_chan', label: '貂蝉', canonical: ['貂蝉'], aliases: [] },
  { id: 'pang_tong', label: '庞统 / 士元', canonical: ['庞统'], aliases: ['士元'] },
  { id: 'huang_yue_ying', label: '黄月英', canonical: ['黄月英'], aliases: ['月英'] },
  { id: 'wen_yang', label: '文鸯', canonical: ['文鸯'], aliases: [] },
  { id: 'yu_ji', label: '于吉', canonical: ['于吉'], aliases: [] },
  { id: 'zhong_yu', label: '钟毓', canonical: ['钟毓'], aliases: [] },
  { id: 'ju_shou', label: '沮授', canonical: ['沮授'], aliases: [] },
  { id: 'li_ru', label: '李儒', canonical: ['李儒'], aliases: [] },
  { id: 'cheng_yu', label: '程昱', canonical: ['程昱'], aliases: [] },
  { id: 'sun_chen', label: '孙綝', canonical: ['孙綝'], aliases: [] },
  { id: 'yuan_shao', label: '袁绍', canonical: ['袁绍'], aliases: [] },
  { id: 'jiang_gan', label: '蒋干', canonical: ['蒋干'], aliases: [] },
  { id: 'wei_feng', label: '魏讽', canonical: ['魏讽'], aliases: [] },
  { id: 'cao_ang', label: '曹昂', canonical: ['曹昂'], aliases: [] },
];

const allCanonicalNames = CHARACTER_GROUPS.flatMap((group) => group.canonical);
const allAliases = CHARACTER_GROUPS.flatMap((group) => group.aliases);
const characterPattern = new RegExp([...allCanonicalNames, ...allAliases].sort((a, b) => b.length - a.length).join('|'));
const aliasPattern = new RegExp(allAliases.sort((a, b) => b.length - a.length).join('|'));

const OPEN_CODES = [
  {
    id: 'mascot_persona_reference',
    label: '卡宝点名/人格化入口',
    axis: 'persona_governance',
    definition: '直接提及“卡宝”；其中相当一部分是在向一个可要求、可撒娇、可归责的账号人格说话。',
    rule: '精确命中“卡宝”；本代码只证明点名，直接对话、作者自称与普通名词提及在二级统计中拆分。',
    test: (text) => testRegex(/卡宝/g, text),
  },
  {
    id: 'community_address',
    label: '“将军”社群称谓',
    axis: 'persona_governance',
    definition: '作者或观众用“将军”把普通观看者放进三国杀世界中的行动者位置。',
    rule: '精确命中“将军”；作者使用与观众自发使用单独统计，不能直接写成全体用户身份认同。',
    test: (text) => testRegex(/将军/g, text),
  },
  {
    id: 'publisher_pun_grievance',
    label: '“狗卡”双关/厂商情绪接口',
    axis: 'persona_governance',
    definition: '以“狗卡/卡狗”称呼账号、卡宝或发行方，可能同时包含亲昵、戏谑和商业系统怨气。',
    rule: '精确命中“狗卡/卡狗”；不自动判负面，必须结合宝珠、爆率、官方身份等上下文。',
    test: (text) => testRegex(/狗卡|卡狗/g, text),
  },
  {
    id: 'character_recognition',
    label: '武将识别与点名',
    axis: 'knowledge_memory',
    definition: '评论直接点出武将姓名、字或社区昵称，表明内容被放入具体角色框架。',
    rule: '命中预设武将名、表字或稳定昵称词表。',
    test: (text) => testRegex(characterPattern, text),
  },
  {
    id: 'courtesy_nickname',
    label: '表字/玩家昵称调用',
    axis: 'knowledge_memory',
    definition: '使用奉孝、伯约、文和、孙笨等表字或玩家昵称，属于高于普通点名的圈层识别信号。',
    rule: '命中表字/昵称词表；不把普通角色全名算入。',
    test: (text) => testRegex(aliasPattern, text),
  },
  {
    id: 'game_system_jargon',
    label: 'IP/版本/游戏系统指涉',
    axis: 'knowledge_memory',
    definition: '评论明确调用三国杀、武将、技能、卡牌、版本、模式或产品环境；这是宽口径IP/系统指涉，不等于机制理解。',
    rule: '宽口径收取完整术语或带动作的牌名表达；已排除裸“杀/闪/桃/酒”单字。机制重映射只看下一项高精度代码。',
    test: (text) => testRegex(/三国杀|武将|技能|卖血|不动白|锁定技|非锁定技|限定技|主公技|铁骑|雄乱|放逐|屯田|遗计|天妒|权计|排异|挑衅|观星|仁德|护驾|觉醒|判定|摸牌|出牌|手牌|牌堆|牌序|锦囊|装备|回合|体力|血量|出杀|用杀|打出.{0,3}杀|没闪|有闪|吃桃|有桃|一血两牌|AOE|主公|忠臣|反贼|内奸|身份场|身份局|军八|国战|斗地主|农民|地主|排位|手杀|移动版|十周年|三国杀OL|(?:^|[^a-z])OL(?:$|[^a-z])|珠联璧合|界(?=[曹刘孙司郭姜钟邓马魏荀贾张赵周吕夏诸徐文])|谋(?=[曹刘孙司郭姜钟邓马魏荀贾张赵周吕夏诸徐文])|势(?=[曹刘孙司郭姜钟邓马魏荀贾张赵周吕夏诸徐文])|神(?=[曹刘孙司郭姜钟邓马魏荀贾张赵周吕夏诸徐文])|SP(?=[曹刘孙司郭姜钟邓马魏荀贾张赵周吕夏诸徐文])/gi, text),
  },
  {
    id: 'mechanic_remap_validation',
    label: '机制重映射/规则校验',
    axis: 'knowledge_memory',
    definition: '把画面动作翻译成具体技能、牌或规则效果，或检查机制在对应版本中是否成立。',
    rule: '使用高精度机制词与动作组合；不把仅提“三国杀/武将/版本”的评论纳入。',
    test: (text) => testRegex(/卖血|不动白|锁定技|非锁定技|限定技|主公技|技能失效|铁骑|雄乱|放逐|屯田|遗计|天妒|权计|排异|挑衅|观星|仁德|护驾|觉醒|判定|摸牌|出牌|手牌|牌堆|牌序|锦囊|装备|出杀|用杀|没闪|有闪|吃桃|有桃|一血两牌|珠联璧合|全服保底/g, text),
  },
  {
    id: 'game_economy_memory',
    label: '开盒/养成经济记忆',
    axis: 'knowledge_memory',
    definition: '把视频里的抽取、概率或消费情景类比到三国杀开盒与养成体验。',
    rule: '命中开盒、爆率、招募令、将魂、祈福、氪金等经济系统词。',
    test: (text) => testRegex(/开盒|盒子.*爆率|爆率|招募令|将魂|宝珠|祈福|抽卡|抽武将|史诗|传说皮肤|氪金|充值|元宝|银两|保底|出货/g, text),
  },
  {
    id: 'historical_intertext',
    label: '史实/演义互文',
    axis: 'knowledge_memory',
    definition: '用正史、演义、典故与人物生平补全或纠正视频叙事。',
    rule: '命中明确的史源标记、历史事件或考据句式；不把所有角色名自动视为历史讨论。',
    test: (text) => testRegex(/正史|历史上|史实|演义|三国志|典故|北伐|复国|兵变|托孤|禅让|衣带诏|空食盒|食盒|七步诗|高平陵|五丈原|白帝城|麦城|夷陵|官渡|赤壁|力排众议|降钟会|骗了钟会|钟会.*信了姜维/g, text),
  },
  {
    id: 'canon_audit',
    label: '史实/设定认真校验',
    axis: 'knowledge_memory',
    definition: '对时间线、服饰建模、人物关系、史源或游戏设定提出可核查的纠错和补充。',
    rule: '同时要求史源/时间线/建模等对象词与明确纠错、否定或补充句式；排除玩笑时间线、反讽“正史”和泛历史感叹。',
    test: (text) => isCanonAudit(text),
  },
  {
    id: 'canon_irony',
    label: '“这才是正史”反讽正典化',
    axis: 'relationship_affect',
    definition: '用“这才是正史”把萌化、CP或架空内容玩笑式提升为正典。',
    rule: '精确收取反讽句式；不能和认真历史纠错合并统计。',
    test: (text) => testRegex(/这才是正史|正史.{0,8}(?:萌|可爱)|(?:萌|可爱).{0,8}正史|三国志.{0,8}假的/g, text),
  },
  {
    id: 'voice_line_callback',
    label: '台词/名句回调',
    axis: 'knowledge_memory',
    definition: '引用武将台词、历史名句或已形成识别度的句式，作为评论区接梗。',
    rule: '仅纳入可明确识别的固定句式，避免把普通文言表达全部归类。',
    test: (text) => testRegex(/主公可无远志|奉孝在此|丞相何忧|老叟戏顽童|所有人立即复诵|文和何在|果篮无果|请君自采|一计不成又生一计|既惹事也怕事|天不生仲尼|此计伤不到我|兴复汉室|克复中原/g, text),
  },
  {
    id: 'interpretive_explanation',
    label: '角色动机解释/考据',
    axis: 'knowledge_memory',
    definition: '评论者尝试解释角色为何这样做、纠正叙事或给出历史/游戏因果。',
    rule: '必须同时包含角色识别与因果/分析句式。',
    test: (text) => testRegex(characterPattern, text) && testRegex(/因为|所以|主要|其实|说明|分析|历史上|原因|难怪|应该是|不是.*而是|意味着|可见/g, text),
  },
  {
    id: 'relationship_shipping',
    label: 'CP/关系线再叙事',
    axis: 'relationship_affect',
    definition: '显式用CP、磕、亲密关系或配对语言重写人物关系。',
    rule: '命中显式关系/嗑CP词，不把普通双角色同框自动算成CP。',
    test: (text) => testRegex(/cp|CP|嗑|磕到了|磕死|好配|官配|一对|夫妻|夫妇|老婆|老公|亲嘴|接吻|结婚|谈恋爱|爱情|情侣|小两口|白月光|修罗场/g, text),
  },
  {
    id: 'counter_shipping',
    label: 'CP单一化反对/关系边界',
    axis: 'boundary_friction',
    definition: '明确反对看见双角色就要求亲嘴、结婚，或质疑“礼貌投稿”的关系内容单一化。',
    rule: '只收指向CP生产方式的明确反对，不把普通“不嗑”自动判为对账号的负面评价。',
    test: (text) => testRegex(/只会嗑|看见一对男的.{0,12}(?:亲嘴|接吻|结婚|CP|cp)|礼貌投稿.{0,30}(?:哪有礼貌|不礼貌|礼貌在哪|除了亲嘴|除了接吻|除了结婚|只会)|除了爱情|强行.{0,5}(?:CP|cp)|不要.{0,8}(?:亲嘴|接吻|结婚)|别.{0,8}(?:亲嘴|接吻|结婚)/g, text),
  },
  {
    id: 'tragic_repair',
    label: '悲剧/遗憾记忆与反事实修复',
    axis: 'relationship_affect',
    definition: '围绕死亡、背叛、未曾相见、错过或“如果重来”等遗憾进行情感化重写。',
    rule: '角色语境与明确悲剧事件或“如果重来”的修复动作共现；排除“萌死了/笑死了”等程度补语和普通to签条件句。',
    test: (text) => {
      const value = String(text ?? '');
      if (!testRegex(characterPattern, value) || testRegex(/萌死了|美死了|笑死了|可爱死了|帅死了|甜死了|急死了|爱死了/g, value)) return false;
      const strongTragedy = /没骗过|唯独信了|背叛|去世|阵亡|遗憾|意难平|没见过|没能|来世|下辈子|刀死|泪目|兵变|身死|被杀|杀死/;
      const repairCondition = /(?:如果|要是|假如).{0,18}(?:没死|不死|活着|回来|重来|相遇|见到|救下|救活|没骗|信任|不背叛)/;
      return testRegex(strongTragedy, value) || testRegex(repairCondition, value);
    },
  },
  {
    id: 'cute_infantilization',
    label: '萌化/幼态化命名',
    axis: 'relationship_affect',
    definition: '把武将或卡宝称为宝宝、小朋友、乖乖等，弱化战争角色的威胁感。',
    rule: '命中可爱、萌、宝宝、小朋友、乖等幼态/宠物化词。',
    test: (text) => testRegex(/可爱|萌|宝宝|宝贝|小朋友|小盆友|乖乖|乖宝|崽崽|小狗|狗狗|小猫|猫猫|小熊|娃娃|幼崽|软乎|奶呼呼/g, text),
  },
  {
    id: 'protective_care',
    label: '守护/心疼型情感',
    axis: 'relationship_affect',
    definition: '以不能欺负、心疼、保护等语言进入角色关系，形成照护者位置。',
    rule: '命中保护、心疼、别欺负、抱抱等照护表达。',
    test: (text) => testRegex(/心疼|不能欺负|不许欺负|别欺负|保护|护着|抱抱|委屈|别哭|哄哄|宠着|舍不得|可怜/g, text),
  },
  {
    id: 'moral_personality_judgment',
    label: '角色性格/立场评判',
    axis: 'relationship_affect',
    definition: '以聪明、怕事、忠诚、坏、骗等人格词判断角色，而非只评价视频。',
    rule: '角色识别与人格/智力/忠奸判断共现。',
    test: (text) => testRegex(characterPattern, text) && testRegex(/聪明|智商|笨|坏|忠诚|忠心|野心|怕事|惹事|腹黑|善良|温柔|疯|傲|骗|信任|心软|狠|怂/g, text),
  },
  {
    id: 'role_address_play',
    label: '角色直呼/入戏互动',
    axis: 'participatory_practice',
    definition: '评论者直接呼叫角色或以主公、丞相等角色称谓进入戏内说话位置。',
    rule: '角色/称谓出现在句首并紧接停顿或请求语气；或使用臣、末将等入戏称谓。',
    test: (text) => testRegex(/^(?:卡宝|曹操|阿瞒|郭嘉|奉孝|姜维|伯约|钟会|周瑜|公瑾|孙策|孙笨|贾诩|文和|荀彧|司马昭|曹髦|赵云|子龙|诸葛亮|孔明|刘备|备备)[，,:：呀啊呢]|主公[，,:：]|丞相[，,:：]|臣(?:请|以为|领命)|末将/g, String(text).trim()),
  },
  {
    id: 'submission_ritual',
    label: '“礼貌投稿”仪式',
    axis: 'participatory_practice',
    definition: '用固定的“礼貌投稿”格式向创作者提交剧情设想。',
    rule: '精确命中“礼貌投稿”，重复文案仍保留为参与行为并单独统计模板复制。',
    test: (text) => testRegex(/礼貌投稿/g, text),
  },
  {
    id: 'tosign_ritual',
    label: 'to签奖励仪式',
    axis: 'participatory_practice',
    definition: '围绕to签形成评论任务、身份确认与奖励期待。',
    rule: '命中to签/TO签，不推定其购买意向。',
    test: (text) => testRegex(/to\s*签/gi, text),
  },
  {
    id: 'continuation_request',
    label: '追更/点题/续写请求',
    axis: 'participatory_practice',
    definition: '要求下一集、某角色或某关系继续出现。',
    rule: '命中更新、下集、多发点、想看等明确内容请求。',
    test: (text) => testRegex(/催更|更新|下一集|下集|续集|快更|赶紧更|多发点|多拍点|还想看|我要看|想看.*(?:小剧场|剧情|他们|他俩|她俩)|什么时候更|安排一下/g, text),
  },
  {
    id: 'knowledge_threshold_question',
    label: '知识门槛/身份求解',
    axis: 'boundary_friction',
    definition: '明确表示看不懂、询问角色/梗/游戏身份或自述缺少三国杀经验。',
    rule: '只收“看不懂/什么梗/这是谁/没玩过”等明确知识缺口；普通“为什么/为啥”归到剧情互动追问。',
    test: (text) => {
      const value = String(text ?? '');
      if (testRegex(/你又是谁的部将|茅房.{0,8}是谁|蹲.{0,8}是谁|里面.{0,8}是谁/g, value)) return false;
      return testRegex(/看不懂|没看懂|(?:这个|这是|这什么|啥)(?:意思|梗)|什么梗|这是啥(?:游戏|角色|武将|技能)|这是什么(?:游戏|角色|武将|技能)|这是谁|(?:这个|那个|这位|大宝|红毛丹|蓝帽子|戴蓝帽子的|红头发的|小乐乐|贝蒂小熊).{0,6}是谁啊?|求解释|解释一下|没玩过(?:三国杀)?|不玩三国杀|云玩家/gu, value);
    },
  },
  {
    id: 'narrative_interaction_question',
    label: '剧情/互动追问',
    axis: 'participatory_practice',
    definition: '围绕角色动作、剧情发展或创作者选择发问，反映参与而非必然的知识门槛。',
    rule: '收取“为什么/为啥/怎么”等一般追问，并排除已经命中明确知识缺口的文本。',
    test: (text) => !testRegex(/看不懂|没看懂|(?:这个|这是|这什么|啥)(?:意思|梗)|什么梗|这是谁|求解释|没玩过(?:三国杀)?|不玩三国杀|云玩家/g, text) && testRegex(/为什么|为啥|怎么(?:了|回事|会|能|又|还)|发生了什么|后来呢|然后呢/g, text),
  },
  {
    id: 'outsider_self_identification',
    label: '圈外/非玩家自我识别',
    axis: 'boundary_friction',
    definition: '评论者明确自述不玩三国杀或是圈外人，同时表达观看、喜欢、购买或求识别。',
    rule: '只收明确自我身份句；普通“这是谁/什么游戏”只算识别问题，不自动推断圈外身份。',
    test: (text) => testRegex(/我(?:一个)?不玩三国杀|圈外人|我圈外|虽然不玩三国杀|没玩过三国杀.{0,15}(?:喜欢|可爱|看完|想买|愿意买)|不玩三国杀.{0,15}(?:喜欢|可爱|看完|想买|愿意买)/g, text),
  },
  {
    id: 'official_identity_confusion',
    label: '官方/同人身份混淆',
    axis: 'boundary_friction',
    definition: '询问或惊讶账号是否为官方、游卡旗下或独立同人创作。',
    rule: '收取官方与同人身份的明确判断/疑问；不把普通“官方”一词全部纳入。',
    test: (text) => testRegex(/你(?:真)?是.{0,8}官方|这是.{0,5}官方|才知道.{0,8}官方|以为.{0,8}(?:独立同人|同人二创)|官方.{0,8}狗卡.{0,8}关系|所以.{0,8}官方.{0,8}狗卡/g, text),
  },
  {
    id: 'ai_quality_rights',
    label: 'AI质量/原创与权利问询',
    axis: 'boundary_friction',
    definition: '围绕AI制作质量、穿模、搬运、原创性或侵权提出疑问和批评。',
    rule: '低量级预警；命中并不等于已经形成舆情，需逐条复核指向。',
    test: (text) => testRegex(/(?:用|这个|这段|视频|制作).{0,5}(?:AI|ai)|AI制作|ai生成|人工智能|穿模|搬运|侵权|原创/g, text),
  },
  {
    id: 'merchandise_intent',
    label: '周边实物化诉求',
    axis: 'product_boundary',
    definition: '希望卡宝或武将形象被做成玩偶、毛绒、表情包等可拥有物。',
    rule: '命中具体周边品类或“出周边”；不自动等同付费。',
    test: (text) => testRegex(/周边|玩偶|毛绒|公仔|手办|盲盒|挂件|钥匙扣|吧唧|徽章|立牌|抱枕|贴纸|表情包|实体娃娃/g, text),
  },
  {
    id: 'strict_purchase_intent',
    label: '近购买意向下限',
    axis: 'product_boundary',
    definition: '明确说想买、必买或询问购买渠道，或催促具体周边品类推出。',
    rule: '严格正则；是意向下限，不是销量预测。',
    test: (text) => testRegex(/想买|必买|肯定买|我要买|在哪里买|(?:什么时候|啥时候|何时|快点|赶紧|求|能不能).{0,8}(?:出|做).{0,8}(?:周边|玩偶|表情包|毛绒|公仔|手办|盲盒)/g, text),
  },
  {
    id: 'price_sensitivity',
    label: '价格带敏感',
    axis: 'product_boundary',
    definition: '明确提到价格、太贵、便宜或可接受价位。',
    rule: '命中价格词；样本小，只能支持价位测试。',
    test: (text) => testRegex(/价格|太贵|别太贵|不要太贵|便宜|多少钱|价位|定价/g, text),
  },
  {
    id: 'mascot_identity_question',
    label: '卡宝物种/身份识别',
    axis: 'product_boundary',
    definition: '把卡宝当作狗、熊等萌物讨论，或直接询问它是什么。',
    rule: '只收卡宝与物种/身份疑问在同一句共现，或直接问“这是啥狗/什么动物”；不把角色宠物化称呼自动算成卡宝身份识别。',
    test: (text) => testRegex(/卡宝.{0,8}(?:是什么|是啥)(?:动物|狗|品种|物种|东西)|卡宝.{0,8}原型.{0,6}(?:是什么|是啥)|(?:什么动物|什么狗|啥品种|什么品种|什么物种).{0,8}卡宝|这是啥狗|这是什么动物|这是啥动物/g, text),
  },
  {
    id: 'content_boundary_rejection',
    label: '内容边界/明确拒斥',
    axis: 'product_boundary',
    definition: '明确表示只想看三国小剧场、不要卡宝或不喜欢当前方向。',
    rule: '只收明显拒斥或替换诉求，不把玩笑式“丑”自动判负面。',
    test: (text) => testRegex(/我(?:不想|不要)看.{0,16}卡宝|我要看三国小剧场.{0,24}(?:不想|不要).{0,12}卡宝|我只想看.{0,16}(?:三国|武将).{0,8}小剧场|别再发.{0,12}卡宝|不要再发.{0,12}卡宝/g, text),
  },
  {
    id: 'accessibility_request',
    label: '字幕/静音可达性',
    axis: 'product_boundary',
    definition: '在静音、听力或环境限制下请求字幕。',
    rule: '命中字幕、静音或听不清；低频但改进成本低。',
    test: (text) => testRegex(/字幕|静音.*看|听不清|听不到|声音太小/g, text),
  },
];

const STRICT_KNOWLEDGE_CODES = ['courtesy_nickname', 'mechanic_remap_validation', 'game_economy_memory', 'historical_intertext', 'canon_audit', 'voice_line_callback', 'interpretive_explanation'];

const AXIAL_CATEGORIES = [
  { id: 'persona_governance', label: '人格化社群治理', codes: ['mascot_persona_reference', 'community_address', 'publisher_pun_grievance'] },
  { id: 'ip_context_reference', label: '角色/IP语境命中', codes: ['character_recognition', 'courtesy_nickname', 'game_system_jargon', 'mechanic_remap_validation', 'game_economy_memory', 'historical_intertext', 'canon_audit', 'voice_line_callback', 'interpretive_explanation'] },
  { id: 'relational_dramaturgy', label: '关系戏剧化', codes: ['relationship_shipping', 'canon_irony', 'tragic_repair', 'moral_personality_judgment'] },
  { id: 'affective_mascot', label: '萌化与照护', codes: ['cute_infantilization', 'protective_care', 'mascot_identity_question'] },
  { id: 'community_coauthorship', label: '评论区共创', codes: ['role_address_play', 'submission_ritual', 'tosign_ritual', 'continuation_request', 'narrative_interaction_question'] },
  { id: 'tangible_conversion', label: '情感对象实物化', codes: ['merchandise_intent', 'strict_purchase_intent', 'price_sensitivity'] },
  { id: 'boundary_friction', label: '理解与内容边界', codes: ['knowledge_threshold_question', 'outsider_self_identification', 'official_identity_confusion', 'ai_quality_rights', 'counter_shipping', 'content_boundary_rejection', 'accessibility_request'] },
];

const PAIRS = [
  { id: 'jiang_wei_zhong_hui', label: '姜维 / 伯约 × 钟会', left: /姜维|伯约/, right: /钟会|士季/ },
  { id: 'zhou_yu_sun_ce', label: '周瑜 / 公瑾 × 孙策 / 孙笨', left: /周瑜|公瑾|大嘟嘟|嘟嘟/, right: /孙策|孙笨|伯符/ },
  { id: 'guo_jia_cao_cao', label: '郭嘉 / 奉孝 × 曹操 / 阿瞒', left: /郭嘉|奉孝|嘉嘉/, right: /曹操|阿瞒/ },
  { id: 'cao_cao_xun_yu', label: '曹操 / 阿瞒 × 荀彧 / 荀令君', left: /曹操|阿瞒/, right: /荀彧|文若|荀令君|令君/ },
  { id: 'guo_jia_xi_zhi_cai', label: '郭嘉 / 奉孝 × 戏志才', left: /郭嘉|奉孝|嘉嘉/, right: /戏志才|志才/ },
  { id: 'jia_xu_zhang_xiu', label: '贾诩 / 文和 × 张绣', left: /贾诩|文和/, right: /张绣/ },
  { id: 'sima_zhao_cao_mao', label: '司马昭 × 曹髦', left: /司马昭|小昭昭/, right: /曹髦|小髦髦/ },
  { id: 'cao_pi_cao_zhi', label: '曹丕 × 曹植', left: /曹丕|子桓/, right: /曹植|子建/ },
];

const TITLE_ARCHETYPES = [
  { id: 'series', label: '连续剧集编号', description: '标题含“第N集”，承诺连续世界观。', test: (title) => /第\s*\d+\s*集/.test(title) },
  { id: 'dialogue', label: '角色对白式标题', description: '用冒号把角色与台词直接推到前景。', test: (title) => /[：:]/.test(title) },
  { id: 'relationship_scene', label: '双角色/群像关系戏', description: '标题中出现至少两个已识别角色组。', test: (title) => CHARACTER_GROUPS.filter((group) => [...group.canonical, ...group.aliases].some((name) => title.includes(name))).length >= 2 },
  { id: 'historical_callback', label: '典故/历史回调', description: '标题直接调用历史典故、角色生平或文言句式。', test: (title) => /果篮无果|请君自采|文和何在|七步|托孤|北伐|三顾|隆中|夷陵|官渡|赤壁|白帝|兴复|乱世|请君|何在|无果/.test(title) },
  { id: 'game_system', label: '游戏规则/玩家体验', description: '标题借技能、版本、抽盒或玩法系统制造笑点。', test: (title) => /技能|武将|卖血|铁骑|雄乱|放逐|屯田|开盒|爆率|斗地主|排位|主公|忠臣|内奸|觉醒|摸牌|卡牌|三国杀盒子|(?:界|谋|势|神)[曹刘孙司郭姜钟邓马魏荀贾张赵周吕夏诸徐文]/.test(title) },
  { id: 'modern_transplant', label: '现代生活移植', description: '把武将放入职场、消费或日常生活场景。', test: (title) => /上班|职场|工作|老板|工资|房地产|出租|娃娃机|外卖|奶茶|汉堡|手机|游戏机|甲方|开会|同事|免费|积木/.test(title) },
  {
    id: 'mascot_showcase',
    label: '卡宝本体展示',
    description: '标题正文聚焦卡宝本体，且未出现具体武将名；统一话题标签不计入判断。',
    test: (title) => {
      const body = String(title ?? '').replace(/#[^\s#]+/gu, '');
      return /卡宝/.test(body) && !testRegex(characterPattern, body);
    },
  },
];

const rawComments = parseCsv(fs.readFileSync(commentsPath, 'utf8'));
const rawVideoRows = parseCsv(fs.readFileSync(videosPath, 'utf8'));
const sourceManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const metadataByVideo = readMetadata(metadataDir);

const comments = rawComments.map((comment) => {
  // Code the same de-identified text that is later exported as evidence.
  const sourceText = String(comment['评论内容'] ?? '').trim();
  const text = deidentifyText(sourceText).trim();
  const rawOpenCodes = sourceText ? OPEN_CODES.filter((code) => code.test(sourceText, comment)).map((code) => code.id) : [];
  const openCodes = text ? OPEN_CODES.filter((code) => code.test(text, comment)).map((code) => code.id) : [];
  const axialCodes = AXIAL_CATEGORIES.filter((axis) => axis.codes.some((code) => openCodes.includes(code))).map((axis) => axis.id);
  return {
    ...comment,
    _text: text,
    _normalized: normalizeText(text),
    _likes: number(comment['评论点赞数']),
    _user: userKey(comment),
    _openCodes: openCodes,
    _axialCodes: axialCodes,
    _sanitized: sourceText !== text,
    _codesRemovedBySanitization: rawOpenCodes.filter((code) => !openCodes.includes(code)),
  };
});

const codingInputAudit = (() => {
  const removedCodeCounts = new Map();
  let codeAssignmentsRemovedBySanitization = 0;
  let commentsWithCodesRemoved = 0;
  for (const comment of comments) {
    if (comment._codesRemovedBySanitization.length) commentsWithCodesRemoved += 1;
    codeAssignmentsRemovedBySanitization += comment._codesRemovedBySanitization.length;
    for (const code of comment._codesRemovedBySanitization) {
      removedCodeCounts.set(code, (removedCodeCounts.get(code) ?? 0) + 1);
    }
  }
  return {
    commentsChangedBySanitization: comments.filter((comment) => comment._sanitized).length,
    commentsWithCodesRemoved,
    codeAssignmentsRemovedBySanitization,
    removedCodeCounts: Object.fromEntries([...removedCodeCounts.entries()].sort((a, b) => b[1] - a[1])),
  };
})();

const commentsByVideo = new Map();
for (const comment of comments) {
  const videoId = String(comment['所属视频ID']);
  if (!commentsByVideo.has(videoId)) commentsByVideo.set(videoId, []);
  commentsByVideo.get(videoId).push(comment);
}

const videos = rawVideoRows.map((row) => {
  const id = String(row['视频ID']);
  const metadata = metadataByVideo.get(id) ?? {};
  const videoComments = commentsByVideo.get(id) ?? [];
  const title = String(row['视频标题']);
  const nonEmpty = videoComments.filter((comment) => comment._text);
  const contextReferenceComments = nonEmpty.filter((comment) => comment._axialCodes.includes('ip_context_reference'));
  const strictKnowledgeComments = nonEmpty.filter((comment) => STRICT_KNOWLEDGE_CODES.some((code) => comment._openCodes.includes(code)));
  const relationshipComments = nonEmpty.filter((comment) => comment._axialCodes.includes('relational_dramaturgy'));
  const coauthorComments = nonEmpty.filter((comment) => comment._axialCodes.includes('community_coauthorship'));
  return {
    id,
    title,
    url: row['视频URL'],
    capturedComments: number(row['实际采集评论数']),
    declaredComments: number(row['声明评论数']),
    roots: number(row['根评论数']),
    replies: number(row['回复数']),
    status: row['完整性状态'],
    likes: number(metadata.video_likes),
    collects: number(metadata.video_collects),
    shares: number(metadata.video_shares),
    nonEmptyComments: nonEmpty.length,
    commentLikes: sum(videoComments, (comment) => comment._likes),
    contextReferenceComments: contextReferenceComments.length,
    strictKnowledgeComments: strictKnowledgeComments.length,
    relationshipComments: relationshipComments.length,
    coauthorComments: coauthorComments.length,
    contextReferenceShare: nonEmpty.length ? contextReferenceComments.length / nonEmpty.length : 0,
    strictKnowledgeShare: nonEmpty.length ? strictKnowledgeComments.length / nonEmpty.length : 0,
    relationshipShare: nonEmpty.length ? relationshipComments.length / nonEmpty.length : 0,
    coauthorShare: nonEmpty.length ? coauthorComments.length / nonEmpty.length : 0,
    archetypes: TITLE_ARCHETYPES.filter((archetype) => archetype.test(title)).map((archetype) => archetype.id),
  };
});

function metricForComments(items) {
  const roots = items.filter((comment) => comment['关系类型'] === '根评论');
  const replies = items.filter((comment) => String(comment['关系类型']).startsWith('回复'));
  return {
    comments: items.length,
    users: new Set(items.map((comment) => comment._user).filter(Boolean)).size,
    videos: new Set(items.map((comment) => String(comment['所属视频ID']))).size,
    likes: sum(items, (comment) => comment._likes),
    averageLikes: mean(items.map((comment) => comment._likes)),
    rootComments: roots.length,
    replies: replies.length,
    authorComments: items.filter((comment) => comment['是否视频作者'] === 'true').length,
  };
}

function compactQuote(comment) {
  if (!comment) return null;
  return {
    commentId: comment['评论ID'],
    text: truncate(comment._text, 220),
    likes: comment._likes,
    type: comment['关系类型'],
    author: comment['是否视频作者'] === 'true',
    authorReplied: comment['视频作者是否回复'] === 'true',
    videoId: String(comment['所属视频ID']),
    videoTitle: truncate(comment['所属视频标题'], 100),
    videoUrl: comment['所属视频URL'],
    openCodes: comment._openCodes,
  };
}

function representativeQuotes(items, maximum = 5) {
  const usedTexts = new Set();
  const usedVideos = new Set();
  const result = [];
  const ordered = [...items].filter((comment) => comment._text).sort((left, right) => right._likes - left._likes || left._text.length - right._text.length);
  for (const comment of ordered) {
    if (usedTexts.has(comment._normalized)) continue;
    const videoId = String(comment['所属视频ID']);
    if (usedVideos.has(videoId) && result.length < Math.ceil(maximum / 2)) continue;
    result.push(compactQuote(comment));
    usedTexts.add(comment._normalized);
    usedVideos.add(videoId);
    if (result.length >= maximum) break;
  }
  return result;
}

const nonEmptyComments = comments.filter((comment) => comment._text);
const rootComments = comments.filter((comment) => comment['关系类型'] === '根评论');
const replyComments = comments.filter((comment) => String(comment['关系类型']).startsWith('回复'));
const audienceComments = comments.filter((comment) => comment['是否视频作者'] !== 'true');

const openCodeMetrics = OPEN_CODES.map((code) => {
  const matched = nonEmptyComments.filter((comment) => comment._openCodes.includes(code.id));
  return { ...code, test: undefined, ...metricForComments(matched), shareOfNonEmpty: matched.length / nonEmptyComments.length, quotes: representativeQuotes(matched, 6) };
});

const axialMetrics = AXIAL_CATEGORIES.map((axis) => {
  const matched = nonEmptyComments.filter((comment) => comment._axialCodes.includes(axis.id));
  return { ...axis, ...metricForComments(matched), shareOfNonEmpty: matched.length / nonEmptyComments.length, quotes: representativeQuotes(matched, 6) };
});

const openCodeById = Object.fromEntries(openCodeMetrics.map((metric) => [metric.id, metric]));
const axialById = Object.fromEntries(axialMetrics.map((metric) => [metric.id, metric]));
const strictKnowledgeComments = nonEmptyComments.filter((comment) => STRICT_KNOWLEDGE_CODES.some((code) => comment._openCodes.includes(code)));
const strictKnowledgeMetric = {
  id: 'strict_player_context_decoding',
  label: '严格圈层解码',
  codes: STRICT_KNOWLEDGE_CODES,
  ...metricForComments(strictKnowledgeComments),
  shareOfNonEmpty: strictKnowledgeComments.length / nonEmptyComments.length,
  quotes: representativeQuotes(strictKnowledgeComments, 8),
};

function depthLevel(comment) {
  if (!comment._text) return 'empty';
  const codes = new Set(comment._openCodes);
  if (['strict_purchase_intent', 'merchandise_intent', 'continuation_request', 'submission_ritual'].some((code) => codes.has(code))) return 'action';
  if (['relationship_shipping', 'tragic_repair', 'protective_care', 'role_address_play', 'tosign_ritual'].some((code) => codes.has(code))) return 'co_creation';
  if (STRICT_KNOWLEDGE_CODES.some((code) => codes.has(code))) return 'intertext';
  if (codes.has('character_recognition') || codes.has('game_system_jargon') || codes.has('cute_infantilization') || codes.has('mascot_identity_question')) return 'recognition';
  return 'reaction';
}

const depthDefinitions = [
  { id: 'reaction', label: 'L0 即时反应', interpretation: '未命中角色/知识/参与编码，多为短回应、表情或普通评价。' },
  { id: 'recognition', label: 'L1 角色或萌物识别', interpretation: '点名武将、卡宝物种或表达萌感。' },
  { id: 'intertext', label: 'L2 圈层互文', interpretation: '调用表字、技能、历史、台词或因果解释。' },
  { id: 'co_creation', label: 'L3 关系共创', interpretation: 'CP、守护、悲剧修复、角色入戏或to签仪式。' },
  { id: 'action', label: 'L4 行动请求', interpretation: '投稿、追更、周边或明确购买意向。' },
];
const depthMetrics = depthDefinitions.map((definition) => {
  const matched = nonEmptyComments.filter((comment) => depthLevel(comment) === definition.id);
  return { ...definition, ...metricForComments(matched), shareOfNonEmpty: matched.length / nonEmptyComments.length };
});

const codeCooccurrences = new Map();
for (const comment of nonEmptyComments) {
  const codes = [...new Set(comment._openCodes)].sort();
  for (let left = 0; left < codes.length; left += 1) {
    for (let right = left + 1; right < codes.length; right += 1) {
      const key = `${codes[left]}|${codes[right]}`;
      codeCooccurrences.set(key, (codeCooccurrences.get(key) ?? 0) + 1);
    }
  }
}
const topCooccurrences = [...codeCooccurrences.entries()]
  .map(([key, count]) => {
    const [left, right] = key.split('|');
    return { left, right, leftLabel: openCodeById[left].label, rightLabel: openCodeById[right].label, comments: count };
  })
  .sort((left, right) => right.comments - left.comments)
  .slice(0, 16);

const pairMetrics = PAIRS.map((pair) => {
  const matched = nonEmptyComments.filter((comment) => testRegex(pair.left, comment._text) && testRegex(pair.right, comment._text));
  const shipping = matched.filter((comment) => comment._openCodes.includes('relationship_shipping'));
  const titleVideos = videos.filter((video) => testRegex(pair.left, video.title) && testRegex(pair.right, video.title));
  return {
    id: pair.id,
    label: pair.label,
    ...metricForComments(matched),
    explicitShippingComments: shipping.length,
    titleVideos: titleVideos.length,
    titleVideoComments: sum(titleVideos, (video) => video.capturedComments),
    quotes: representativeQuotes(matched, 5),
  };
}).sort((left, right) => right.comments - left.comments || right.likes - left.likes);

const characterMetrics = CHARACTER_GROUPS.map((group) => {
  const pattern = new RegExp([...group.canonical, ...group.aliases].sort((a, b) => b.length - a.length).join('|'));
  const matched = nonEmptyComments.filter((comment) => testRegex(pattern, comment._text));
  const titleVideos = videos.filter((video) => testRegex(pattern, video.title));
  const commentsUnderTitleExposure = matched.filter((comment) => titleVideos.some((video) => video.id === String(comment['所属视频ID'])));
  return {
    id: group.id,
    label: group.label,
    ...metricForComments(matched),
    titleVideos: titleVideos.length,
    titleVideoComments: sum(titleVideos, (video) => video.capturedComments),
    mentionsUnderTitleExposure: commentsUnderTitleExposure.length,
    mentionsOutsideTitleExposure: matched.length - commentsUnderTitleExposure.length,
  };
}).filter((item) => item.comments || item.titleVideos).sort((left, right) => right.comments - left.comments || right.likes - left.likes);

const archetypeMetrics = TITLE_ARCHETYPES.map((archetype) => {
  const matched = videos.filter((video) => video.archetypes.includes(archetype.id));
  return {
    id: archetype.id,
    label: archetype.label,
    description: archetype.description,
    videos: matched.length,
    capturedComments: sum(matched, (video) => video.capturedComments),
    medianComments: median(matched.map((video) => video.capturedComments)),
    averageComments: mean(matched.map((video) => video.capturedComments)),
    medianShares: median(matched.map((video) => video.shares)),
    examples: [...matched].sort((left, right) => right.capturedComments - left.capturedComments).slice(0, 4).map((video) => ({ id: video.id, title: video.title, url: video.url, comments: video.capturedComments })),
  };
});

const contextDenseVideos = [...videos]
  .filter((video) => video.nonEmptyComments >= 25)
  .sort((left, right) => right.strictKnowledgeShare - left.strictKnowledgeShare || right.capturedComments - left.capturedComments)
  .slice(0, 12)
  .map((video) => ({
    id: video.id,
    title: video.title,
    url: video.url,
    comments: video.capturedComments,
    nonEmptyComments: video.nonEmptyComments,
    contextReferenceComments: video.contextReferenceComments,
    contextReferenceShare: video.contextReferenceShare,
    strictKnowledgeComments: video.strictKnowledgeComments,
    strictKnowledgeShare: video.strictKnowledgeShare,
    relationshipShare: video.relationshipShare,
    coauthorShare: video.coauthorShare,
    archetypes: video.archetypes,
  }));

const duplicateMap = new Map();
for (const comment of nonEmptyComments) {
  if (comment._normalized.length < 4) continue;
  if (!duplicateMap.has(comment._normalized)) duplicateMap.set(comment._normalized, []);
  duplicateMap.get(comment._normalized).push(comment);
}

function hasMeaningfulEvidenceText(value) {
  const content = String(value ?? '')
    .replace(/@用户/gu, '')
    .replace(/\[[^\]]+\]/gu, '')
    .replace(/[\s'".,，。！？?!、：:；;~～\-_/\\()（）]+/gu, '');
  return content.length >= 2;
}

const repeatedFormulas = [...duplicateMap.values()]
  .filter((items) => items.length >= 3 && hasMeaningfulEvidenceText(items[0]._text))
  .map((items) => ({
    text: truncate(deidentifyText(items[0]._text), 120),
    comments: items.length,
    users: new Set(items.map((comment) => comment._user)).size,
    videos: new Set(items.map((comment) => comment['所属视频ID'])).size,
    likes: sum(items, (comment) => comment._likes),
    codeIds: [...new Set(items.flatMap((comment) => comment._openCodes))],
  }))
  .sort((left, right) => right.comments - left.comments || right.likes - left.likes)
  .slice(0, 18);

const commentById = new Map(comments.map((comment) => [String(comment['评论ID']), comment]));
const threadByRoot = new Map();
for (const comment of comments) {
  const rootId = String(comment['线程根评论ID'] || comment['评论ID']);
  if (!threadByRoot.has(rootId)) threadByRoot.set(rootId, []);
  threadByRoot.get(rootId).push(comment);
}

function threadCase(label, pattern, interpretation) {
  const anchor = [...nonEmptyComments]
    .filter((comment) => testRegex(pattern, comment._text))
    .sort((left, right) => right._likes - left._likes)[0];
  if (!anchor) return null;
  const rootId = String(anchor['线程根评论ID'] || anchor['评论ID']);
  const root = commentById.get(rootId) ?? anchor;
  const replies = (threadByRoot.get(rootId) ?? [])
    .filter((comment) => String(comment['评论ID']) !== rootId && hasMeaningfulEvidenceText(comment._text))
    .sort((left, right) => right._likes - left._likes || String(left['评论时间']).localeCompare(String(right['评论时间'])))
    .slice(0, 8);
  return {
    label,
    interpretation,
    videoId: String(root['所属视频ID']),
    videoTitle: root['所属视频标题'],
    videoUrl: root['所属视频URL'],
    root: compactQuote(root),
    replies: replies.map(compactQuote),
    threadSize: (threadByRoot.get(rootId) ?? []).length,
  };
}

const threadCases = [
  threadCase('萌物成为圈层入口', /全网三国杀唯一可爱之物/, '“唯一可爱之物”同时是夸赞与玩家式反讽：卡宝被放在整个三国杀经验中比较，而非脱离游戏单独卖萌。'),
  threadCase('角色台词式接梗', /主公可无远志/, '短句依赖角色关系与既有台词记忆，圈内人可以用极少文字完成识别。'),
  threadCase('历史悲剧的关系化修复', /姜维没骗过人.*钟会|唯独信了姜维/, '评论把复杂历史结局压缩成“唯一一次欺骗/信任”，形成高传播的关系叙事。'),
  threadCase('投稿仪式把观众变成编剧', /礼貌投稿[：:].*孙策.*周瑜|礼貌投稿[：:].*周瑜.*孙策/, '固定格式降低提案门槛；高赞使“想看什么”成为可见的公共议程。'),
  threadCase('玩家经济经验迁移', /娃娃机爆率.*三国杀开盒子|开盒子的爆率/, '现实娃娃机被玩家用游戏开盒概率解释，说明笑点来自跨场景的共同挫折记忆。'),
  threadCase('情感对象向实物迁移', /武将玩偶.*必买|出周边.*肯定买/, '购买表达建立在角色萌化之后，但评论意向仍需通过预约或定金验证。'),
  threadCase('内容方向存在真实分歧', /我不想看你这个卡宝|我要看三国小剧场/, '卡宝本体展示并非对所有人都成立；一部分受众把账号价值锚定在武将小剧场。'),
].filter(Boolean);

const coverage = {
  videos: videos.length,
  comments: comments.length,
  nonEmptyComments: nonEmptyComments.length,
  roots: rootComments.length,
  replies: replyComments.length,
  audienceComments: audienceComments.length,
  uniqueUsers: new Set(comments.map((comment) => comment._user).filter(Boolean)).size,
  uniqueAudienceUsers: new Set(audienceComments.map((comment) => comment._user).filter(Boolean)).size,
  declaredComments: sum(videos, (video) => video.declaredComments),
  capturedComments: sum(videos, (video) => video.capturedComments),
  sourceCoverage: sum(videos, (video) => video.capturedComments) / sum(videos, (video) => video.declaredComments),
  metadataRecords: metadataByVideo.size,
  videoFilesPresent: fs.existsSync(path.join(sourceDir, 'videos')) ? fs.readdirSync(path.join(sourceDir, 'videos')).length : 0,
};

const rootIdsWithReplies = new Set(replyComments.map((comment) => String(comment['线程根评论ID'] || '')));
const likeValues = comments.map((comment) => comment._likes);
const authorRootComments = rootComments.filter((comment) => comment['是否视频作者'] !== 'true');

function codeMetric(id) {
  return openCodeById[id];
}

function rootReplyAssociation(items) {
  const audienceRoots = items.filter((comment) => comment['关系类型'] === '根评论' && comment['是否视频作者'] !== 'true');
  const authorReplied = audienceRoots.filter((comment) => comment['视频作者是否回复'] === 'true');
  return { roots: audienceRoots.length, authorRepliedRoots: authorReplied.length, authorReplyRate: audienceRoots.length ? authorReplied.length / audienceRoots.length : 0 };
}

const personaSignals = {
  mascot: {
    ...codeMetric('mascot_persona_reference'),
    audienceComments: nonEmptyComments.filter((comment) => comment._openCodes.includes('mascot_persona_reference') && comment['是否视频作者'] !== 'true').length,
    authorComments: nonEmptyComments.filter((comment) => comment._openCodes.includes('mascot_persona_reference') && comment['是否视频作者'] === 'true').length,
    ...rootReplyAssociation(nonEmptyComments.filter((comment) => comment._openCodes.includes('mascot_persona_reference'))),
  },
  communityAddress: {
    ...codeMetric('community_address'),
    audienceComments: nonEmptyComments.filter((comment) => comment._openCodes.includes('community_address') && comment['是否视频作者'] !== 'true').length,
    authorComments: nonEmptyComments.filter((comment) => comment._openCodes.includes('community_address') && comment['是否视频作者'] === 'true').length,
  },
  dogka: {
    ...codeMetric('publisher_pun_grievance'),
    audienceComments: nonEmptyComments.filter((comment) => comment._openCodes.includes('publisher_pun_grievance') && comment['是否视频作者'] !== 'true').length,
    authorComments: nonEmptyComments.filter((comment) => comment._openCodes.includes('publisher_pun_grievance') && comment['是否视频作者'] === 'true').length,
    ...rootReplyAssociation(nonEmptyComments.filter((comment) => comment._openCodes.includes('publisher_pun_grievance'))),
  },
};

const exactToSignComments = nonEmptyComments.filter((comment) => /to签/i.test(comment._text));
const submissionComments = nonEmptyComments.filter((comment) => comment._openCodes.includes('submission_ritual'));
const intimateSubmissionComments = submissionComments.filter((comment) => /亲嘴|接吻|结婚|人工呼吸/.test(comment._text));
const toSignCharacterNamed = exactToSignComments.filter((comment) => testRegex(characterPattern, comment._text));
const interactionSignals = {
  engagementDistribution: {
    totalLikes: sum(comments, (comment) => comment._likes),
    medianLikes: median(likeValues),
    p95Likes: quantile(likeValues, 0.95),
    p99Likes: quantile(likeValues, 0.99),
  },
  threadParticipation: {
    rootsWithReplies: rootIdsWithReplies.size,
    rate: rootComments.length ? rootIdsWithReplies.size / rootComments.length : 0,
  },
  authorRootReplyRate: authorRootComments.length ? authorRootComments.filter((comment) => comment['视频作者是否回复'] === 'true').length / authorRootComments.length : 0,
  submission: {
    ...metricForComments(submissionComments),
    intimateComments: intimateSubmissionComments.length,
    intimateShare: submissionComments.length ? intimateSubmissionComments.length / submissionComments.length : 0,
    normalizedUniqueTexts: new Set(submissionComments.map((comment) => comment._normalized)).size,
  },
  toSignExact: {
    ...metricForComments(exactToSignComments),
    characterNamedComments: toSignCharacterNamed.length,
    characterNamedShare: exactToSignComments.length ? toSignCharacterNamed.length / exactToSignComments.length : 0,
    ...rootReplyAssociation(exactToSignComments),
  },
};

const summary = {
  generatedAt: new Date().toISOString(),
  methodology: {
    approach: '全量透明规则编码 + 高风险编码定向审阅 + 原始线程复核的计算辅助扎根式内容分析',
    analysisUnit: '单条评论；以视频标题和线程关系作为上下文',
    codingInput: '先去除回复前缀、统一@提及并掩码身份证/长数字，再执行全部规则编码；分类输入与导出的证据文本一致。',
    coreCategory: '卡宝以萌系关系短剧承接角色/IP语境；其中一部分评论继续将机制、历史和台词解释为“第二字幕”，再通过账号人格、to签回馈与礼貌投稿把观看转成共同创作。',
    evidenceBoundary: '分类为透明词表与语义规则的可复核下限，不等同人工逐条判读，也不声称理论饱和或编码者一致性；数据无视频文件，因此不含画面/声音逐帧编码。',
    ruleAudit: [
      { initialCode: '关系边界', initialCandidates: 22, issue: '裸“礼貌在哪”大量来自非CP语境', revision: '要求与亲嘴、结婚、CP或礼貌投稿批评共现' },
      { initialCode: '求解释/语境门槛', initialCandidates: 208, issue: '普通“为什么/为啥”多为剧情互动', revision: '拆成知识门槛与剧情/互动追问' },
      { initialCode: '卡宝物种/身份', initialCandidates: 197, issue: '小狗、小熊常只是角色萌化', revision: '要求卡宝与物种/身份疑问共现' },
      { initialCode: '悲剧修复', initialCandidates: 52, issue: 'to签条件句及“萌死了”程度补语混入', revision: '要求明确悲剧事件或修复条件，并排除程度补语' },
      { initialCode: '史实/设定认真校验', initialCandidates: 37, issue: '时间线玩笑、“致敬”梗和泛历史感叹混入', revision: '要求史源/对象词与纠错、否定或补充标记同时出现，并排除玩笑式时间线' },
    ],
  },
  source: {
    directory: sourceDir,
    accountName: sourceManifest.account_name,
    douyinId: sourceManifest.douyin_id,
    files: { commentsPath, videosPath, manifestPath },
  },
  coverage,
  codingInputAudit,
  personaSignals,
  interactionSignals,
  openCodes: openCodeMetrics,
  axialCategories: axialMetrics,
  strictKnowledgeMetric,
  depthMetrics,
  topCooccurrences,
  characterMetrics,
  pairMetrics,
  archetypeMetrics,
  contextDenseVideos,
  repeatedFormulas,
  threadCases,
};

function quoteHtml(quote, tone = '') {
  if (!quote) return '';
  const flags = quote.openCodes.slice(0, 3).map((id) => `<span>${escapeHtml(openCodeById[id]?.label ?? id)}</span>`).join('');
  return `<figure class="quote ${tone}" data-codes="${escapeHtml(quote.openCodes.join(' '))}"><blockquote>“${escapeHtml(quote.text)}”</blockquote><figcaption><strong>${formatInteger(quote.likes)} 赞</strong><em>${escapeHtml(quote.type)}</em>${quote.author ? '<em>作者发言</em>' : ''}<a href="${escapeHtml(quote.videoUrl)}" target="_blank" rel="noreferrer">对应视频</a></figcaption><div class="mini-tags">${flags}</div></figure>`;
}

function barRows(items, valueKey, max, formatter = formatInteger, color = '#718e82') {
  return items.map((item) => {
    const value = item[valueKey];
    const width = max ? Math.max(value ? 2 : 0, (value / max) * 100) : 0;
    return `<div class="bar-row"><div class="bar-name">${escapeHtml(item.label)}</div><div class="bar-track"><span style="width:${width.toFixed(2)}%;background:${color}"></span></div><div class="bar-value">${formatter(value)}</div></div>`;
  }).join('');
}

function metricStrip(items) {
  return items.map((item) => `<div class="metric"><strong>${item.value}</strong><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.note || '')}</small></div>`).join('');
}

function archetypeTableRows(items) {
  return items.map((item) => `<tr><td><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.description)}</small></td><td>${formatInteger(item.videos)}</td><td>${formatDecimal(item.medianComments)}</td><td>${formatDecimal(item.averageComments)}</td><td>${item.examples.slice(0, 2).map((video) => `<a href="${escapeHtml(video.url)}" target="_blank" rel="noreferrer">${escapeHtml(truncate(video.title.replace(/#\S+/g, ''), 48))}</a>`).join('')}</td></tr>`).join('');
}

function characterTableRows(items) {
  return items.map((item) => `<tr><td><strong>${escapeHtml(item.label)}</strong></td><td>${formatInteger(item.comments)}<small>${formatInteger(item.users)} 人 / ${formatInteger(item.likes)} 赞</small></td><td>${formatInteger(item.titleVideos)}<small>${formatInteger(item.titleVideoComments)} 条采集评论</small></td><td>${formatInteger(item.mentionsUnderTitleExposure)}</td><td>${formatInteger(item.mentionsOutsideTitleExposure)}</td></tr>`).join('');
}

function codebookRows(items) {
  return items.map((item) => `<tr><td><strong>${escapeHtml(item.label)}</strong><code>${escapeHtml(item.id)}</code></td><td>${escapeHtml(item.definition)}</td><td>${escapeHtml(item.rule)}</td><td>${formatInteger(item.comments)}<small>${percent(item.comments, coverage.nonEmptyComments)} / ${formatInteger(item.users)} 人</small></td></tr>`).join('');
}

function threadCaseHtml(item, index) {
  return `<article class="thread-case"><header><span>CASE ${String(index + 1).padStart(2, '0')}</span><div><h4>${escapeHtml(item.label)}</h4><p>${escapeHtml(item.interpretation)}</p></div></header><p class="thread-context">${escapeHtml(truncate(item.videoTitle, 100))} · 线程 ${formatInteger(item.threadSize)} 条</p>${quoteHtml(item.root, 'root')}${item.replies.length ? `<div class="reply-list">${item.replies.map((reply) => quoteHtml(reply, 'reply')).join('')}</div>` : '<p class="muted">该根评论没有采集到回复；此处只作为高赞语义证据。</p>'}</article>`;
}

function buildReport(data) {
  const strictPurchase = openCodeById.strict_purchase_intent;
  const jargon = openCodeById.game_system_jargon;
  const strictMechanic = openCodeById.mechanic_remap_validation;
  const history = openCodeById.historical_intertext;
  const canonAudit = openCodeById.canon_audit;
  const canonIrony = openCodeById.canon_irony;
  const alias = openCodeById.courtesy_nickname;
  const relationship = openCodeById.relationship_shipping;
  const counterShipping = openCodeById.counter_shipping;
  const cute = openCodeById.cute_infantilization;
  const submission = openCodeById.submission_ritual;
  const tosign = openCodeById.tosign_ritual;
  const friction = openCodeById.content_boundary_rejection;
  const accessibility = openCodeById.accessibility_request;
  const price = openCodeById.price_sensitivity;
  const mascot = data.personaSignals.mascot;
  const communityAddress = data.personaSignals.communityAddress;
  const dogka = data.personaSignals.dogka;
  const interaction = data.interactionSignals;
  const outsider = openCodeById.outsider_self_identification;
  const officialConfusion = openCodeById.official_identity_confusion;
  const aiQuality = openCodeById.ai_quality_rights;
  const maxDepth = Math.max(...data.depthMetrics.map((item) => item.comments));
  const maxPair = Math.max(...data.pairMetrics.map((item) => item.comments));
  const strictKnowledge = data.strictKnowledgeMetric;
  const topPair = data.pairMetrics[0];
  const generatedAt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(data.generatedAt)).replace(/\//g, '-');
  const sourceLabel = path.basename(sourceDir);
  const lexiconRows = [
    ['卡宝', `${formatInteger(mascot.comments)} 条直接点名；观众 ${formatInteger(mascot.audienceComments)} 条、作者 ${formatInteger(mascot.authorComments)} 条。`, '官方内容中的固定人格化称呼；在评论里既是可爱对象，也是可被催更、索取表情包、归因“偏心”的行动者。', '未找到可据此确认物种或完整设定的材料；“小狗/吉祥物”只能写为受众感知。'],
    ['卖血将', '“郭嘉能卖血”“三个卖血将抱团”等将受伤场景重新解释为牌差收益。', '玩家策略分类，指能将受伤/失去体力转为摸牌、分配或控制收益的武将；不是情绪意义上的“受虐”。', '官网攻略会采用该说法，但它不是规则中的正式技能类别。'],
    ['铁骑 / 马神', '“马神直接锁技能”“跟我的大铁骑说去吧”。', '通常指界马超的铁骑：压制目标非锁定技，并与卖血类武将形成机制对抗的玩家读法。', '具体效果受武将版本和平台规则影响；“马神”是强度昵称。'],
    ['雄乱 / 放逐', '“雄乱娃娃机”“给我吃放逐”。', '张绣、曹丕等技能被动词化、食物化，把对局效果重写成日常动作喜剧。', '这是机制拟人化，不是历史事实；同名技能需结合版本识别。'],
    ['柿子 / 谋柿子', '标题“柿子之争”与“抢吃谋柿子的柿子”。', '真实水果、曹丕“世子”谐音及谋曹丕版本梗叠加，形成多义笑点。', '不能把所有“柿子”文本命中都归入曹丕。'],
    ['屯田', '评论既出现“屯田”，也出现农场币/活动场语境。', '可能指邓艾技能，也可能指 2026 建造经营玩法；同词承载两套游戏经验。', '需逐视频判别，不能统一解释为邓艾梗。'],
    ['界 / 谋 / 势 / 神 / SP', '“界曹植”“谋姜维”等版本前缀。', '表示同名武将的不同卡牌、突破或扩展版本，是玩家识别强度和技能差异的快捷语。', '不是形容词；跨版本、跨端结论不能直接互用。'],
    ['手杀 / OL / 十周年', '“手杀快出”“我主玩 OL”“十周年比手杀便宜”等。', '玩家在不同产品、服务器与经济系统之间切换比较；同名武将并不必然处于同一规则环境。', '正式产品与玩家简称需分开写，不能混为一个平台。'],
    ['斗地主 / 农民', '“斗地主算个 T1 农民”等。', '三人斗地主模式的阵营与强度语境，不是现实职业；和军八身份场的评价维度不同。', '不要将模式角色误解为用户现实身份。'],
    ['珠联璧合', '“凑个游戏羁绊”“国战珠联璧合”。', '国战人物羁绊机制，给关系内容提供了游戏内的共同语言。', '关系类型包含夫妻、亲属、君臣同僚和典故，不自动等同恋爱。'],
    ['礼貌投稿', `${formatInteger(interaction.submission.comments)} 条、${formatInteger(interaction.submission.users)} 人；${formatInteger(interaction.submission.intimateComments)} 条含亲密场景请求。`, '用“礼貌”软化高强度的同人/剧情提案，是可复制的共创句式，而不是一般性建议。', '高活跃子群的仪式，不等于全体受众都偏好 CP 内容。'],
    ['to签', `${formatInteger(interaction.toSignExact.comments)} 条、${formatInteger(interaction.toSignExact.users)} 人；根评论作者回复标记 ${percent(interaction.toSignExact.authorRepliedRoots, interaction.toSignExact.roots)}。`, '以角色点名、求赞和稀缺回馈构成参与仪式，表达被看见与被定制回应的期待。', '应从内容满意度和商品购买意向中单列。'],
  ].map(([term, observed, meaning, boundary]) => `<tr><td><strong>${term}</strong></td><td>${observed}</td><td>${meaning}</td><td>${boundary}</td></tr>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>三国杀WUHU联盟卡宝玩家语境扎根内容分析报告</title>
  <link rel="icon" href="data:,">
  <style>
    :root{--page:#f4f3ef;--paper:#fff;--ink:#2f3736;--muted:#68716e;--line:#d9ddd8;--pine:#445f57;--jade:#718e82;--sage:#a7b9a7;--blue:#6f8994;--gold:#b7884e;--rust:#a8644d;--soft:#eef1ed;--warm:#f5eee5;--radius:7px}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--page);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;letter-spacing:0;line-height:1.75}a{color:#456f79;text-decoration-thickness:1px;text-underline-offset:3px}button{font:inherit}.shell{max-width:1180px;margin:0 auto;padding:24px}.cover{min-height:560px;background:var(--pine);color:#fff;display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,.7fr);gap:48px;align-items:end;padding:68px;border-radius:var(--radius);position:relative;overflow:hidden}.cover:after{content:"";position:absolute;right:-60px;top:-80px;width:290px;height:290px;border:1px solid rgba(255,255,255,.14);transform:rotate(18deg)}.eyebrow{font-size:12px;font-weight:700;letter-spacing:0;text-transform:uppercase;opacity:.72}.cover h1{font-size:48px;line-height:1.22;margin:18px 0 20px;letter-spacing:0;max-width:760px}.cover .lead{font-size:20px;line-height:1.75;max-width:760px;color:#e9efeb}.cover-note{border-left:2px solid rgba(255,255,255,.45);padding-left:22px}.cover-note strong{display:block;font-size:18px}.cover-note span{display:block;margin-top:10px;color:#dce5e0;font-size:13px}.nav{position:sticky;top:0;z-index:20;background:rgba(244,243,239,.95);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);margin:18px 0 0;padding:10px 0;display:flex;gap:8px;overflow-x:auto}.nav a{white-space:nowrap;text-decoration:none;color:var(--muted);font-size:13px;padding:7px 10px;border-radius:4px}.nav a:hover{background:#e6ebe6;color:var(--ink)}.band{background:var(--paper);margin-top:18px;padding:42px 46px;border-radius:var(--radius);border:1px solid #ebece8}.band.alt{background:#edf1ed}.section-head{display:grid;grid-template-columns:140px 1fr;gap:24px;margin-bottom:28px}.part{font-size:12px;font-weight:800;color:var(--blue);border-top:3px solid var(--blue);padding-top:8px}.section-head h2{font-size:30px;line-height:1.3;margin:0 0 8px;letter-spacing:0}.section-head p{margin:0;color:var(--muted);max-width:820px}.metric-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin:28px 0}.metric{background:#f8f9f7;padding:22px;min-height:124px}.metric strong{display:block;font-size:27px;color:var(--pine);line-height:1.15}.metric span{display:block;font-size:13px;font-weight:700;margin-top:9px}.metric small{display:block;font-size:11px;color:var(--muted);margin-top:4px}.boundary{border-left:4px solid var(--gold);background:var(--warm);padding:18px 20px;margin:24px 0}.boundary strong{display:block}.boundary p{margin:6px 0 0;color:#6a5946}.thesis{font-size:28px;line-height:1.55;margin:10px 0 26px;color:var(--pine);font-weight:700}.thesis em{font-style:normal;color:var(--rust)}.logic{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.logic-step{border-top:4px solid var(--jade);background:#f6f8f5;padding:20px;min-height:168px}.logic-step b{display:block;font-size:12px;color:var(--jade)}.logic-step h3{font-size:17px;margin:8px 0}.logic-step p{font-size:13px;color:var(--muted);margin:0}.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.evidence{border-left:3px solid var(--jade);padding:2px 0 2px 18px}.evidence.warning{border-color:var(--rust)}.evidence h3{font-size:20px;margin:0 0 8px}.evidence p{color:var(--muted);margin:0}.evidence strong.kpi{display:block;font-size:25px;color:var(--pine);margin-top:10px}.quote{margin:12px 0;background:#f6f7f5;border-left:3px solid var(--sage);padding:15px 17px;border-radius:0 4px 4px 0}.quote.root{background:#f1f4f0;border-color:var(--pine)}.quote.reply{background:#fafafa;border-color:#c7cec8;margin-left:28px}.quote blockquote{margin:0;font-size:15px}.quote figcaption{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:9px;font-size:11px;color:var(--muted)}.quote figcaption em{font-style:normal;background:#e7ebe7;padding:1px 6px;border-radius:3px}.mini-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}.mini-tags span,.tag{font-size:10px;border:1px solid #d4dbd5;color:#587064;padding:2px 6px;border-radius:3px;background:#fff}.bar-chart{display:grid;gap:12px;margin:22px 0}.bar-row{display:grid;grid-template-columns:160px 1fr 80px;gap:12px;align-items:center;font-size:12px}.bar-name{font-weight:650}.bar-track{height:14px;background:#e6ebe6;border-radius:2px;overflow:hidden}.bar-track span{display:block;height:100%}.bar-value{text-align:right;font-variant-numeric:tabular-nums}.chapter{padding:34px 0;border-top:1px solid var(--line)}.chapter:first-of-type{border-top:0}.chapter-title{display:grid;grid-template-columns:70px 1fr;gap:18px}.chapter-index{font-size:34px;font-weight:800;color:#c1cbc4;line-height:1}.chapter h3{font-size:25px;margin:0}.chapter .summary{color:var(--muted);margin:6px 0 20px;max-width:900px}.evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.thread-case{border-top:1px solid var(--line);padding:26px 0}.thread-case header{display:grid;grid-template-columns:72px 1fr;gap:16px}.thread-case header>span{font-size:11px;font-weight:800;color:var(--blue)}.thread-case h4{font-size:19px;margin:0}.thread-case header p{color:var(--muted);margin:4px 0}.thread-context{font-size:11px;color:var(--muted);margin:12px 0}.reply-list{border-left:1px solid #d7ddd8;margin-left:15px;padding-left:4px}.table-wrap{overflow-x:auto;margin-top:20px}table{border-collapse:collapse;width:100%;min-width:760px;font-size:12px}th{text-align:left;color:var(--muted);font-weight:700;border-bottom:2px solid var(--line);padding:10px}td{border-bottom:1px solid var(--line);padding:12px 10px;vertical-align:top}td small{display:block;color:var(--muted);margin-top:5px}td a{display:block;margin-bottom:4px}td code{display:block;font-size:10px;color:#77817c}.model-segments{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.segment{border-top:3px solid var(--blue);padding:18px;background:#f7f8f6}.segment h4{margin:0 0 8px;font-size:16px}.segment p{font-size:12px;color:var(--muted);margin:0}.segment b{display:block;font-size:11px;margin-top:10px;color:var(--pine)}.recommendations{counter-reset:rec;display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.recommendation{counter-increment:rec;padding:22px;background:#f7f8f6;border-top:3px solid var(--jade)}.recommendation:before{content:"0" counter(rec);font-size:11px;font-weight:800;color:var(--jade)}.recommendation h4{font-size:18px;margin:6px 0}.recommendation p{font-size:13px;color:var(--muted);margin:0}.recommendation strong{display:block;margin-top:12px;font-size:12px}.explorer-controls{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.filter-button{border:1px solid var(--line);background:#fff;color:var(--muted);padding:7px 10px;border-radius:4px;cursor:pointer}.filter-button.active{background:var(--pine);color:#fff;border-color:var(--pine)}.hidden-evidence{display:none}.sources{font-size:12px;color:var(--muted)}.sources li{margin:8px 0}.footer{padding:28px 0 12px;color:var(--muted);font-size:11px;text-align:center}.muted{color:var(--muted);font-size:12px}.screen-only{display:block}
    @media(max-width:900px){.shell{padding:12px}.cover{grid-template-columns:1fr;padding:42px;min-height:520px}.cover h1{font-size:38px}.metric-strip{grid-template-columns:repeat(2,1fr)}.logic{grid-template-columns:repeat(2,1fr)}.model-segments{grid-template-columns:repeat(2,1fr)}.section-head{grid-template-columns:100px 1fr}}
    @media(max-width:640px){.shell{padding:0}.cover,.band{border-radius:0}.cover{padding:34px 22px;min-height:560px}.cover h1{font-size:31px}.cover .lead{font-size:16px}.nav{padding-left:10px}.band{padding:30px 20px}.section-head{grid-template-columns:1fr;gap:8px}.section-head h2{font-size:25px}.part{width:max-content}.metric-strip,.logic,.grid-2,.grid-3,.evidence-grid,.model-segments,.recommendations{grid-template-columns:1fr}.bar-row{grid-template-columns:112px 1fr 58px}.chapter-title{grid-template-columns:48px 1fr}.quote.reply{margin-left:10px}.thesis{font-size:22px}}
    @media print{body{background:#fff}.shell{max-width:none;padding:0}.nav,.screen-only{display:none}.cover,.band{break-inside:avoid;border-radius:0}.cover{min-height:240px}.quote,.thread-case,.recommendation{break-inside:avoid}}
  </style>
</head>
<body>
  <main class="shell">
    <section class="cover" id="top">
      <div><div class="eyebrow">Grounded content analysis · Player context</div><h1>三国杀WUHU联盟卡宝<br>玩家语境扎根内容分析</h1><p class="lead">不是再做一次词频榜，而是回答：玩家究竟用什么知识看懂、用什么关系投入、又怎样把评论区变成剧情的一部分。</p></div>
      <aside class="cover-note"><strong>全量评论语义编码</strong><span>${formatInteger(coverage.videos)} 条视频 · ${formatInteger(coverage.comments)} 条评论<br>${formatInteger(coverage.uniqueAudienceUsers)} 个受众评论者标识<br>采集覆盖 ${percent(coverage.capturedComments, coverage.declaredComments, 2)}</span><span>生成时间：${escapeHtml(generatedAt)}<br>数据批次：${escapeHtml(sourceLabel)}</span></aside>
    </section>
    <nav class="nav screen-only" aria-label="报告导航"><a href="#thesis">核心范畴</a><a href="#method">方法</a><a href="#layers">语义层</a><a href="#lexicon">玩家词典</a><a href="#threads">线程案例</a><a href="#formats">内容原型</a><a href="#segments">语境人群</a><a href="#actions">内容动作</a><a href="#appendix">编码附录</a></nav>

    <section class="band" id="thesis">
      <header class="section-head"><div class="part">CORE CATEGORY</div><div><h2>核心范畴：卡宝是玩家知识的“轻剧情接口”</h2><p>选择性编码不是“大家喜欢可爱”，而是解释评论中的多类行为如何被同一个机制连接。</p></div></header>
      <p class="thesis">卡宝的有效性不只来自萌感。它把玩家已有的<em>武将知识、机制黑话、历史悲剧和关系想象</em>，翻译成低门槛、可接话、可投稿、可实物化的轻剧情；再把“看视频”转成“共同续写”。</p>
      <div class="logic"><div class="logic-step"><b>01 降门槛</b><h3>日常萌系短剧</h3><p>${formatInteger(cute.comments)} 条萌化/幼态命名提供零门槛情绪入口，圈外人不懂机制也能先读懂关系和动作。</p></div><div class="logic-step"><b>02 识别</b><h3>角色与圈内词</h3><p>${formatInteger(alias.comments)} 条调用表字/昵称；${formatInteger(strictMechanic.comments)} 条高精度机制重映射。玩家在此识别“我知道这个梗属于谁”。</p></div><div class="logic-step"><b>03 续写</b><h3>关系与仪式</h3><p>${formatInteger(submission.comments)} 条“礼貌投稿”、${formatInteger(interaction.toSignExact.comments)} 条精确to签，把评论区变成提案与回馈现场。</p></div><div class="logic-step"><b>04 转化</b><h3>情感对象可拥有</h3><p>${formatInteger(strictPurchase.comments)} 条近购买意向下限，说明部分情感从“看角色”迁移到“想拥有角色”。</p></div></div>
      <div class="boundary"><strong>最重要的解释边界</strong><p>评论出现角色名不等于总体角色偏好；它首先受该视频曝光影响。规则命中代表“可复核下限”，不代表所有未命中评论都没有同类语义，也不把评论者自动认定为真实付费玩家。</p></div>
    </section>

    <section class="band alt" id="method">
      <header class="section-head"><div class="part">METHOD</div><div><h2>扎根式路径：全量规则、定向审阅、线程回看</h2><p>本报告采用计算辅助的扎根式内容分析：开放编码覆盖全部评论，主轴编码聚合机制，选择性编码提出核心范畴，再用原始线程与反例校正规则。它不声称人工逐条编码、理论饱和或编码者一致性。</p></div></header>
      <div class="metric-strip">${metricStrip([{value:formatInteger(coverage.comments),label:'全量评论',note:`${formatInteger(coverage.nonEmptyComments)} 条有文本`},{value:formatInteger(coverage.roots),label:'根评论',note:`${percent(coverage.roots,coverage.comments)} 全量占比`},{value:formatInteger(coverage.replies),label:'回复',note:'保留上下文链路'},{value:formatInteger(OPEN_CODES.length),label:'开放编码',note:`归并为 ${AXIAL_CATEGORIES.length} 个主轴范畴`}])}</div>
      <div class="grid-3"><div class="evidence"><h3>开放编码</h3><p>从账号人格、角色点名、技能黑话、历史互文、CP、萌化、投稿、to签、周边与边界反例等可观察语言出发。</p></div><div class="evidence"><h3>主轴编码</h3><p>归并为人格化治理、角色/IP语境、关系戏剧化、萌化照护、社区共创、实物转化、边界摩擦七个机制。</p></div><div class="evidence"><h3>选择性编码</h3><p>用“低门槛萌系关系短剧 + 严格圈内知识解释 + 社群共创”解释识别、情感、参与与转化如何串联。</p></div></div>
      <div class="boundary"><strong>规则审计轨迹</strong><p>定向复核了关系边界 22 个、求解释 208 个、卡宝物种/身份 197 个、悲剧修复 52 个、史实/设定校验 37 个初始候选。复核后增加共现与史源约束、拆分知识门槛与剧情追问、排除程度补语和玩笑式时间线；最终数值均按修订规则重算。</p></div>
      <div class="boundary"><strong>证据一致性</strong><p>${escapeHtml(data.methodology.codingInput)} 本轮有 ${formatInteger(data.codingInputAudit.commentsChangedBySanitization)} 条文本发生规范化或去标识，另有 ${formatInteger(data.codingInputAudit.codeAssignmentsRemovedBySanitization)} 个原始规则命中因此被撤销。因此文末匿名引语、编码CSV与本页统计使用同一版本文本，不以被隐藏的@用户名触发角色或关系分类。</p></div>
      <div class="boundary"><strong>材料缺口</strong><p>源目录的 <code>videos</code> 文件夹当前为空（${formatInteger(coverage.videoFilesPresent)} 个文件），因此没有逐帧画面、配音和镜头语言编码。所有“内容”判断均扎根于视频标题、互动元数据、评论原文和线程结构。</p></div>
    </section>

    <section class="band" id="layers">
      <header class="section-head"><div class="part">OPEN → AXIAL</div><div><h2>玩家语境不是一层：从看懂到共同续写</h2><p>以下“参与深度阶梯”按每条评论命中的最高行为层归类，互不重复；它不是用户生命周期，也不把同一人固定为某一种人。</p></div></header>
      <div class="bar-chart">${barRows(data.depthMetrics, 'comments', maxDepth, (value) => `${formatInteger(value)} · ${percent(value,coverage.nonEmptyComments)}`, '#718e82')}</div>
      <div class="chapter"><div class="chapter-title"><div class="chapter-index">01</div><div><h3>账号人格先把“官方”变成可接话的人</h3><p class="summary">卡宝不是单纯账号名。观众会向它催角色、索取表情包、要求发某一对关系，甚至归因“偏心”；作者再以“本宝”“将军”回应。这里形成的是人格化社群治理，而非传统客服式问答。</p></div></div><div class="grid-3"><div class="evidence"><h3>卡宝点名</h3><strong class="kpi">${formatInteger(mascot.comments)} 条</strong><p>观众 ${formatInteger(mascot.audienceComments)} 条、作者 ${formatInteger(mascot.authorComments)} 条。含“卡宝”的观众根评有 ${percent(mascot.authorRepliedRoots, mascot.roots)} 作者回复标记，高于全体观众根评 ${percent(interaction.authorRootReplyRate, 1)}；这是关联，不是因果。</p></div><div class="evidence"><h3>“将军”称谓</h3><strong class="kpi">${formatInteger(communityAddress.comments)} 条</strong><p>作者使用 ${formatInteger(communityAddress.authorComments)} 条，观众使用 ${formatInteger(communityAddress.audienceComments)} 条。它更像作者主导、观众部分接纳的世界观称呼。</p></div><div class="evidence warning"><h3>“狗卡”双关</h3><strong class="kpi">${formatInteger(dogka.comments)} 条</strong><p>${formatInteger(dogka.users)} 人、${formatInteger(dogka.likes)} 赞，全部来自观众；可同时是亲昵称呼、对发行方的调侃或开盒/宝珠情绪入口，不能直接算负面。</p></div></div><div class="evidence-grid">${mascot.quotes.slice(0,2).map((quote)=>quoteHtml(quote)).join('')}${dogka.quotes.slice(0,2).map((quote)=>quoteHtml(quote,'warning')).join('')}</div></div>
      <div class="chapter"><div class="chapter-title"><div class="chapter-index">02</div><div><h3>角色/IP语境：从点名到严格圈层解码分层看</h3><p class="summary">角色名或“三国杀/武将”词首先证明观看被放入IP框架；表字/昵称、具体机制、史实互文、台词回调、可核查校验或因果解释则进入“严格圈层解码”口径。它表示评论调用了更具体的共享知识，不把每一句简称都误写成完整考据。</p></div></div><div class="grid-3"><div class="evidence"><h3>IP/版本/系统指涉</h3><strong class="kpi">${formatInteger(jargon.comments)} 条</strong><p>${formatInteger(jargon.users)} 个评论者标识；这是包含“三国杀/武将”等词的宽口径系统指涉，不能当作机制理解证据。</p></div><div class="evidence"><h3>严格圈层解码</h3><strong class="kpi">${formatInteger(strictKnowledge.comments)} 条</strong><p>${formatInteger(strictKnowledge.users)} 人、${formatInteger(strictKnowledge.likes)} 赞；收表字/昵称、具体机制、经济记忆、史实互文、可核查校验、台词回调或解释性论述。</p></div><div class="evidence"><h3>机制重映射/校验</h3><strong class="kpi">${formatInteger(strictMechanic.comments)} 条</strong><p>${formatInteger(strictMechanic.users)} 人、${formatInteger(strictMechanic.likes)} 赞。它要求具体技能、牌或规则词命中，是“第二字幕”的高精度下限。</p></div></div><div class="evidence-grid">${strictKnowledge.quotes.slice(0,2).map((quote)=>quoteHtml(quote)).join('')}${strictMechanic.quotes.slice(0,2).map((quote)=>quoteHtml(quote)).join('')}</div><h4>角色响应必须与标题曝光一起读</h4><p class="muted">下表展示评论提及与标题曝光的并列口径。“标题外提及”更接近观众主动带入，但仍不等于总体偏好；“标题内提及”则首先反映该视频已经给了角色刺激。</p><div class="table-wrap"><table><thead><tr><th>角色/别名群</th><th>评论响应</th><th>标题曝光</th><th>标题曝光内提及</th><th>标题外提及</th></tr></thead><tbody>${characterTableRows(data.characterMetrics.slice(0, 12))}</tbody></table></div></div>
      <div class="chapter"><div class="chapter-title"><div class="chapter-index">03</div><div><h3>“正史”并非单一立场：认真考据与反讽正典化必须拆开</h3><p class="summary">玩家面对的权威不止一种：游戏设定、正史、演义/大众典故，以及卡宝的萌系架空宇宙。认真校验会纠正时间线、建模和人物关系；“这才是正史”则常把萌化或关系二创玩笑式封为正典。</p></div></div><div class="grid-3"><div class="evidence"><h3>史实/演义互文</h3><strong class="kpi">${formatInteger(history.comments)} 条</strong><p>只收明确史源、事件或考据句式；不是每一条角色评论都可称为历史讨论。</p></div><div class="evidence"><h3>认真校验</h3><strong class="kpi">${formatInteger(canonAudit.comments)} 条</strong><p>时间线、建模、关系与出处的可核查修订；适合转化为“本集小考据”共创。</p></div><div class="evidence"><h3>反讽正史</h3><strong class="kpi">${formatInteger(canonIrony.comments)} 条</strong><p>不能与认真纠错合并；它是将可爱/CP内容正典化的玩梗方式。</p></div></div><div class="evidence-grid">${canonAudit.quotes.slice(0,2).map((quote)=>quoteHtml(quote)).join('')}${canonIrony.quotes.slice(0,2).map((quote)=>quoteHtml(quote)).join('')}</div></div>
      <div class="chapter"><div class="chapter-title"><div class="chapter-index">04</div><div><h3>关系戏剧化：玩家争夺的不是“谁和谁同框”，而是人物解释权</h3><p class="summary">关系同现首先受当期视频曝光影响，只是发现候选关系线的入口；显式CP、史事解释、游戏羁绊、友情/君臣/家族和同人重构必须拆开。高传播评论常把复杂事件压缩成信任、守护、偏爱、背叛或意难平。</p></div></div><div class="bar-chart">${barRows(data.pairMetrics.slice(0,8), 'comments', maxPair, (value)=>formatInteger(value), '#6f8994')}</div><p class="muted">当前样本最高共现为 ${escapeHtml(topPair.label)}：${formatInteger(topPair.comments)} 条 / ${formatInteger(topPair.users)} 人 / ${formatInteger(topPair.likes)} 赞；其中仅 ${formatInteger(topPair.explicitShippingComments)} 条命中显式CP规则。结论应写作“当前内容下的关系响应”，不能写作“全体玩家CP偏好”。</p><div class="grid-2"><div class="evidence"><h3>显式CP/关系再叙事</h3><strong class="kpi">${formatInteger(relationship.comments)} 条</strong><p>亲嘴、结婚、嗑等词可识别为同人化表达；它与史事、演义和游戏羁绊并存，而非彼此替代。</p></div><div class="evidence warning"><h3>关系边界反例</h3><strong class="kpi">${formatInteger(counterShipping.comments)} 条</strong><p>只收“只会嗑”、明确反对亲嘴/结婚，或“礼貌投稿”与CP批评共现的文本；修订规则排除了裸“礼貌在哪”的非CP语境。它证明高可见度CP仪式并不等于无分歧的社区共识。</p></div></div><div class="evidence-grid">${relationship.quotes.slice(0,4).map((quote)=>quoteHtml(quote)).join('')}${counterShipping.quotes.slice(0,2).map((quote)=>quoteHtml(quote,'warning')).join('')}</div></div>
      <div class="chapter"><div class="chapter-title"><div class="chapter-index">05</div><div><h3>萌化与照护：不是泛可爱滤镜，而是对武将身份的反差重写</h3><p class="summary">“宝宝、小盆友、小猫、小熊、不能欺负、心疼”等语言把原本携带权力、战争与悲剧的人物改写为可亲近的社交角色。反差本身是笑点，照护行为则让观众获得进入关系的角色位置。</p></div></div><div class="grid-3"><div class="evidence"><h3>萌化/幼态化</h3><strong class="kpi">${formatInteger(cute.comments)} 条</strong><p>${percent(cute.comments,coverage.nonEmptyComments)} 的非空评论命中，涉及 ${formatInteger(cute.users)} 个评论者标识。</p></div><div class="evidence"><h3>守护/心疼</h3><strong class="kpi">${formatInteger(openCodeById.protective_care.comments)} 条</strong><p>照护语言常与武将名、悲剧记忆共现，说明萌感承载角色关系，而非脱离IP。</p></div><div class="evidence"><h3>圈外自我识别</h3><strong class="kpi">${formatInteger(outsider.comments)} 条</strong><p>仅收明确“不玩三国杀/圈外人”的自述，是下限，不能外推圈外受众比例；它说明“先喜欢再理解”确实存在。</p></div></div><div class="evidence-grid">${cute.quotes.slice(0,4).map((quote)=>quoteHtml(quote)).join('')}${outsider.quotes.slice(0,2).map((quote)=>quoteHtml(quote)).join('')}</div></div>
      <div class="chapter"><div class="chapter-title"><div class="chapter-index">06</div><div><h3>评论区共创：固定仪式降低了“当编剧”和“被看见”的门槛</h3><p class="summary">“礼貌投稿”不是普通客气建议，而是用“礼貌”软化高强度关系剧情请求的社群句式；to签则更接近点名、求赞与稀缺回馈组成的参与仪式。两者均应从内容满意度和购买意向中单独拆出。</p></div></div><div class="grid-3"><div class="evidence"><h3>礼貌投稿</h3><strong class="kpi">${formatInteger(interaction.submission.comments)} 条</strong><p>${formatInteger(interaction.submission.users)} 人；${formatInteger(interaction.submission.intimateComments)} 条（${percent(interaction.submission.intimateShare,1)}）含亲密场景请求。标准化后仅 ${formatInteger(interaction.submission.normalizedUniqueTexts)} 种文本，体现跨用户模板复刻。</p></div><div class="evidence"><h3>精确to签</h3><strong class="kpi">${formatInteger(interaction.toSignExact.comments)} 条</strong><p>${formatInteger(interaction.toSignExact.users)} 人；观众根评作者回复标记率 ${percent(interaction.toSignExact.authorRepliedRoots,interaction.toSignExact.roots)}，低于全体观众根评 ${percent(interaction.authorRootReplyRate,1)}，不能把报名量写成内容讨论热度。</p></div><div class="evidence"><h3>互动长尾</h3><strong class="kpi">中位 ${formatDecimal(interaction.engagementDistribution.medianLikes)}</strong><p>全量评论点赞 P95 ${formatDecimal(interaction.engagementDistribution.p95Likes)}、P99 ${formatDecimal(interaction.engagementDistribution.p99Likes)}。高赞模板可见度高，但不能代替用户广度。</p></div></div><div class="table-wrap"><table><thead><tr><th>高频固定文案</th><th>评论</th><th>用户</th><th>视频</th><th>赞</th></tr></thead><tbody>${data.repeatedFormulas.slice(0,10).map((item)=>`<tr><td>${escapeHtml(item.text)}</td><td>${formatInteger(item.comments)}</td><td>${formatInteger(item.users)}</td><td>${formatInteger(item.videos)}</td><td>${formatInteger(item.likes)}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="chapter"><div class="chapter-title"><div class="chapter-index">07</div><div><h3>实物化与边界：商业信号真实存在，但不等于内容或转化结论</h3><p class="summary">玩偶、毛绒、表情包把角色关系转成可拥有物；与此同时，明确的内容方向分歧、官方身份识别、AI/原创疑问和字幕需求提示：卡宝本体需要继续服务角色、规则和剧情，而不是独立挤占它们。</p></div></div><div class="grid-3"><div class="evidence"><h3>近购买意向</h3><strong class="kpi">${formatInteger(strictPurchase.comments)} 条</strong><p>${formatInteger(strictPurchase.users)} 人、${formatInteger(strictPurchase.likes)} 赞；严格规则仍只能得到表达下限，不可替代留资、预约或定金验证。</p></div><div class="evidence warning"><h3>内容明确拒斥</h3><strong class="kpi">${formatInteger(friction.comments)} 条</strong><p>样本很小，价值在暴露“想看武将小剧场而非卡宝本体”的方向边界，不应放大为总体负面率。</p></div><div class="evidence"><h3>身份/质量/可达性</h3><strong class="kpi">${formatInteger(officialConfusion.comments)} / ${formatInteger(aiQuality.comments)} / ${formatInteger(accessibility.comments)}</strong><p>依次为官方身份混淆、AI/原创与权利问询、字幕/静音可达性规则命中；都属于低量级但可立即处理的解释成本。</p></div></div><div class="boundary"><strong>定价不能从 ${formatInteger(price.comments)} 条价格评论直接推出</strong><p>即使其中有高赞“不要太贵”，也只支持做价格带测试。建议以角色投票 → 形态/材质选择 → 留资/预约 → 小额定金逐级验证，并把商品研究与to签报名分开记录。</p></div></div>
    </section>

    <section class="band alt" id="lexicon">
      <header class="section-head"><div class="part">PLAYER LEXICON</div><div><h2>玩家词典：同一个词常同时指向规则、人物与社群身份</h2><p>这里不做百科抄录，而是把数据原话、玩家实际理解与报告解释边界并排。外部官方资料只用于核对术语，不参与评论计数。</p></div></header>
      <div class="logic"><div class="logic-step"><b>表层</b><h3>日常动作喜剧</h3><p>抢柿子、抓娃娃、吵架、吃东西、上班等无需游戏知识即可理解，是泛受众的第一入口。</p></div><div class="logic-step"><b>中层</b><h3>人物与关系记忆</h3><p>表字、历史/演义典故、君臣/友情/家族及同人关系为动作赋予“为什么是他们”的意义。</p></div><div class="logic-step"><b>深层</b><h3>机制与版本暗号</h3><p>卖血、铁骑、雄乱、放逐、界/谋/势、斗地主等把动作重新翻译为对局规则。</p></div><div class="logic-step"><b>社群层</b><h3>人格与参与仪式</h3><p>卡宝、将军、礼貌投稿与to签决定“怎样对账号说话、怎样进入共同创作”。</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>词项</th><th>本批观察</th><th>玩家语境</th><th>解释边界</th></tr></thead><tbody>${lexiconRows}</tbody></table></div>
      <h3>关系语境的四层拆分</h3>
      <div class="grid-2"><div class="evidence"><h3>史事/演义层</h3><p>姜维—钟会—邓艾的灭蜀与兵变、曹丕—曹植的继承与七步诗、刘备—赵云—刘禅的长坂故事，提供悲剧与冲突骨架；正史、演义和大众典故须明确区分。</p></div><div class="evidence"><h3>游戏机制层</h3><p>放逐、珠联璧合、雄乱、铁骑等把历史人物关系重新编入可操作规则。机制名可以成为剧情动词，但不能反写成历史事实。</p></div><div class="evidence"><h3>同人再创作层</h3><p>周瑜—孙策、姜维—钟会、曹操—荀彧等被写成亲嘴、结婚、保护与吃醋；可称“高显著度同人子文化”，不可称“官方情侣”或社区一致偏好。</p></div><div class="evidence"><h3>反例/校验层</h3><p>“礼貌在哪”、反对见双男就亲嘴、纠正时间线或建模等评论，是玩家协商人物解释权的组成部分，不是应被情感词典过滤掉的噪音。</p></div></div>
      <div class="boundary"><strong>官方资料核对了什么</strong><p><a href="https://www.sanguosha.cn/pc/news-detail-1422.html" target="_blank" rel="noreferrer">官方活动公告</a>确认“卡宝”作为内容人格使用；<a href="https://www.sanguosha.cn/pc/guide-info-135.html" target="_blank" rel="noreferrer">界郭嘉攻略</a>直接使用“卖血将”；<a href="https://www.sanguosha.cn/hero-detail-156.html" target="_blank" rel="noreferrer">界马超武将页</a>说明铁骑可令非锁定技失效；<a href="https://www.sanguosha.cn/pc/guide-info-134.html" target="_blank" rel="noreferrer">国战珠联璧合攻略</a>显示羁绊并非只等同恋爱。核对只能界定词义，不能替代本批评论证据。</p></div>
    </section>

    <section class="band alt" id="threads">
      <header class="section-head"><div class="part">THREAD CASES</div><div><h2>原始线程案例：同一句话如何带出圈内解释</h2><p>每个案例保留根评论与可用回复；当回复为空时明确标注，不用孤立高赞替代真实互动链。</p></div></header>
      ${data.threadCases.map(threadCaseHtml).join('')}
    </section>

    <section class="band" id="formats">
      <header class="section-head"><div class="part">CONTENT FORM</div><div><h2>视频标题原型：人物关系与语境线索比泛标签更可解释</h2><p>标题原型为多标签规则，同一视频可同时属于对白、关系戏、历史回调和现代移植。这里只比较当前样本的评论响应规模；没有播放、完播与曝光分母，因此不称互动率，也不把标题相关性写成因果。</p></div></header>
      <div class="table-wrap"><table><thead><tr><th>原型</th><th>视频数</th><th>评论中位</th><th>评论均值</th><th>高评论例子</th></tr></thead><tbody>${archetypeTableRows(data.archetypeMetrics)}</tbody></table></div>
      <h3>严格圈层解码率较高的视频</h3><p class="muted">至少 25 条非空评论后，按表字/机制重映射/经济记忆/史实互文/可核查校验/台词回调/解释性论述的占比排序。角色点名及宽泛“三国杀/武将”词不参与排序；它衡量当前评论中的严格圈层解码密度，不衡量视频好坏。</p>
      <div class="table-wrap"><table><thead><tr><th>视频</th><th>评论</th><th>角色/IP语境</th><th>严格圈层解码</th><th>关系戏剧</th><th>共创</th></tr></thead><tbody>${data.contextDenseVideos.map((video)=>`<tr><td><a href="${escapeHtml(video.url)}" target="_blank" rel="noreferrer">${escapeHtml(truncate(video.title,76))}</a></td><td>${formatInteger(video.comments)}</td><td>${percent(video.contextReferenceShare,1)}</td><td>${percent(video.strictKnowledgeShare,1)}</td><td>${percent(video.relationshipShare,1)}</td><td>${percent(video.coauthorShare,1)}</td></tr>`).join('')}</tbody></table></div>
    </section>

    <section class="band" id="segments">
      <header class="section-head"><div class="part">CONTEXT SEGMENTS</div><div><h2>不做虚构人口画像：按评论行为划分七类语境位置</h2><p>同一评论者可以在不同视频进入不同位置；这是内容语境分群，不是年龄、性别、真实段位或消费能力推断。</p></div></header>
      <div class="model-segments"><article class="segment"><h4>规则/版本审计者</h4><p>用技能、牌序、模式、版本和开盒经验解释视频，尤其在意“界/谋/势”、手杀/OL/十周年是否混用。</p><b>内容钩子：技能反转、版本标签、规则彩蛋</b></article><article class="segment"><h4>史梗解释者</h4><p>区分正史、演义、大众典故和游戏设定，补充人物生平并纠正时间线。</p><b>内容钩子：典故双关、来源注脚、争议留口</b></article><article class="segment"><h4>关系共创者</h4><p>围绕双人关系、信任、背叛与意难平投稿；既有CP，也有君臣、友情、家族与守护。</p><b>内容钩子：关系未决、分支投票、史事回响</b></article><article class="segment"><h4>萌感照护者</h4><p>通过宝宝化、守护和心疼进入角色，未必掌握全部游戏知识。</p><b>内容钩子：身份反差、肢体小动作、低门槛情绪</b></article><article class="segment"><h4>卡宝人格互动者</h4><p>直接向卡宝催更、索取、归因偏心，或接受作者以“将军”称呼自己。</p><b>内容钩子：本宝回应、角色化主持、轻度接梗</b></article><article class="segment"><h4>仪式参与者</h4><p>复刻礼貌投稿、to签和求赞句式，以统一格式争取被看见与被采纳。</p><b>内容钩子：采纳公示、用户去重、奖励独立核算</b></article><article class="segment"><h4>泛娱乐/边界观察者</h4><p>先被可爱吸引，再询问角色、游戏或账号身份；也可能需要字幕，或只偏好武将小剧场。</p><b>内容钩子：一行梗注、字幕、主线/支线标识</b></article></div>
    </section>

    <section class="band alt" id="actions">
      <header class="section-head"><div class="part">CONTENT ACTIONS</div><div><h2>从语境机制反推内容：先增强“可共同续写性”</h2><p>动作不是泛化运营建议，每一项都对应前述编码证据，并设置可验证指标。</p></div></header>
      <div class="recommendations"><article class="recommendation"><h4>每条脚本保留“三个锚点”</h4><p>一个圈外人能懂的日常笑点、一个人物/典故锚点、一个核心玩家暗号；置顶评论只补一行机制或出处，不把笑点讲成课程。</p><strong>验证：求解释评论下降，知识互文评论占比不降</strong></article><article class="recommendation"><h4>版本与平台标签写清</h4><p>涉及界/谋/势武将、斗地主、军八或平台经济时，在标题/字幕标注对应版本与环境，避免跨端规则误读。</p><strong>验证：版本纠错率、规则争议率、有效补充评论</strong></article><article class="recommendation"><h4>关系内容做组合而非单押CP</h4><p>保留高显著度CP投稿，同时排入君臣、友情、家族、守护、权谋、机制克制和历史遗憾，明确“二创”与“史事/设定”层。</p><strong>验证：不同关系类型的独立参与人数与反例率</strong></article><article class="recommendation"><h4>把投稿改成公开选题池</h4><p>礼貌投稿按角色对/情节/游戏梗分类，按唯一用户去重；每周投票、采纳公示、成片回链，不让复制模板独占议程。</p><strong>验证：有效提案数、独立提案人、采纳后回访</strong></article><article class="recommendation"><h4>让评论真正改变下一集</h4><p>结尾只留一个明确未决冲突，让玩家在两种行动中选择；下一集开头兑现上期选择并标明来源。</p><strong>验证：投票参与、跨视频复评用户、分支兑现率</strong></article><article class="recommendation"><h4>to签单列为奖励机制</h4><p>把to签报名、内容讨论、作者回复和提案采纳分开统计；明确名额、规则与时间，降低求赞刷屏对内容判断的干扰。</p><strong>验证：有效报名、重复率、内容讨论率、履约率</strong></article><article class="recommendation"><h4>卡宝人格有接梗边界</h4><p>轻度“狗卡/宝珠/爆率”可作为圈内共同语言；一旦涉及具体概率、价格、交易或服务问题，就从拟人调侃切换到清晰说明。</p><strong>验证：身份混淆下降、服务问题一次说明解决率</strong></article><article class="recommendation"><h4>周边走逐级验证</h4><p>先用角色/造型投票验证对象，再用表情包验证传播，最后以预约/定金验证玩偶与毛绒，不拿评论“想要”直接估销量。</p><strong>验证：投票→留资→定金各层转化，不只看点赞</strong></article><article class="recommendation"><h4>字幕、来源与AI质检标准化</h4><p>全片字幕；表字/技能/典故只做一行梗注。AI内容增加轻量制作标识，并检查穿模、人物动线、设定一致性与来源说明。</p><strong>验证：字幕诉求归零、AI/原创疑问不扩大</strong></article><article class="recommendation"><h4>指标拆出语境质量</h4><p>固定追踪知识互文、关系类型、独立投稿者、跨集复评、作者回应、to签参与与严格购买意向，均值同时配中位数/分位数。</p><strong>验证：按视频形成可复盘的语境漏斗</strong></article></div>
    </section>

    <section class="band" id="appendix">
      <header class="section-head"><div class="part">APPENDIX</div><div><h2>编码手册与证据浏览</h2><p>所有开放编码都给出定义、规则、计数和匿名原话；完整逐条编码另见随报告交付的 CSV。</p></div></header>
      <div class="explorer-controls screen-only"><button class="filter-button active" data-filter="all">全部证据</button><button class="filter-button" data-filter="game_system_jargon">游戏机制</button><button class="filter-button" data-filter="historical_intertext">历史互文</button><button class="filter-button" data-filter="relationship_shipping">关系线</button><button class="filter-button" data-filter="submission_ritual">投稿</button><button class="filter-button" data-filter="merchandise_intent">周边</button></div>
      <div id="evidence-explorer" class="evidence-grid">${['game_system_jargon','historical_intertext','relationship_shipping','submission_ritual','merchandise_intent'].flatMap((id)=>openCodeById[id].quotes.slice(0,3)).map((quote)=>quoteHtml(quote)).join('')}</div>
      <div class="table-wrap"><table><thead><tr><th>开放编码</th><th>定义</th><th>规则口径</th><th>命中</th></tr></thead><tbody>${codebookRows(data.openCodes)}</tbody></table></div>
      <div class="boundary"><strong>不能从本数据推出的结论</strong><p>不能推出全体三国杀玩家偏好、真实年龄/性别、播放互动率、内容因果增量、实际购买率、整体正负面率，也不能据此给出确定定价。角色提及受视频曝光影响；粉圈反讽使简单情感词分类容易误判。</p></div>
      <h3>外部语境核对</h3><ul class="sources"><li><a href="https://www.sanguosha.cn/pc/news-detail-1422.html" target="_blank" rel="noreferrer">三国杀官方活动公告：卡宝</a>，用于确认官方内容人格名称的使用。</li><li><a href="https://www.sanguosha.cn/pc/guide-info-135.html" target="_blank" rel="noreferrer">三国杀官方攻略：卖血将</a>，用于界定玩家策略分类而非正式规则分类。</li><li><a href="https://www.sanguosha.cn/hero-detail-156.html" target="_blank" rel="noreferrer">三国杀官方武将页：界马超/铁骑</a>，用于核对非锁定技失效等版本语境。</li><li><a href="https://www.sanguosha.cn/pc/guide-info-134.html" target="_blank" rel="noreferrer">三国杀官方攻略：国战珠联璧合</a>，用于说明游戏羁绊不自动等同恋爱。</li><li><a href="https://www.sanguosha.cn/pc/mode-info-5.html" target="_blank" rel="noreferrer">三国杀官方模式页：斗地主</a>，用于界定地主/农民的模式身份。</li></ul>
    </section>
    <footer class="footer">数据源：${escapeHtml(sourceDir)} · 计算辅助扎根式内容分析 · 代表评论不展示昵称与用户URL，@提及统一替换为@用户 · ${escapeHtml(generatedAt)}</footer>
  </main>
  <script>
    const buttons=[...document.querySelectorAll('.filter-button')];
    const quotes=[...document.querySelectorAll('#evidence-explorer .quote')];
    buttons.forEach((button)=>button.addEventListener('click',()=>{buttons.forEach((item)=>item.classList.remove('active'));button.classList.add('active');const filter=button.dataset.filter;quotes.forEach((quote)=>quote.classList.toggle('hidden-evidence',filter!=='all'&&!quote.dataset.codes.split(' ').includes(filter)));}));
  </script>
</body>
</html>`;
}

function buildCodebookMarkdown(data) {
  const lines = [
    '# 三国杀WUHU联盟卡宝玩家语境扎根编码手册',
    '',
    `生成时间：${data.generatedAt}`,
    '',
    '## 1. 方法定位',
    '',
    '- 方法：全量透明规则编码 + 高风险编码定向审阅 + 原始线程复核的计算辅助扎根式内容分析。',
    '- 分析单位：单条评论；视频标题和线程关系作为上下文。',
    `- 全量口径：${formatInteger(coverage.comments)} 条评论，其中 ${formatInteger(coverage.nonEmptyComments)} 条有文本；${formatInteger(coverage.videos)} 条视频。`,
    '- 用户键：优先使用评论用户URL，仅用于去重计数；输出不包含昵称或用户URL。编码前先去除回复前缀、统一@提及为`@用户`，并掩码身份证/长数字；输出证据与编码输入一致。',
    '- 证据边界：词表命中是可复核下限，不是人工语义真值；角色曝光不等于总体偏好；本报告不声称理论饱和或编码者一致性。',
    '- 材料缺口：源数据没有视频文件，因此没有画面、配音和镜头语言编码。',
    '',
    '## 2. 选择性编码',
    '',
    `> ${data.methodology.coreCategory}`,
    '',
    '解释链：账号人格接话 → 角色/IP识别 → 严格圈层解码 → 关系重写 → 评论区共创 → 情感对象实物化；理解门槛与内容拒斥构成边界。',
    '',
    '## 3. 规则审计与迭代',
    '',
    '| 初始代码 | 初始候选 | 发现的问题 | 修订方式 |',
    '|---|---:|---|---|',
    ...data.methodology.ruleAudit.map((item) => `| ${item.initialCode} | ${item.initialCandidates} | ${item.issue} | ${item.revision} |`),
    '',
    '这些初始候选用于定向误判审计，不是随机准确率样本；因此本报告公开修订轨迹，但不声称总体准确率、理论饱和或编码者一致性。',
    '',
    '## 4. 主轴编码',
    '',
    '| 主轴范畴 | 包含开放编码 | 评论 | 用户 | 非空评论占比 |',
    '|---|---|---:|---:|---:|',
    ...data.axialCategories.map((axis) => `| ${axis.label} | ${axis.codes.map((id) => openCodeById[id].label).join('、')} | ${axis.comments} | ${axis.users} | ${percent(axis.comments, coverage.nonEmptyComments)} |`),
    '',
    '## 5. 开放编码',
    '',
    '| 编码 | 定义 | 规则/排除 | 评论 | 用户 |',
    '|---|---|---|---:|---:|',
    ...data.openCodes.map((code) => `| ${code.label} (\`${code.id}\`) | ${code.definition} | ${code.rule} | ${code.comments} | ${code.users} |`),
    '',
    '## 6. 复核说明',
    '',
    '1. 多标签：同一评论可同时命中多个开放编码和主轴范畴。',
    '2. 阶梯单标签：参与深度仅用于展示，每条非空评论按最高层归入 L0-L4，避免重复计数。',
    '3. 重复文案：保留为真实参与行为，同时单独统计标准化重复，不能把to签或礼貌投稿直接解释成独立需求。',
    '4. 情绪：没有生成“正面率/负面率”，因为玩家反讽、角色台词和剧情攻击容易被词典误判。',
    '5. 购买：严格购买意向是意向下限，不是成交或销量预测。',
    '6. 角色：角色提及受标题与视频题材曝光影响，只解释为当前内容响应。',
    '7. 关系：角色同现只用于发现候选关系线，只有显式CP/亲密词才归入关系再叙事。',
    '8. 问句：知识门槛与剧情互动追问分列，普通“为什么/为啥”不再自动视为圈层门槛。',
    '9. 史梗：认真史实/设定校验与“这才是正史”的反讽正典化分列。',
    '10. 平台：手杀、OL、十周年与界/谋/势等版本标签不可跨环境直接互证。',
    '11. 严格圈层解码：角色名或宽泛“三国杀/武将”词只进入“角色/IP语境”；表字/昵称、具体机制、经济记忆、史实互文、可核查校验、台词回调或解释性论述进入严格指标。它表示对共享圈层语言的调用，不把每一句简称都当作完整考据。',
    '',
    '## 7. 配套文件',
    '',
    '- `wuhu-grounded-coded-comments.csv`：全量逐评论去标识编码。',
    '- `wuhu-grounded-player-context-analysis.json`：汇总指标、案例与内容原型。',
    '- `artifact-manifest.json`：文件大小和SHA-256。',
    '',
  ];
  return lines.join('\n');
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
fs.writeFileSync(codebookPath, buildCodebookMarkdown(summary), 'utf8');
fs.writeFileSync(reportPath, buildReport(summary), 'utf8');

const codedHeaders = ['评论ID', '视频ID', '关系类型', '是否作者', '评论点赞数', '评论内容(去标识)', '开放编码', '主轴编码', '参与深度'];
const codedLines = [codedHeaders.join(',')];
for (const comment of comments) {
  codedLines.push([
    comment['评论ID'],
    comment['所属视频ID'],
    comment['关系类型'],
    comment['是否视频作者'],
    comment._likes,
    comment._text,
    comment._openCodes.join('|'),
    comment._axialCodes.join('|'),
    depthLevel(comment),
  ].map(csvEscape).join(','));
}
fs.writeFileSync(codedCommentsPath, `${codedLines.join('\r\n')}\r\n`, 'utf8');

const sourceFiles = [commentsPath, videosPath, manifestPath];
const outputFiles = [reportPath, summaryPath, codebookPath, codedCommentsPath];
const artifactManifest = {
  generatedAt: new Date().toISOString(),
  generator: path.resolve(process.argv[1]),
  sourceFiles: sourceFiles.map((filePath) => ({ path: filePath, bytes: fs.statSync(filePath).size, sha256: sha256(filePath) })),
  outputs: outputFiles.map((filePath) => ({ path: filePath, bytes: fs.statSync(filePath).size, sha256: sha256(filePath) })),
  verification: {
    rowCounts: { comments: comments.length, codedRows: codedLines.length - 1, videos: videos.length },
    piiPolicy: 'Derived coded CSV omits commenter names and user URLs. Coding is run after inline @mentions are replaced with @用户 and identifier-shaped long numbers are masked.',
    videoMaterialBoundary: `${coverage.videoFilesPresent} files observed under source videos directory.`,
  },
};
fs.writeFileSync(artifactManifestPath, `${JSON.stringify(artifactManifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({ outputDir, reportPath, summaryPath, codebookPath, codedCommentsPath, artifactManifestPath, coverage, keySignals: { gameSystem: openCodeById.game_system_jargon.comments, historical: openCodeById.historical_intertext.comments, relationship: openCodeById.relationship_shipping.comments, submissions: openCodeById.submission_ritual.comments, strictPurchase: openCodeById.strict_purchase_intent.comments } }, null, 2));
