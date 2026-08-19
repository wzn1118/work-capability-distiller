export function buildExpandedSections(ctx) {
  const {
    deep, grounded, coverage, roleAssets, roleOpportunities, roleCore, roleSupplyDependent,
    pairAssets, contentQuadrants, archetypeCohorts, acquisitionLeaders,
    retentionLeaders, denseVideos, meaningSystem, threadCases, commerce,
    replyAssociation, repeatedFormulas, firstPurchaseQuote, boundaryQuote,
    fmt, dec, pct, esc, partHead, metricCard, finding, quoteBlock, table,
  } = ctx;

  const list = (items) => `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
  const paragraph = (text) => `<p class="longform">${text}</p>`;
  const heading = (kicker, title, text) => `<div class="thesis"><span>${kicker}</span><h3>${title}</h3><p>${text}</p></div>`;
  const stateRows = deep.migration.firstStateDistribution;
  const transitionRows = deep.migration.firstNext.slice(0, 10);
  const upward = deep.migration.upwardMovement;
  const strictCute = deep.tribes.strictCuteCells;
  const seedSegments = deep.tribes.seedSegments;
  const ordering = deep.tribes.identityOrdering;
  const observedLifecycle = deep.lifecycle.observedLifecycleSegments || [];
  const oneTime = observedLifecycle.find((row) => row.segment === '单次互动') || { users: 0, userShare: 0 };
  const sameVideoRepeat = observedLifecycle.find((row) => row.segment === '同视频重复') || { users: 0 };
  const crossVideoSameDay = observedLifecycle.find((row) => row.segment === '跨视频同日') || { users: 0 };
  const crossVideo2to7 = observedLifecycle.find((row) => row.segment === '跨视频2-7天') || { users: 0 };
  const crossVideo8to30 = observedLifecycle.find((row) => row.segment === '跨视频8-30天') || { users: 0 };
  const crossVideo30plus = observedLifecycle.find((row) => row.segment === '跨视频30天以上') || { users: 0 };
  const repeatAll = coverage.audienceUsers - oneTime.users;
  const crossVideoAll = crossVideoSameDay.users + crossVideo2to7.users + crossVideo8to30.users + crossVideo30plus.users;
  const stableOver7 = crossVideo8to30.users + crossVideo30plus.users;
  const strictCuteAudienceComments = strictCute.reduce((sum, row) => sum + row.audienceComments, 0);
  const strictCutePurchaseUsers = strictCute.reduce((sum, row) => sum + row.purchaseUsers, 0);
  const strictCuteMerchandiseUsers = strictCute.reduce((sum, row) => sum + row.merchandiseUsers, 0);

  const sections = [];

  sections.push(`
  ${partHead(13, '受众关系阶梯与状态迁移', '把散点评论重构为从相遇、识别、解码、共创到商业表达的可观测关系过程')}
  <section class="band">
    ${heading('核心判断 13.1', '账号已经形成关系资产，但关系资产不是粉丝数', `全量可识别观众评论者为 ${fmt(coverage.audienceUsers)} 人。其中 ${fmt(repeatAll)} 人至少留下两次互动，${fmt(crossVideoAll)} 人跨过至少两条视频，${fmt(stableOver7)} 人跨视频且可见跨度超过7天，${fmt(crossVideo30plus.users)} 人跨度超过30天。这个阶梯证明的不是平台留存，而是样本内评论关系由一次触发逐渐沉淀为账号级互动。`) }
    <div class="metric-grid">
      ${metricCard('一次互动观众', `${fmt(oneTime.users)}人`, `${pct(oneTime.userShare)}，仍是最大关系池`, 'amber')}
      ${metricCard('跨视频评论者', `${fmt(crossVideoAll)}人`, `${pct(crossVideoAll / coverage.audienceUsers)}，已越过单条内容`, 'blue')}
      ${metricCard('跨视频且超过7天', `${fmt(stableOver7)}人`, `${pct(stableOver7 / coverage.audienceUsers)}，更接近持续关系`, 'green')}
      ${metricCard('跨视频且超过30天', `${fmt(crossVideo30plus.users)}人`, `${pct(crossVideo30plus.users / coverage.audienceUsers)}，长期关系代理`, 'violet')}
    </div>
    ${paragraph(`最大的经营问题不是“互动少”，而是关系结构头轻脚重：${pct(oneTime.userShare)} 的观众只留下过一次评论；与此同时，少量高活跃者承担了大量社群内容。一次互动池代表可再营销机会，跨视频池代表账号叙事的承接力，超过7天和30天的跨视频关系则更接近长期社群资产。四层必须分开看，否则总评论量增长可能只是新增一次性用户，也可能只是核心用户说得更多。`)}
    <h3>关系资产的真实权重：人数在长尾，内容贡献在核心</h3>
    ${table([
      { label: '1次', users: 3351, comments: 3351, role: '入口池：完成一次表达，但尚未形成第二次可见关系' },
      { label: '2–3次', users: 1209, comments: 2797, role: '激活池：已经回来，需要把偶发兴趣接成跨视频路径' },
      { label: '4–9次', users: 596, comments: 3365, role: '稳定参与者：适合投票、解释和轻共创' },
      { label: '10次以上', users: 254, comments: 5202, role: '超级核心：仅4.70%用户贡献35.35%评论，应管理依赖风险' },
    ], [
      { label: '互动频次', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '用户', className: 'num', render: (r) => `${fmt(r.users)} / ${pct(r.users / coverage.audienceUsers)}` },
      { label: '贡献评论', className: 'num', render: (r) => `${fmt(r.comments)} / ${pct(r.comments / coverage.audienceComments)}` },
      { label: '经营角色', render: (r) => esc(r.role) },
    ])}
    ${paragraph(`频次阶梯揭示了账号的第一重结构矛盾：${fmt(3351)} 位一次用户是规模最大的获客入口，却只贡献 ${pct(3351 / coverage.audienceComments)} 的观众评论；${fmt(850)} 位4次以上用户只占 ${pct(850 / coverage.audienceUsers)}，却贡献 ${fmt(8567)} 条评论，占 ${pct(8567 / coverage.audienceComments)}。其中，${fmt(254)} 位10次以上用户跨视频率接近99%，且更常出现角色、萌化、玩家解码与共创语境。这个差异不能证明高频导致深度，因为发言机会本身会增加编码命中，但它足以说明运营必须把“新增一次用户”和“维护核心内容生产者”拆成两套目标。`)}
    <h3>广度比单条热度更接近账号关系</h3>
    ${table([
      { label: '只出现于1条视频', users: 3586, comments: null, meaning: '仍停留在单条内容关系；需要下一集、关联角色或作者回复承接' },
      { label: '至少跨3条视频', users: 1053, comments: 9066, meaning: '仅19.46%用户贡献61.61%评论，是账号级关系的主要内容底盘' },
      { label: '至少跨11条视频', users: 149, comments: 3962, meaning: '仅2.75%用户贡献26.93%评论，代表极强常驻，也构成集中风险' },
    ], [
      { label: '视频广度', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '用户', className: 'num', render: (r) => `${fmt(r.users)} / ${pct(r.users / coverage.audienceUsers)}` },
      { label: '评论贡献', className: 'num', render: (r) => r.comments === null ? '单列关系入口' : `${fmt(r.comments)} / ${pct(r.comments / coverage.audienceComments)}` },
      { label: '经营含义', render: (r) => esc(r.meaning) },
    ])}
    <div class="two-col" style="margin-top:20px">
      <div>
        <h3>贡献集中度如何影响增长判断</h3>
        ${list([
          '观众评论贡献Gini为0.5335，说明发言量明显集中，但尚非由极少数账号完全垄断。',
          'Top 1%评论者贡献16.04%的观众评论，Top 10%贡献49.10%；周报必须同步报告去除Top 1%后的结果。',
          '评论贡献HHI约0.00094，对应约1,063名等效贡献者，只占5,410名可识别评论者的约19.7%。',
          '任何“评论量上涨”都必须拆成新增用户、既有用户和超级核心三部分，否则无法判断增长来源。',
        ])}
      </div>
      <div class="callout">
        <strong>经营命题：从流量池到常驻盘，不是一次跳跃</strong>
        <p>一次用户的任务是获得第二次表达，2–3次用户的任务是跨到第三条视频，4–9次用户的任务是从反应升级为解释或共创，10次以上用户的任务是成为社群主持与内容内测者。四层应使用不同CTA、权益和风险控制，不能用同一套“求评论”机制。</p>
      </div>
    </div>
    ${paragraph('频次和广度也不是粉丝身份。一个用户可能因为活动在同日跨多条视频，也可能长期观看但从不评论；因此报告只称“可观察评论关系”。下一轮CRM应把评论频次、跨视频广度、活跃跨度、自然内容占比和语境丰富度分列，尤其要标记活动净化后仍然活跃的人，避免把仪式参与者误当作内容核心。')}
    <div class="evidence-chain">
      <article><strong>相遇</strong><span>首个可观察评论事件</span><p>不是首次观看、关注或真实获客，只是数据窗口内首次留下可见评论。</p></article>
      <article><strong>重复</strong><span>至少2次评论</span><p>证明账号获得第二次表达，但可能仍集中在同一条视频和同一天。</p></article>
      <article><strong>迁移</strong><span>跨视频评论</span><p>观众愿意把互动从一条内容带到另一条，开始形成账号级而非单视频关系。</p></article>
      <article><strong>稳定</strong><span>跨视频且超过7/30天</span><p>排除部分短期连评，更接近持续关系；仍不等于平台留存率。</p></article>
    </div>
    <h3>第一次表达从哪里开始</h3>
    ${table(stateRows, [
      { label: '首次状态', render: (r) => esc(r.label) },
      { label: '用户', className: 'num', render: (r) => fmt(r.users) },
      { label: '占文本用户', className: 'num', render: (r) => pct(r.share) },
      { label: '经营解释', render: (r) => {
        const notes = {
          S0: '宽泛互动或尚未命中现有语义词典，是最大可再识别池。',
          S1: '由角色、表字、卡宝人格或萌化语言进入内容世界。',
          S2: '用技能、历史、设定或经济记忆验证内容，代表玩家信誉互动。',
          S3: '开始护短、修复、配对、催更或共同编剧，进入社群共创。',
          S4: '以周边、价格或购买句式表达可拥有需求。',
          S5: '以to签或礼貌投稿参与活动仪式，必须与自然需求分开。',
          S6: '纠错、拒绝、可及性或身份困惑等边界信号。',
        };
        return notes[r.state] || '观察状态';
      } },
    ])}
    ${paragraph(`共有 ${fmt(deep.migration.usersWithStateChange)} 位文本观众在样本期内出现过至少一次状态变化，占 ${pct(deep.migration.stateChangeRate)}。这意味着受众不是固定的“玩家/泛人群”标签，而会在不同内容、不同时间呈现不同关系状态。报告因此不把状态图画成必然漏斗：同一用户可能先购买表达再参与剧情，也可能首条评论同时包含角色识别、玩家黑话和共创请求。`)}
    <h3>高频“首次状态 → 下一状态”路径</h3>
    ${table(transitionRows, [
      { label: '路径', render: (r) => esc(r.key.replace('->', ' → ')) },
      { label: '用户', className: 'num', render: (r) => fmt(r.count) },
      { label: '占有下一状态用户', className: 'num', render: (r) => pct(r.share) },
      { label: '如何使用', render: () => '用于识别常见内容承接顺序，不解释为因果转化。' },
    ])}
    <div class="two-col" style="margin-top:20px">
      <div>
        <h3>从反应/识别向更深关系的观测迁移</h3>
        ${list([
          `${fmt(upward.laterIntertext)} / ${fmt(upward.entryReactionOrRecognition)} 人后来出现玩家互文或严格解码，观测率 ${pct(upward.laterIntertextRate)}。`,
          `${fmt(upward.laterCoCreation)} 人后来出现有机共创，观测率 ${pct(upward.laterCoCreationRate)}。`,
          `${fmt(upward.laterCommerce)} 人后来出现商业表达，观测率 ${pct(upward.laterCommerceRate)}。`,
          '三个方向不是同一个漏斗：信誉、社群和商品各有不同入口与内容任务。',
        ])}
      </div>
      <div class="callout">
        <strong>经营结论</strong>
        <p>不要只追求“首条爆”。内容系统要同时设计第二条和第三条：入口片负责让人认出角色，解释片负责让玩家确认“你懂”，共创片负责让关系继续，商品片则把“可爱”变成尺寸、材质和价格选择。真正的增长对象是观众在这些任务之间的可重复迁移。</p>
      </div>
    </div>
    <div class="verdict"><strong>下一步验证：</strong>新建首触队列ID，记录后续7/30天观看、评论、关注、收藏和点击事件；同秒多状态保留并列，不强制排序。只有补齐曝光和真实事件，才能把“可见评论迁移”升级为用户增长漏斗。</div>
  </section>`);

  sections.push(`
  ${partHead(14, '部落桥梁与价值分工', '硬核不是唯一高价值，萌化也不是浅层；二者交叉才是最强关系核')}
  <section class="band">
    ${heading('核心判断 14.1', '机制负责可信度，萌化负责占有欲，混合核同时承担复访与商品想象', `把严格玩家解码与萌化语言交叉后，四类受众呈现完全不同的经营价值。最关键的人群不是单纯“老玩家”，而是同时使用玩家语境又愿意把角色萌化、人格化的 ${fmt(strictCute.find(r => r.id === 'both')?.users)} 人混合核。`) }
    ${table(strictCute, [
      { label: '部落', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '用户', className: 'num', render: (r) => `${fmt(r.users)}<br><span class="muted">${pct(r.userShare)}</span>` },
      { label: '人均文本评论', className: 'num', render: (r) => dec(r.commentsPerUser, 2) },
      { label: '跨视频', className: 'num', render: (r) => `${fmt(r.crossVideoUsers)} / ${pct(r.crossVideoRate)}` },
      { label: '30日机会校正', className: 'num', render: (r) => `${fmt(r.return30Users)}/${fmt(r.return30Eligible)}<br>${pct(r.return30Rate)}` },
      { label: '周边兴趣', className: 'num', render: (r) => `${fmt(r.merchandiseUsers)} / ${pct(r.merchandiseRate)}` },
      { label: '严格购买表达', className: 'num', render: (r) => `${fmt(r.purchaseUsers)} / ${pct(r.purchaseRate)}` },
    ])}
    ${paragraph('四格数据推翻了两个常见误区。第一，“老玩家最容易买”并不成立：仅严格玩家组有较高的关系延续，但购买表达低；第二，“萌化会稀释玩家价值”也不成立：严格+萌化组拥有最高的跨视频评论代理和30日机会校正回评，同时保持较高商业表达。正确策略不是在硬核与可爱之间二选一，而是让同一角色同时拥有“玩家看得懂的机制因果”和“泛受众能感知的情绪动作”。')}
    <h3>规模与倾向必须双轴决策：高比例不等于最大机会</h3>
    ${table(strictCute.map((row) => ({
      ...row,
      audienceCommentContribution: row.audienceComments / strictCuteAudienceComments,
      merchandiseContribution: row.merchandiseUsers / strictCuteMerchandiseUsers,
      purchaseContribution: row.purchaseUsers / strictCutePurchaseUsers,
    })), [
      { label: '部落', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: 'U2人数份额', className: 'num', render: (r) => pct(r.userShare) },
      { label: '关联评论贡献', className: 'num', render: (r) => pct(r.audienceCommentContribution) },
      { label: '周边信号贡献', className: 'num', render: (r) => `${fmt(r.merchandiseUsers)}人 / ${pct(r.merchandiseContribution)}` },
      { label: '购买表达率', className: 'num', render: (r) => pct(r.purchaseRate) },
      { label: '购买表达贡献', className: 'num', render: (r) => `${fmt(r.purchaseUsers)}人 / ${pct(r.purchaseContribution)}` },
    ])}
    ${paragraph(`“仅萌化身份”只有 ${fmt(strictCute.find(r => r.id === 'cute_only')?.users)} 人，购买表达率却达到 ${pct(strictCute.find(r => r.id === 'cute_only')?.purchaseRate)}，更适合承担概念点击与商品表达；“玩家解码×萌化”只有 ${fmt(strictCute.find(r => r.id === 'both')?.users)} 人，却贡献四格中约三分之一的关联评论，更适合承担长期共创和产品校验。与此同时，规模最大的“二者皆无”组仍贡献 ${fmt(strictCute.find(r => r.id === 'neither')?.purchaseUsers)} 位购买表达者，占全部严格购买表达用户的 ${pct(strictCute.find(r => r.id === 'neither')?.purchaseUsers / strictCutePurchaseUsers)}。因此高倾向小群与低倾向大盘都不能被忽略：前者提高测试效率，后者决定绝对需求量。`)}
    <div class="evidence-chain">
      <article><strong>规模盘</strong><span>二者皆无</span><p>用低门槛角色冲突和清楚字幕扩大理解，商品教育强调“这是什么”和可拥有场景。</p></article>
      <article><strong>信誉盘</strong><span>仅玩家解码</span><p>用技能、版本、表字和史事维护可信度；不以卖货率评价其全部价值。</p></article>
      <article><strong>商业倾向盘</strong><span>仅萌化身份</span><p>直接展示实物形态、尺寸和用途，是概念点击与预约测试的高效样本。</p></article>
      <article><strong>社群种子盘</strong><span>玩家解码×萌化</span><p>承担设定校验、关系共创和商品内测，是“懂且爱”的桥梁人群。</p></article>
      <article><strong>增长桥</strong><span>五层语境</span><p>从宽泛反应、角色识别、玩家互文到有机共创和商业表达，分别设计下一步动作。</p></article>
    </div>
    ${paragraph('这套五层语境与四部落并不是人口学标签，而是受众在评论中完成的任务代理。一个人可以在不同时间同时属于角色解释者、关系共创者和萌化收藏者；全周期标签也会受到评论次数机会偏差。经营上应使用“本期主任务”和“历史最高关系深度”两个字段，不把用户永久锁死在某个部落，更不把部落比例当成全体粉丝构成。')}
    <div class="finding-grid">
      ${finding('泛互动池：先做识别，不急着深挖', '未命中严格玩家或萌化语言的人群规模最大。任务是用清楚的人物关系、冲突和字幕降低门槛，再观察是否产生角色点名与跨视频行为。', 'Entry pool', 'amber')}
      ${finding('机制型老玩家：信誉资产，不等于商品池', '他们更适合校验技能映射、历史梗和设定一致性。商业动作应先用收藏、设定集、评论共创等验证，不直接按购买力外推。', 'Trust tribe', 'green')}
      ${finding('萌化收藏型：商品想象最直接', '这组对玩偶、挂件、表情包和“可拥有”的语言更敏感；商品测试需要给出材质、大小、表情和价格，而不是只问“想不想要”。', 'Commerce tribe', 'blue')}
      ${finding('玩家粉丝混合核：社群种子层', '兼具圈内识别与情感占有，是最适合承担解释、护梗、共创、二次传播和商品内测的种子人群。', 'Seed core', 'violet')}
    </div>
    <h3>高价值种子不是一个群，而是三种不同任务</h3>
    ${table(seedSegments, [
      { label: '种子层', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '用户', className: 'num', render: (r) => `${fmt(r.users)} / ${pct(r.userShare)}` },
      { label: '跨视频', className: 'num', render: (r) => pct(r.crossVideoRate) },
      { label: '30日机会校正', className: 'num', render: (r) => `${fmt(r.return30Users)}/${fmt(r.return30Eligible)} · ${pct(r.return30Rate)}` },
      { label: '周边 / 购买', className: 'num', render: (r) => `${pct(r.merchandiseRate)} / ${pct(r.purchaseRate)}` },
      { label: '经营用途', render: (r) => r.id.includes('organic') ? '选题内测、共创主持、关系线扩写' : r.id.includes('tosign') ? '活动召回、仪式参与；不并入自然需求' : '玩家解释、商品概念共研、社群桥梁' },
    ])}
    <h3>身份不是阶梯：大量“深度”在同一条评论里同时发生</h3>
    ${table(ordering, [
      { label: '身份组合', render: (r) => esc(r.label) },
      { label: '共同用户', className: 'num', render: (r) => fmt(r.users) },
      { label: '同条首现', className: 'num', render: (r) => `${fmt(r.simultaneousUsers)} / ${pct(r.simultaneousShare)}` },
      { label: '左侧先出现', className: 'num', render: (r) => `${fmt(r.leftFirstUsers)} / ${pct(r.leftFirstShare)}` },
      { label: '右侧先出现', className: 'num', render: (r) => `${fmt(r.rightFirstUsers)} / ${pct(r.rightFirstShare)}` },
      { label: '分离事件中位间隔', className: 'num', render: (r) => `${dec(r.leftToRightMedianDays, 2)}天 / ${dec(r.rightToLeftMedianDays, 2)}天` },
    ])}
    ${paragraph('同一用户一旦评论次数更多，就更有机会命中更多语义标签，也更有机会跨视频，因此“全周期是否曾命中某标签”存在机会偏差。上表用于识别内容桥梁，不用于宣称语境导致留存。下一轮必须把用户特征冻结在首触或前N次互动，再观察后续结果，避免用未来信息解释过去。')}
    <div class="verdict"><strong>MKT落点：</strong>每个内容单元至少写清楚主服务部落与桥接部落。入口片主服务泛互动池、桥接萌化；机制片主服务严格玩家、桥接泛受众；共创片主服务混合核；商品片主服务萌化收藏型，并让混合核参与概念校验。</div>
  </section>`);

  sections.push(`
  ${partHead(15, '角色资产：从声量榜升级为需求—供给组合', '角色不是词频，而是被标题供给、非标题自发点名、关系持续与商业表达共同塑造的内容资产')}
  <section class="band">
    ${heading('核心判断 15.1', '曹操、钟会、姜维、周瑜构成当前核心供给盘，但核心角色承担的任务不同', '角色资产不能只按标题评论量排位。标题供给是账号选择，非标题视频里的自发点名才更接近主动召回；跨视频和严格玩家语境说明关系质量，购买表达只是一条独立商业信号。')}
    ${table(roleCore.slice(0, 12), [
      { label: '角色', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '标题供给', className: 'num', render: (r) => `${fmt(r.titleSupplyVideos)}条` },
      { label: '非标题自发点名', className: 'num', render: (r) => `${fmt(r.nonTitleMentionUsers)}人 / ${fmt(r.nonTitleMentionComments)}评` },
      { label: '相关点赞', className: 'num', render: (r) => fmt(r.nonTitleMentionLikes) },
      { label: '跨视频', className: 'num', render: (r) => pct(r.crossVideoRate) },
      { label: '严格玩家语境', className: 'num', render: (r) => pct(r.strictContextRate) },
      { label: '周边 / 购买', className: 'num', render: (r) => `${pct(r.merchandiseRate)} / ${pct(r.purchaseRate)}` },
      { label: '机会缺口', className: 'num', render: (r) => `${r.relativeOpportunityIndex >= 0 ? '+' : ''}${dec(r.relativeOpportunityIndex, 1)}` },
    ])}
    ${paragraph('核心盘内部至少有三种经营角色。曹操是广泛供给与广泛认知的基础盘，适合承担高频入口和群像连接；钟会、姜维兼具高需求与明确关系资产，适合连续剧情和成对共创；周瑜拥有较高供给与关系延展，适合稳定承担江东关系线。吕布、司马懿等角色的非标题召回高于现有供给指数，可用作下一阶段的扩展核心，而不是一次性客串。')}
    <h3>玩家为什么会把角色当成“资产”</h3>
    <div class="three-col">
      ${meaningSystem.slice(0, 3).map((row) => `<article class="callout"><strong>${esc(row.label)}</strong><p>${esc(row.interpretation)}</p><small>${fmt(row.comments)}评 · ${fmt(row.users)}人 · ${fmt(row.videos)}条视频 · ${fmt(row.likes)}赞</small></article>`).join('')}
    </div>
    <div class="quote-grid" style="margin-top:18px">
      ${meaningSystem.slice(0, 3).map((row) => quoteBlock(row.quotes[0]?.text, row.quotes[0]?.likes, row.label)).join('')}
    </div>
    ${paragraph('玩家在评论区做的并非简单点名。他们用“阿瞒、奉孝、伯约、令君”等稳定称谓确认角色身份，用“卖血、锁技能、摸牌、屯田”等机制把日常动作重新翻译成游戏规则，再用历史与设定判断角色行为是否成立。这套解码机制让短视频同时拥有两条字幕：圈外人看到可爱冲突，玩家看到技能、版本、台词与史事互文。角色资产的价值，正是让两条字幕在同一内容里共存。')}
    <div class="verdict"><strong>角色经营原则：</strong>不要用“某角色评论多”直接决定增供。每个角色都应同时看标题供给、非标题自发召回、跨视频关系、严格玩家语境、共创、周边和购买七项。标题场景出现购买评论，只能说明该内容环境触发了购买语言，不等于观众要买该角色SKU。</div>
  </section>`);

  sections.push(`
  ${partHead(16, '角色机会与增供实验', '低供给高需求是测试候选，不是未经验证的规模化结论')}
  <section class="band">
    ${heading('核心判断 16.1', '曹冲、张飞、关羽、于吉出现相对供给缺口，应以双模板小样验证', `当前词典覆盖的角色中，${roleOpportunities.slice(0, 4).map(r => esc(r.label)).join('、')} 位于“低标题供给×高非标题自发点名代理”象限。缺口是本账号样本内的相对机会，不是全市场TAM，也可能受到既往内容投放与角色词典覆盖影响。`) }
    ${table(roleOpportunities.slice(0, 12), [
      { label: '角色', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '标题视频', className: 'num', render: (r) => fmt(r.titleSupplyVideos) },
      { label: '标题场景评论者', className: 'num', render: (r) => fmt(r.titleContextCommenters) },
      { label: '非标题自发用户', className: 'num', render: (r) => fmt(r.nonTitleMentionUsers) },
      { label: '非标题评论 / 赞', className: 'num', render: (r) => `${fmt(r.nonTitleMentionComments)} / ${fmt(r.nonTitleMentionLikes)}` },
      { label: '供给指数', className: 'num', render: (r) => dec(r.titleSupplyIndex, 1) },
      { label: '需求指数', className: 'num', render: (r) => dec(r.nonTitleMentionIndex, 1) },
      { label: '相对缺口', className: 'num', render: (r) => `+${dec(r.relativeOpportunityIndex, 1)}` },
    ])}
    <div class="two-col" style="margin-top:20px">
      <div>
        <h3>四周增供验证</h3>
        <div class="timeline">
          <article><strong>W1 机制/典故版</strong><p>每位候选角色1条。用最有辨识度的技能、表字或史事冲突做剧情因果，补一句圈外白话。</p></article>
          <article><strong>W2 萌化/日常版</strong><p>同角色1条。保持画面、长度和时段接近，用可爱动作或人格冲突降低门槛。</p></article>
          <article><strong>W3 非标题召回</strong><p>在后续不含该角色标题的视频中观察自发点名，而不是用本条标题下的被动提及证明需求。</p></article>
          <article><strong>W4 复配决策</strong><p>只有自发点名、跨视频和后续共创至少两项稳定高于对照，才进入季度系列化。</p></article>
        </div>
      </div>
      <div>
        <h3>供给依赖型角色</h3>
        ${table(roleSupplyDependent.slice(0, 10), [
          { label: '角色', render: (r) => esc(r.label) },
          { label: '标题供给', className: 'num', render: (r) => fmt(r.titleSupplyVideos) },
          { label: '自发用户', className: 'num', render: (r) => fmt(r.nonTitleMentionUsers) },
          { label: '缺口', className: 'num', render: (r) => dec(r.relativeOpportunityIndex, 1) },
        ])}
        <p class="note">这类角色在标题场景中可以引发回应，但跨内容主动召回相对弱。策略不是机械加量，而是换内容原型、做群像配角或邻接召回测试。</p>
      </div>
    </div>
    ${paragraph('指数采用对数压缩并降低点赞权重，目的是避免一条热评主导方向。仍需强调：角色词典不是三国杀全武将穷举，昵称可能有碰撞，非标题点名也会受当前视频题材影响。因此所有“缺口”都只能进入小样实验，不能直接进入大规模预算。')}
    <div class="verdict"><strong>成功标准：</strong>每位候选角色比较机制版与萌化版的独立评论者、严格玩家评论、非标题后续自发点名、7日跨视频回评和共创请求；不使用本条视频总评论量作为唯一胜负。</div>
  </section>`);

  sections.push(`
  ${partHead(17, '关系资产：CP、君臣与历史冲突必须分型', '同提双方不自动等于关系需求，更不自动等于官方关系或双人商品需求')}
  <section class="band">
    ${heading('核心判断 17.1', '周瑜×孙策、姜维×钟会是共创主轴；郭嘉×曹操是玩家信誉主轴', '三组关系都拥有较高标题供给与非标题自发同提，但评论的语义完全不同。前两组包含大量配对、护短和续作行动，第三组更多是谋臣、技能与角色判断。把三者统一称为CP，会同时伤害玩家可信度和商品判断。')}
    ${table(pairAssets, [
      { label: '关系', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '标题供给', className: 'num', render: (r) => fmt(r.titleSupplyVideos) },
      { label: '非标题同提', className: 'num', render: (r) => `${fmt(r.nonTitleCoMentionUsers)}人 / ${fmt(r.nonTitleCoMentionComments)}评` },
      { label: '关系/行动评论', className: 'num', render: (r) => `${fmt(r.nonTitleCoMentionShippingComments)} / ${fmt(r.nonTitleCoMentionActionComments)}` },
      { label: '严格玩家语境', className: 'num', render: (r) => pct(r.strictContextRate) },
      { label: '跨视频', className: 'num', render: (r) => pct(r.crossVideoRate) },
      { label: '有机共创', className: 'num', render: (r) => pct(r.coCreationRate) },
      { label: '周边 / 购买', className: 'num', render: (r) => `${pct(r.merchandiseRate)} / ${pct(r.purchaseRate)}` },
      { label: '象限', render: (r) => esc(r.quadrant) },
    ])}
    <div class="three-col" style="margin-top:20px">
      <article class="callout"><strong>周瑜×孙策：关系共创</strong><p>适合开放式结尾、护短/误会、玩家投稿和后续选择。核心KPI是非标题双方自发同提、关系评论和行动型续作请求，而不是泛点赞。</p></article>
      <article class="callout"><strong>姜维×钟会：拉新+追更</strong><p>既有高标题供给，也能形成非标题自发召回。适合连续微剧情，并用一句历史/阵营信息降低圈外理解门槛。</p></article>
      <article class="callout"><strong>郭嘉×曹操：信誉叙事</strong><p>严格玩家语境占比更高，适合君臣、谋士与技能因果。即使出现调侃，也不宜把它复制成亲嘴模板或直接做CP商品。</p></article>
    </div>
    <div class="quote-grid" style="margin-top:18px">
      ${meaningSystem.filter(r => r.id === 'relationship').map(r => quoteBlock(r.quotes[0]?.text, r.quotes[0]?.likes, '玩家二创关系表达')).join('')}
      ${threadCases.filter(r => r.label.includes('悲剧') || r.label.includes('投稿')).slice(0, 2).map(r => quoteBlock(r.root?.text, r.root?.likes, r.label)).join('')}
    </div>
    ${paragraph('“礼貌投稿”在这批评论中不是普通建议句式，而是玩家把自己放进编剧位置的社区仪式。它允许用户用固定格式提出亲密动作、历史修复或角色互动，既降低表达门槛，也会制造复制话术。报告因此把关系资产拆成三层：同提只代表认知关联；严格关系/配对编码代表二创倾向；行动型请求才代表希望账号继续生产。三层不能互相替代。')}
    <h3>低样本关系只能进入探索池</h3>
    ${paragraph('曹丕×曹植在当前8组关系中属于“低供给×相对高需求”象限，但非标题自发同提的绝对用户仍很少；司马昭×曹髦、郭嘉×戏志才、贾诩×张绣同样受到小样本影响。这些关系可以各做2—3条机制版与剧情版验证，但不应因为队列率看起来高就直接判断为新主轴。小样本比例必须同时展示分子、分母和区间。')}
    <div class="verdict"><strong>关系内容规则：</strong>每条关系线先标注“玩家二创/历史关系/技能关系/官方设定”中的哪一种，再决定CTA。关系热度与购买意向分开测试；双人套装必须通过独立概念点击、预约或订金验证，不能从共创评论直接外推。</div>
  </section>`);

  sections.push(`
  ${partHead(18, '内容原型：一条视频只承担一个主任务', '用拉新与承接双轴重组内容，而不是用总评论量定义所有好内容')}
  <section class="band">
    ${heading('核心判断 18.1', '内容至少有四种经营任务，双引擎不是唯一目标', '每条视频同时观察首触评论者与既有观众评论者，可以把内容分为拉新型、承接型、双引擎和低反应四类。这个分法不是创意好坏排名，而是帮助团队明确每条内容的主任务、CTA和后续承接。')}
    ${table(contentQuadrants, [
      { label: '内容象限', render: (r) => `<strong>${esc(r.quadrant)}</strong>` },
      { label: '视频', className: 'num', render: (r) => fmt(r.videos) },
      { label: '观众中位数', className: 'num', render: (r) => dec(r.audienceUsersMedian, 1) },
      { label: '首触中位数', className: 'num', render: (r) => dec(r.firstTouchMedian, 1) },
      { label: '既有观众中位数', className: 'num', render: (r) => dec(r.returningMedian, 1) },
      { label: '严格玩家语境', className: 'num', render: (r) => pct(r.strictContextRate) },
      { label: '购买表达用户', className: 'num', render: (r) => fmt(r.purchaseUsers) },
      { label: '经营任务', render: (r) => ({
        '双引擎': '维持规模与关系，拆解可复用结构并做系列化。',
        '拉新型': '降低门槛、扩大首触，随后必须安排解释或共创续篇。',
        '承接型': '服务已有关系，适合玩家梗、连续剧情和社群回应。',
        '低反应': '检视题材、标题、叙事或分发；不因单条失败永久放弃角色。',
      }[r.quadrant] || '内容组合任务') },
    ])}
    ${paragraph('双引擎内容说明同一条视频既能带来新的可见评论者，也能召回既有评论者，但它不必成为所有内容的模板。强行让每条视频同时兼顾圈外理解、机制解释、关系共创和商品展示，反而会让叙事失焦。更稳妥的组合是：拉新片负责“看懂并记住”，承接片负责“确认你懂并愿意继续说”，共创片负责“把下一步交给观众”，商业片负责“把可爱变成可比较的产品属性”。')}
    <h3>原型入口队列：不同格式带来的后续关系结构</h3>
    ${table(archetypeCohorts, [
      { label: '首触原型', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '用户', className: 'num', render: (r) => `${fmt(r.users)} / ${pct(r.userShare)}` },
      { label: '重复 / 跨视频', className: 'num', render: (r) => `${pct(r.repeatRate)} / ${pct(r.crossVideoRate)}` },
      { label: '7日机会校正', className: 'num', render: (r) => `${pct(r.return7Rate)}<br><span class="muted">n=${fmt(r.return7Eligible)}</span>` },
      { label: '30日机会校正', className: 'num', render: (r) => `${pct(r.return30Rate)}<br><span class="muted">n=${fmt(r.return30Eligible)}</span>` },
      { label: '第二互动中位间隔', className: 'num', render: (r) => `${dec(r.medianSecondLagHours, 1)}h` },
      { label: '后续严格 / 共创 / 购买', className: 'num', render: (r) => `${pct(r.laterStrictRate)} / ${pct(r.laterCoCreationRate)} / ${pct(r.laterPurchaseRate)}` },
    ])}
    <div class="evidence-chain" style="margin-top:18px">
      <article><strong>入口片</strong><span>角色可见性</span><p>画面和一句冲突让圈外人识别谁在做什么；CTA只要求选择、判断或短回答。</p></article>
      <article><strong>解释片</strong><span>玩家可信度</span><p>把技能、台词或史事变成剧情因果，并配一句圈外白话，不做百科堆砌。</p></article>
      <article><strong>共创片</strong><span>关系延续</span><p>开放结尾、角色护短、悲剧修复或下一集选择；记录独立提案用户而非复制句数。</p></article>
      <article><strong>商品片</strong><span>真实意向</span><p>展示尺寸、材质、细节和价格选择，以点击/预约/订金替代“评论想要”。</p></article>
    </div>
    ${paragraph('原型队列同样存在自选择和时间窗口偏差：某种内容较早发布，会天然拥有更长的跨视频观察窗口；高活跃用户也更容易同时命中多个原型。表中比例只用于提出内容假设，不能直接称为某原型“带来留存”。下一轮应按发布批次和首触时间做配对或分层，并至少报告Wilson区间。')}
    <div class="verdict"><strong>排期原则：</strong>每周至少形成一次“入口 → 解释 → 共创”的三段承接；商品概念片单列，不用关系共创片同时承担销售。每条视频在立项时只选一个主指标，最多两个辅助指标。</div>
  </section>`);

  sections.push(`
  ${partHead(19, '内容案例：从爆款榜升级为任务榜', '分别看首触、既有观众承接和玩家语境密度，避免用一个总榜误导创作')}
  <section class="band">
    ${heading('核心判断 19.1', '“评论多”无法回答内容为什么有效', '同一条视频可能首触多但既有观众承接弱，也可能总体规模普通却拥有很高玩家语境密度。任务榜让团队知道应该复制哪一种结构，而不是机械复制标题和角色。')}
    <h3>首触评论者规模领先：更适合拆解入口钩子</h3>
    ${table(acquisitionLeaders, [
      { label: '视频', render: (r) => `<strong>${esc(r.title)}</strong><br><span class="muted">${esc(r.primaryArchetypeLabel)}</span>` },
      { label: '首触用户', className: 'num', render: (r) => fmt(r.firstTouchUsers) },
      { label: '既有观众', className: 'num', render: (r) => fmt(r.returningUsers) },
      { label: '观众评论者', className: 'num', render: (r) => fmt(r.audienceUsers) },
      { label: '严格玩家语境', className: 'num', render: (r) => pct(r.strictContextShare) },
      { label: '共创语境', className: 'num', render: (r) => pct(r.coCreationShare) },
      { label: 'to签评论', className: 'num', render: (r) => fmt(r.exactToSignComments) },
    ])}
    ${paragraph('首触领先视频应拆解的是“第一秒看懂、角色关系清楚、冲突可参与”的结构，而不是把首触用户当成真实新增粉丝。某些视频含较多to签或固定投稿话术，首触评论者可能由活动召集而来；因此复盘时必须同时列活动评论、自然内容评论和后续非活动视频迁移。')}
    <h3>先做精确to签净化，再判断哪些内容真的可复制</h3>
    ${table([
      { title: '柿子之争，向来如此', text: 383, ritual: 32, natural: 351, meaning: '净化后仍居前，关系冲突与多角色熟悉度是稳定内容资产' },
      { title: '礼貌：你郭奉孝吗？', text: 339, ritual: 18, natural: 321, meaning: '精确to签占比较低，称谓、关系和情境笑点仍承担主体声量' },
      { title: '习惯这东西，真可怕', text: 322, ritual: 19, natural: 303, meaning: '周瑜×孙策×黄盖的熟悉关系结构在净化后仍然成立' },
      { title: '阿瞒：笑就完了！奉孝：救一下啊！', text: 241, ritual: 136, natural: 105, meaning: '56.43%文本为精确to签，原始热度明显混入活动召集能力' },
    ], [
      { label: '视频案例', render: (r) => `<strong>${esc(r.title)}</strong>` },
      { label: '观众文本评论', className: 'num', render: (r) => fmt(r.text) },
      { label: '精确to签', className: 'num', render: (r) => `${fmt(r.ritual)} / ${pct(r.ritual / r.text)}` },
      { label: '净化后文本', className: 'num', render: (r) => fmt(r.natural) },
      { label: '经营解释', render: (r) => esc(r.meaning) },
    ])}
    ${paragraph('活动净化改变的不是“这条内容好不好”的道德评价，而是它究竟完成了什么任务。精确to签多，说明内容或活动具有召集和奖励仪式价值；净化后自然评论仍高，才更支持复制其角色、冲突、节奏与关系结构。两类价值都可以经营，但必须进入不同榜单：仪式榜考核独立参与者、模板复制率和活动后迁移，自然内容榜考核非活动评论者、多人线程、玩家解释和后续自发召回。')}
    <div class="two-col" style="margin-top:20px">
      <div>
        <h3>净化后的共同胜因</h3>
        ${list([
          '不是单一萌物展示，而是至少两名角色之间存在清楚的冲突、默契或误会；',
          '标题使用“奉孝、阿瞒”等熟悉称谓，让玩家立即确认圈层身份；',
          '情境本身对圈外人可读，玩家又能补充人物关系、技能和历史第二字幕；',
          '结尾留下判断、护短或续写空间，评论不是只有“好可爱”一种回答。',
        ])}
      </div>
      <div class="callout">
        <strong>角色关系资产与活动资产必须分账</strong>
        <p>同一条视频可以既是关系内容，又是活动入口，但创意团队不能用活动评论证明关系自然需求。下一轮视频统计应同时保存原始评论、精确to签、礼貌投稿、重复公式和净化后文本五列，并分别计算用户去重数与后续跨视频行为。</p>
      </div>
    </div>
    ${paragraph('当前净化只扣除了编码中的精确to签，是保守下限，并未自动删除所有相似文案、表情图评或活动相关回复。因此它适合发现明显污染，不适合声称得到了“纯自然需求”。更严格版本应对标准化文本做近重复聚类，按活动批次识别模板，并同时报告不净化、精确净化和广义净化三套排名；只有三套结果都稳定的内容结构，才进入季度复制清单。')}
    <h3>既有观众占比领先：更适合拆解账号承接</h3>
    ${table(retentionLeaders, [
      { label: '视频', render: (r) => `<strong>${esc(r.title)}</strong><br><span class="muted">${esc(r.quadrant)} · ${esc(r.primaryArchetypeLabel)}</span>` },
      { label: '既有观众', className: 'num', render: (r) => fmt(r.returningUsers) },
      { label: '既有观众占比', className: 'num', render: (r) => pct(r.returningShare) },
      { label: '首触用户', className: 'num', render: (r) => fmt(r.firstTouchUsers) },
      { label: '文本用户', className: 'num', render: (r) => fmt(r.textAudienceUsers) },
      { label: '严格玩家用户', className: 'num', render: (r) => fmt(r.playerContextUsers) },
      { label: '共创用户', className: 'num', render: (r) => fmt(r.coCreationUsers) },
    ])}
    ${paragraph('既有观众占比高可能来自连续剧情、熟悉角色、发布时间靠后或推荐流向老用户集中，不等于内容“提升留存”。因此榜单设置了既有观众绝对人数门槛，避免小样本视频因几位老用户而获得极高比例。未来应增加经验贝叶斯收缩或Wilson下界，在样本少时自动降低排名。')}
    <h3>玩家语境密度领先：更适合拆解圈层可信度</h3>
    ${table(denseVideos, [
      { label: '视频', render: (r) => `<strong>${esc(r.title)}</strong><br><span class="muted">${esc(r.archetypes.join(' / '))}</span>` },
      { label: '非空评论', className: 'num', render: (r) => fmt(r.nonEmptyComments) },
      { label: '广义语境指涉', className: 'num', render: (r) => `${fmt(r.contextReferenceComments)} / ${pct(r.contextReferenceShare)}` },
      { label: '严格知识评论', className: 'num', render: (r) => `${fmt(r.strictKnowledgeComments)} / ${pct(r.strictKnowledgeShare)}` },
      { label: '关系语境', className: 'num', render: (r) => pct(r.relationshipShare) },
      { label: '共创语境', className: 'num', render: (r) => pct(r.coauthorShare) },
    ])}
    ${paragraph('高语境密度视频的价值是让玩家承担“第二字幕”：他们会解释技能、指出设定、补充表字和历史，帮助内容形成圈层信誉。但广义游戏指涉与严格机制必须分开，出现“三国杀、武将、卡宝”等泛词不能当成规则知识。真正能支撑玩家可信度的是技能重映射、史事互文、设定校验、台词回调和经济记忆等更严格证据。')}
    <div class="verdict"><strong>复盘模板：</strong>每周分别评选入口榜、承接榜、玩家信誉榜、共创榜和商业实验榜。榜单只在同任务内比较，并同步展示样本量、活动流量、观察窗口和不确定区间。</div>
  </section>`);

  sections.push(`
  ${partHead(20, '评论线程与作者回复', '评论区不是附属反馈，而是内容的第二现场；但回复关联不能写成回复效果')}
  <section class="band">
    ${heading('核心判断 20.1', '超过四分之一线程发生回复，但真正多人讨论仍是稀缺资产', `全量共有 ${fmt(deep.community.overallThreads.threads)} 个可观察线程，${pct(deep.community.overallThreads.withReplyRate)} 至少出现回复，${pct(deep.community.overallThreads.threePlusCommentRate)} 达到3条及以上，${pct(deep.community.overallThreads.multiAudienceUserRate)} 有至少两位不同观众参与。线程平均 ${dec(deep.community.overallThreads.averageComments, 2)} 条、最大 ${fmt(deep.community.overallThreads.maxComments)} 条，说明多数评论仍是单点表达，少量线程才形成公共讨论。`) }
    <div class="metric-grid">
      ${metricCard('有回复线程', pct(deep.community.overallThreads.withReplyRate), `${fmt(deep.community.overallThreads.threads)}个线程的结构比例`, 'blue')}
      ${metricCard('3条及以上', pct(deep.community.overallThreads.threePlusCommentRate), '比单次问答更接近持续讨论', 'green')}
      ${metricCard('多观众参与', pct(deep.community.overallThreads.multiAudienceUserRate), '至少两位不同观众，而非作者往返', 'violet')}
      ${metricCard('作者参与线程', pct(deep.community.overallThreads.authorInvolvedRate), '作者进入讨论的观测比例', 'amber')}
    </div>
    <h3>不同内容原型产生不同讨论结构</h3>
    ${table(deep.community.threadsByArchetype, [
      { label: '内容原型', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '线程', className: 'num', render: (r) => fmt(r.threads) },
      { label: '有回复', className: 'num', render: (r) => pct(r.withReplyRate) },
      { label: '3条+', className: 'num', render: (r) => pct(r.threePlusCommentRate) },
      { label: '多观众', className: 'num', render: (r) => pct(r.multiAudienceUserRate) },
      { label: '深回复', className: 'num', render: (r) => pct(r.deepReplyRate) },
      { label: '作者参与', className: 'num', render: (r) => pct(r.authorInvolvedRate) },
      { label: '平均 / 最大', className: 'num', render: (r) => `${dec(r.averageComments, 2)} / ${fmt(r.maxComments)}` },
    ])}
    ${paragraph('线程指标比总评论量更接近社区质量：同样100条评论，100个孤立短句与20个多人往返讨论代表完全不同的关系价值。关系剧情、对话和开放式选择通常更容易形成护短、解释和接梗；活动模板则可能让根评数量增加，却不一定提高多人讨论。因此社群复盘应至少区分根评数、回复率、多人参与率、3条以上线程率和作者参与率。')}
    <h3>作者回复是最值得做随机实验的经营杠杆</h3>
    ${table([
      { label: '首个文本根评被标记作者回复', ...replyAssociation.replied },
      { label: '未标记作者回复', ...replyAssociation.unreplied },
    ], [
      { label: '首根评状态', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '用户', className: 'num', render: (r) => fmt(r.users) },
      { label: '后续跨视频', className: 'num', render: (r) => pct(r.futureCrossVideoRate) },
      { label: '7日机会校正', className: 'num', render: (r) => `${fmt(r.future7dUsers)}/${fmt(r.future7dEligible)} · ${pct(r.future7dRate)}` },
      { label: '后续严格玩家', className: 'num', render: (r) => pct(r.futureStrictRate) },
      { label: '后续有机共创', className: 'num', render: (r) => pct(r.futureOrganicRate) },
      { label: '后续周边 / 购买', className: 'num', render: (r) => `${pct(r.futureMerchandiseRate)} / ${pct(r.futurePurchaseRate)}` },
      { label: '首评均赞', className: 'num', render: (r) => dec(r.averageInitialLikes, 2) },
    ])}
    ${paragraph(`作者回复标记组的后续跨视频评论代理为 ${pct(replyAssociation.replied.futureCrossVideoRate)}，未标记组为 ${pct(replyAssociation.unreplied.futureCrossVideoRate)}；7日机会校正率分别为 ${pct(replyAssociation.replied.future7dRate)} 与 ${pct(replyAssociation.unreplied.future7dRate)}。这是强观察关联，却不是回复效果：数据没有精确回复发生时间，作者可能优先回复原本就更活跃、点赞更高或内容更丰富的评论，同一视频和发布时间也可能同时影响结果。`)}
    <div class="quote-grid">
      ${threadCases.slice(0, 2).map(r => quoteBlock(r.root?.text, r.root?.likes, `${r.label} · 线程${fmt(r.threadSize)}条`)).join('')}
    </div>
    <div class="verdict"><strong>回复RCT：</strong>按视频、小时、首评语境和初始点赞分层，把合格首根评随机分为回复/不回复组，每组至少400；预注册7日跨视频回评为主指标，并记录回复时间。实验前观察差只用于样本量与方向先验。</div>
  </section>`);

  sections.push(`
  ${partHead(21, '仪式机制：to签与礼貌投稿如何放大社群', '仪式能降低参与门槛，也会制造复制文案；它是放大器，不是自然粉丝或购买漏斗')}
  <section class="band">
    ${heading('核心判断 21.1', '仪式把观众变成参与者，但只有内容关系能让仪式留下来', 'to签、礼貌投稿、固定召集句式让用户知道“怎样评论才会被看见”，能迅速提高参与密度；与此同时，它会批量召集角色名和关系词，若不净化，会虚增角色需求、CP需求和评论活跃。')}
    <h3>高频重复公式</h3>
    ${table(repeatedFormulas, [
      { label: '标准化文案', render: (r) => `<strong>${esc(r.text)}</strong><br><span class="muted">${esc(r.codeIds.join(' / '))}</span>` },
      { label: '评论', className: 'num', render: (r) => fmt(r.comments) },
      { label: '用户', className: 'num', render: (r) => fmt(r.users) },
      { label: '视频', className: 'num', render: (r) => fmt(r.videos) },
      { label: '点赞', className: 'num', render: (r) => fmt(r.likes) },
      { label: '解释', render: (r) => r.videos <= 2 ? '更像单次活动或关系模板，应按用户去重并从自然需求剥离。' : '跨视频社群口头禅，可能同时承载账号身份与低成本互动。' },
    ])}
    ${paragraph('礼貌投稿的经营价值不在于“建议数量”，而在于它把内容生产权部分开放给观众：用户不仅评价已经发生的剧情，还提出下一步动作、关系和结局。这是典型的参与式传播。但固定格式越成功，越需要同时报告原始评论数、标准化唯一文本数、独立用户数和跨视频自然表达，否则一条被30人复制的句式会被误读为30种独立需求。')}
    <h3>纯仪式参与与内容+仪式参与必须分开</h3>
    ${table(seedSegments.filter(r => r.id.includes('tosign') || r.id.includes('content')), [
      { label: '人群', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '用户', className: 'num', render: (r) => `${fmt(r.users)} / ${pct(r.userShare)}` },
      { label: '跨视频', className: 'num', render: (r) => pct(r.crossVideoRate) },
      { label: '30日机会校正', className: 'num', render: (r) => `${fmt(r.return30Users)}/${fmt(r.return30Eligible)} · ${pct(r.return30Rate)}` },
      { label: '购买表达', className: 'num', render: (r) => `${fmt(r.purchaseUsers)} / ${pct(r.purchaseRate)}` },
      { label: '经营判断', render: (r) => r.id.includes('pure') ? '活动参与不等于内容关系；不并入角色自然需求。' : '已有内容关系上的仪式放大，可用于召回和共创。' },
    ])}
    <div class="two-col" style="margin-top:18px">
      <div class="callout"><strong>保留仪式</strong><p>固定每周一次投稿窗口、投票和采纳公示；使用匿名提案ID，奖励“被采用的独立创意”而不是重复评论条数；把to签作为感谢和身份确认，而不是所有视频的默认CTA。</p></div>
      <div class="callout"><strong>净化数据</strong><p>角色和关系需求榜默认排除纯to签召集；复制文本按用户去重；活动视频单独打标；观察用户是否在后续非活动视频继续自然点名、解释或共创。</p></div>
    </div>
    <div class="verdict"><strong>仪式健康度：</strong>核心指标不是当期评论数，而是独立提案率、采纳率、非活动视频后续表达率、重复文案率和被采纳用户30日跨视频回评。只有仪式能迁移到自然内容关系，才形成可持续社区资产。</div>
  </section>`);

  sections.push(`
  ${partHead(22, '商业路径：从评论信号到可验证需求', '169条购买表达是强语言信号，不是订单；真正的商业化必须跨越真实行为事件')}
  <section class="band">
    ${heading('核心判断 22.1', '周边与萌化是强商业前置信号，to签不是购买路径', `当前严格购买表达共 ${fmt(commerce.robustness.comments)} 条、${fmt(commerce.robustness.users)} 位用户、${fmt(commerce.robustness.likes)} 个点赞。它是明确语言下限，但没有商品曝光、点击、预约、订金和支付分母，因此不能称购买转化率。`) }
    <div class="metric-grid">
      ${metricCard('严格购买表达', `${fmt(commerce.robustness.users)}人`, `${fmt(commerce.robustness.comments)}评，占文本观众约${pct(commerce.robustness.users / coverage.audienceTextUsers)}`, 'blue')}
      ${metricCard('首个可见文本即表达购买', `${fmt(commerce.path.firstTouchUsers)}人`, '不可解释为首触转化，之前观看行为不可见', 'amber')}
      ${metricCard('此前已有非购买互动', `${fmt(commerce.path.nurturedUsers)}人`, `${pct(commerce.path.nurturedShare)}，可观测培育路径`, 'green')}
      ${metricCard('非购买到购买中位间隔', `${dec(commerce.path.daysToPurchaseStats.median, 2)}天`, '只描述可见评论顺序', 'violet')}
    </div>
    ${paragraph(`购买表达高度受热评影响：点赞中位数为 ${dec(commerce.robustness.medianLikes, 1)}，P90为 ${dec(commerce.robustness.p90Likes, 1)}，Top1评论贡献 ${pct(commerce.robustness.top1Share)} 点赞，Top3贡献 ${pct(commerce.robustness.top3Share)}。但剔除Top3后仍保留 ${fmt(commerce.robustness.afterRemovingTop3.users)} 位用户和 ${fmt(commerce.robustness.afterRemovingTop3.comments)} 条表达，说明信号不是由三条热评凭空制造，只是社会认同的可见度高度集中。`)}
    <h3>不同首触信号之后出现购买表达的观测率</h3>
    ${table(commerce.leadingSignals, [
      { label: '首触信号', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '有后续机会用户', className: 'num', render: (r) => fmt(r.users) },
      { label: '后来购买表达', className: 'num', render: (r) => fmt(r.laterPurchaseUsers) },
      { label: '观测率', className: 'num', render: (r) => pct(r.laterPurchaseRate) },
      { label: '解释', render: (r) => r.id === 'merchandise' ? '最强前置信号，但定义与购买语义有邻近性。' : r.id === 'cute' ? '支持“可爱→可拥有”的商品想象。' : r.id === 'ritual' ? '活动参与不自然导向购买。' : '描述关联，受评论次数和内容机会影响。' },
    ])}
    ${paragraph('前置信号只能在有后续观察机会、且首触尚未购买的人群中比较。即便如此，仍存在“评论越多越容易命中标签”的机会偏差；周边兴趣与严格购买词典也存在语义邻近。因此它们适合用来确定商品概念测试优先级，不适合写成转化率或因果路径。')}
    <div class="quote-grid">
      ${firstPurchaseQuote ? quoteBlock(firstPurchaseQuote.text, firstPurchaseQuote.likes, '情感对象向实物迁移') : ''}
      ${meaningSystem.filter(r => r.id === 'affect_ownership').slice(0, 1).map(r => quoteBlock(r.quotes[0]?.text, r.quotes[0]?.likes, '萌化与占有语言')).join('')}
    </div>
    ${paragraph(`在 ${fmt(commerce.path.nurturedUsers)} 位此前已有非购买互动、后来出现购买表达的用户中，过往内容参与、角色识别和萌化语言比纯仪式更常出现；但这只说明可见路径。真正的商业漏斗必须新增“商品内容曝光 → 详情点击 → 到货提醒/预约 → 订金 → 支付 → 退款/取消”的事件链，并将评论语言作为解释变量，而不是结果变量。`)}
    <div class="verdict"><strong>商业决策门槛：</strong>评论表达只决定“测试什么”，不决定“生产多少”。没有点击、预约和订金之前，不进入规模备货；没有取消和退款之前，不称成功销售。</div>
  </section>`);

  sections.push(`
  ${partHead(23, '商品策略：先验证可拥有物，再决定角色与套装', '玩偶是最强品类方向；关系热度、标题场景与SKU偏好必须拆开')}
  <section class="band">
    ${heading('核心判断 23.1', '商品表达由萌化和实体想象直接触发，而不是由硬核黑话或CP热度自动触发', '严格购买评论中，“玩偶/娃娃”和泛周边是主要品类语言；萌化、卡宝人格和角色识别比机制、关系叙事更常与购买句出现在同一条评论。最合理的第一步是验证单体玩偶与卡宝通用挂件，而不是直接按热门CP生产双人套装。')}
    <h3>严格购买表达中的品类方向</h3>
    ${table(commerce.purchaseCategories, [
      { label: '品类', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '评论', className: 'num', render: (r) => fmt(r.comments) },
      { label: '用户', className: 'num', render: (r) => fmt(r.users) },
      { label: '占购买表达用户', className: 'num', render: (r) => pct(r.userShare) },
      { label: '产品含义', render: (r) => ({
        doll: '最清晰的实体化方向，应优先做尺寸、表情、站姿和材质概念。',
        generic: '需求明确但品类未定，适合概念选择而不是直接备货。',
        plush: '样本较小，可作为挂件/小体积方案的探索项。',
        sticker: '数字产品成本低，适合测试角色表情与使用场景。',
        figure: '样本不足，不宜作为首发重投入品类。',
        blind_box: '当前没有形成稳定明确购买表达。',
      }[r.id] || '小样本探索方向') },
    ])}
    <h3>购买句出现时，同一条评论在说什么</h3>
    ${table(commerce.purchaseContexts, [
      { label: '同评语境', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '评论', className: 'num', render: (r) => fmt(r.comments) },
      { label: '用户', className: 'num', render: (r) => fmt(r.users) },
      { label: '占购买表达用户', className: 'num', render: (r) => pct(r.userShare) },
      { label: '解释', render: (r) => r.id === 'cute' ? '商品想象与可爱、萌化直接共现。' : r.id === 'mascot' ? '卡宝作为情感对象被要求实体化。' : r.id === 'character' ? '部分用户明确角色，但不能用标题替代正文点名。' : r.id === 'strict' ? '硬核语境并非主要购买触发。' : r.id === 'relationship' ? '关系热度没有自动进入购买句。' : '只作同评共现，不作因果。' },
    ])}
    ${paragraph(`另有 ${fmt(commerce.priceSensitiveUsers)} 位价格敏感用户，绝对样本不足以直接设定价格带。热评“价格不要太贵”可以证明价格是决策变量，却不能回答99元、129元还是199元更优。价格需要与尺寸、材质和套装形式共同随机测试，或采用Van Westendorp/阶梯报价收集支付意愿。`)}
    <div class="three-col">
      <article class="callout"><strong>Concept A · 单武将玩偶</strong><p>先选高商品语境且正文直接点名的角色；展示正侧背、耳朵/服饰细节、大小参照和可拆部件。主指标为到货提醒、订金和支付。</p></article>
      <article class="callout"><strong>Concept B · 卡宝通用挂件</strong><p>降低角色押注与库存复杂度，验证“卡宝本体”作为可拥有对象的广度。测试毛绒/亚克力、包挂/桌摆两种场景。</p></article>
      <article class="callout"><strong>Concept C · 双人关系套装</strong><p>只在周瑜×孙策、姜维×钟会等明确关系轴上独立测试。必须与同价单体方案随机对照，不能以CP评论替代购买。</p></article>
    </div>
    <h3>假设性单位经济：展示为什么评论不能直接决定备货</h3>
    ${table(commerce.scenario.rows, [
      { label: '种子池', render: (r) => esc(r.seed) },
      { label: '种子用户', className: 'num', render: (r) => fmt(r.seedUsers) },
      { label: '假设购买率', className: 'num', render: (r) => pct(r.conversion, 0) },
      { label: '假设销量', className: 'num', render: (r) => fmt(r.units) },
      { label: '收入', className: 'num', render: (r) => `¥${fmt(r.revenue)}` },
      { label: '扣除变动与固定成本', className: 'num', render: (r) => `${r.contribution >= 0 ? '' : '-'}¥${fmt(Math.abs(r.contribution))}` },
    ])}
    ${paragraph(`上表只是敏感性演算：假设单价 ¥${fmt(commerce.scenario.assumptions.defaultPrice)}、单位变动成本 ¥${fmt(commerce.scenario.assumptions.variableCost)}、固定投入 ¥${fmt(commerce.scenario.assumptions.fixedCost)}，盈亏平衡约需 ${fmt(commerce.scenario.breakEvenUnits)} 件。若只依赖 ${fmt(commerce.scenario.assumptions.intentUsers)} 位严格购买表达者，假设购买率需接近 ${pct(commerce.scenario.breakEvenConversionStrict)}；即便以 ${fmt(commerce.scenario.assumptions.merchandiseUsers)} 位周边兴趣用户为种子，也需约 ${pct(commerce.scenario.breakEvenConversionMerchandise)}。这正说明必须先用真实预约/订金缩小不确定性。`)}
    <div class="verdict"><strong>商品Gate：</strong>G0语言信号 → G1概念点击 → G2有效预约 → G3可退订金 → G4小批支付 → G5复购/推荐。每一关单独设阈值和停止条件，禁止从G0直接跳到量产。</div>
  </section>`);

  sections.push(`
  ${partHead(24, '经营节奏：把内容变成可学习的组合系统', '7天承接一个入口，4周验证一个角色，90天形成内容—社群—商品的证据闭环')}
  <section class="band">
    ${heading('核心判断 24.1', '发布日历要围绕关系进程，而不是平均分配角色', '重复互动者的第二次互动往往集中在首个可见评论后的短窗口，说明入口内容之后需要及时承接。团队不应把每条视频视为独立作品，而要以“入口、解释、共创、回收”构成连续经营单元。')}
    <h3>建议的7天内容承接单元</h3>
    <div class="timeline">
      <article><strong>D1 · 入口片</strong><p>视觉冲突、角色动作或关系误会。圈外人无需前置知识即可理解，CTA为判断/选择。主指标：独立首触评论者和有效短回答。</p></article>
      <article><strong>D2 · 评论回收</strong><p>18—22点集中回复高信息根评，置顶一个玩家解释和一个圈外问题。回复时点完整记录，为后续RCT留证据。</p></article>
      <article><strong>D3 · 玩家解释片</strong><p>用技能、表字、历史或台词解释D1冲突，配一句白话。主指标：严格玩家评论、纠错质量和圈外理解问题。</p></article>
      <article><strong>D5 · 共创片</strong><p>开放下一步选择或悲剧修复，不诱导固定复制句。主指标：独立提案用户、多人线程和非模板行动请求。</p></article>
      <article><strong>D7 · 续作兑现</strong><p>采纳一个提案并署名匿名ID，展示“评论真的改变内容”。主指标：提案者与同队列用户跨视频回评。</p></article>
      <article><strong>D7+ · 商品旁路</strong><p>只对出现稳定可拥有语言的角色做概念测试，不打断主剧情。主指标：点击、预约、订金，不使用评论量。</p></article>
    </div>
    ${paragraph('评论小时分布可用于安排人工值班，却不能直接判断最佳发布时间，因为视频本身的发布时间高度集中且只有少数记录完整。建议先把18—22点作为回复与话题回收窗口，再通过随机发布时间实验比较同类内容，而不是把现有评论峰值解释为自然活跃峰值。')}
    <h3>90天资源配置</h3>
    <div class="priority-list">
      <article><span>01</span><div><strong>40% 核心盘连续叙事</strong><p>曹操、钟会、姜维、周瑜及周孙/姜钟主轴。目标是维持规模、跨视频关系和共创，不为追热点频繁换人物。</p></div></article>
      <article><span>02</span><div><strong>20% 玩家信誉内容</strong><p>技能重映射、历史互文、设定核验和台词回调。每条给圈外白话，防止内容只服务硬核圈层。</p></div></article>
      <article><span>03</span><div><strong>20% 角色增供实验</strong><p>曹冲、张飞、关羽、于吉等候选按机制版×萌化版测试，以后续非标题召回决定是否进入系列。</p></div></article>
      <article><span>04</span><div><strong>10% 社群仪式</strong><p>每周一次投稿/投票/采纳公示，控制复制文案，衡量独立提案与非活动后续关系。</p></div></article>
      <article><span>05</span><div><strong>10% 商品概念</strong><p>单体玩偶、通用挂件、关系套装分开测试。只在完成曝光埋点与真实事件链后扩大。</p></div></article>
    </div>
    ${paragraph('资源比例是当前证据下的测试组合，不是长期固定预算。每四周根据任务榜重新分配：入口内容看首触与第二互动，信誉内容看严格语境与纠错，关系内容看自然同提与行动请求，商品内容看真实行为。任何单一指标上升都不能独自赢得预算。')}
    <h3>把“继续做”写成可证伪的决策规则</h3>
    ${table([
      { object: '入口型内容', continue: '同任务匹配样本中，独立首触规模稳定高于中位，且7天内出现跨视频承接', stop: '连续两批只有原始评论上升，净化后首触和第二互动均无改善', evidence: '曝光、独立首触、7日跨视频、活动净化' },
      { object: '玩家信誉内容', continue: '严格机制/史事/设定评论稳定出现，纠错可控，圈外问题没有显著恶化', stop: '只剩泛称或知识堆砌，严格知识评论与后续账号迁移均弱', evidence: '严格知识率、纠错线程、圈外理解问题' },
      { object: '关系连续剧', continue: '非标题自发同提、行动型续作和多人线程在连续两批复现', stop: '声量主要来自标题被动曝光或固定投稿模板，跨内容主动召回不增长', evidence: '自然同提、行动请求、多人线程、后续召回' },
      { object: '作者回复', continue: '分层随机实验中7日跨视频回评差异达到预注册阈值且方向跨批次稳定', stop: '控制视频/时段/首评质量后效果消失，或回复成本超过增量价值', evidence: '随机组、真实回复时间、7日机会、成本' },
      { object: '商品概念', continue: '点击、有效预约或订金至少一项达到预注册门槛，取消率与边际贡献可接受', stop: '只有评论想要，真实点击/留资不发生；或需要不现实购买率才能回本', evidence: '曝光、点击、预约、订金、取消、单位经济' },
    ], [
      { label: '对象', render: (r) => `<strong>${esc(r.object)}</strong>` },
      { label: '继续条件', render: (r) => esc(r.continue) },
      { label: '停止/重做条件', render: (r) => esc(r.stop) },
      { label: '最低证据', render: (r) => esc(r.evidence) },
    ])}
    ${paragraph('启停规则的关键不是追求统一阈值，而是在实验前冻结“哪一个指标决定资源”。入口内容不能因为点赞高继续，信誉内容不能因为购买表达低停止，关系内容不能因为活动模板多而被判为强需求，商品内容也不能因为评论区热情就直接备货。每个任务只允许一个主指标，所有辅助指标用于解释，不允许在结果出来后挑一个最好看的数。')}
    <h3>实验功效与样本现实：先承认能检出的效果有多大</h3>
    ${table([
      { experiment: '作者回复RCT', unit: '首触根评论者', sample: '约400人/组', detect: '适合识别约10个百分点的大效应', next: '若目标是5个百分点，需约1,478人/组并记录真实回复时间' },
      { experiment: '萌化×机制 2×2', unit: '同角色、同长度、同时间窗视频', sample: '每格至少6条起步', detect: '先看方向与跨批次稳定性，不做精细因果承诺', next: '主指标为7日跨视频评论者/千合格首触，次指标为商品行为' },
      { experiment: '低供给角色增供', unit: '角色×模板', sample: '4候选×2模板，并配置高供给对照', detect: '检验非标题自发点名是否在后续内容持续出现', next: '本条标题内被动点名不计作需求成功' },
      { experiment: '商品概念测试', unit: '合格商品曝光用户', sample: '按点击/预约基线计算，不沿用评论人数', detect: '比较单体玩偶、通用挂件、关系套装的增量', next: '价格、尺寸与渲染质量保持可比，支付前不外推销量' },
    ], [
      { label: '实验', render: (r) => `<strong>${esc(r.experiment)}</strong>` },
      { label: '随机/比较单位', render: (r) => esc(r.unit) },
      { label: '当前样本建议', render: (r) => esc(r.sample) },
      { label: '能回答什么', render: (r) => esc(r.detect) },
      { label: '升级条件', render: (r) => esc(r.next) },
    ])}
    ${paragraph('现有观察数据最适合提供先验、分层变量和实验候选，不适合替代实验。作者回复标记组与未标记组存在约20个百分点的跨视频差异，但作者可能优先回复本就活跃或高质量的评论；玩家×萌化混合核有更高回评，但标签来自全周期且受评论机会影响。下一阶段的价值不在再算一百个相关系数，而在把高价值关联转成有资格条件、随机单位、观察窗口、主指标、样本量和停止线的实验。')}
    <div class="verdict"><strong>90天决策纪律：</strong>第一个月只修分母与建立基线；第二个月只放大跨两批稳定的内容结构；第三个月只有真实商品行为和可接受单位经济才能获得商业预算。没有曝光分母、没有随机或匹配、没有预注册主指标的结果，只进入洞察库，不进入因果复盘。</div>
    <h3>编辑部每周五个问题</h3>
    ${list([
      '本周哪条内容真正带来新的独立评论者，而不是活动模板或核心用户多说？',
      '哪些首触观众在7天内跨到其他视频，他们迁移到相同角色还是账号整体叙事？',
      '玩家在评论区补充了哪些机制、历史、设定与台词？有哪些误读需要下一条内容回应？',
      '哪些评论成为多人线程和下一集行动请求？作者回复是否按实验规则执行？',
      '商业信号是否从“想要”推进到点击、预约或订金？如果没有，本周不讨论备货。',
    ])}
    <div class="verdict"><strong>组织变化：</strong>创意复盘从“播放/赞评最高”改为“任务是否完成”。一个月后保留能跨批次复现的结构，淘汰只依赖单条热评、活动召集或特定角色曝光的假规律。</div>
  </section>`);

  sections.push(`
  ${partHead(25, 'KPI看板与数据治理', '把98项诊断指标收束为一棵可行动的经营树')}
  <section class="band">
    ${heading('核心判断 25.1', '北极星不是评论总量，而是“形成下一次关系的独立受众”', '评论总量容易被高频用户、作者回复、活动模板、空文本和热评放大。经营看板应以独立用户和时间队列为骨架，再分别衡量触达、信誉、关系和商业。98项指标留作诊断层，不应全部挤进周报。')}
    <div class="matrix">
      <article><h3>Reach · 触达代理</h3>${list(['新首触独立评论者', '首触用户/千曝光', '入口内容覆盖', '一次互动池规模', '第二互动中位时延'])}</article>
      <article><h3>Trust · 玩家信誉</h3>${list(['严格机制/史事/设定用户率', '解释与纠错线程', '圈外理解问题率', '玩家×萌化混合核', '机制内容跨批次稳定性'])}</article>
      <article><h3>Community · 关系</h3>${list(['7/30日跨视频回评', '多观众线程率', '独立共创用户', '非活动自然提及', '作者回复RCT效应'])}</article>
      <article><h3>Commerce · 商业</h3>${list(['商品概念曝光', '详情点击率', '有效预约/订金', '支付与取消', '角色/品类增量差异'])}</article>
    </div>
    <h3>周报、月报、季度决策使用不同层级</h3>
    <div class="three-col">
      <article class="callout"><strong>周报 · 运营动作</strong><p>按视频任务列首触、既有观众、线程、作者回复、活动模板、严格语境和商品点击。目的：下周改什么。</p></article>
      <article class="callout"><strong>月报 · 队列关系</strong><p>按首触月观察7/30日跨视频、部落迁移、角色非标题召回和实验效应。目的：内容组合是否沉淀关系。</p></article>
      <article class="callout"><strong>季度 · 预算决策</strong><p>比较跨批次稳定性、角色/关系资产、真实商业事件和单位经济。目的：扩什么、停什么、投多少。</p></article>
    </div>
    <h3>必须新增的数据字段</h3>
    ${table([
      ['曝光', '视频/用户级曝光、推荐来源、首曝时间', '区分没看见与看见后不互动，计算真实触达和转化分母'],
      ['观看', '播放、有效播放、完播、停留、重复观看', '识别内容理解和叙事承接，不再用评论者代表观看者'],
      ['关系', '关注时间、主页访问、跨视频观看、收藏、分享', '把评论回评代理升级为平台关系事件'],
      ['运营', '作者回复时间、回复策略、是否随机、置顶/删除', '判断回复先后并降低选择偏差'],
      ['活动', 'to签/投稿批次、规则、奖励、曝光入口', '分离活动参与与自然内容需求'],
      ['商业', '商品曝光、点击、预约、订金、支付、取消/退款', '建立真实商品漏斗和单位经济'],
      ['内容', '角色、关系、机制钩子、萌化钩子、时长、发布时间', '支持2×2实验、分层比较与模型控制'],
    ].map((r) => ({ field: r[0], data: r[1], purpose: r[2] })), [
      { label: '域', render: (r) => `<strong>${esc(r.field)}</strong>` },
      { label: '需要采集', render: (r) => esc(r.data) },
      { label: '解决什么问题', render: (r) => esc(r.purpose) },
    ])}
    ${paragraph('指标治理还需要冻结版本：词典、去重主键、活动排除规则、角色别名、观察窗口和机会校正条件必须有版本号；每个实验预注册主指标、样本量与停止条件；每次报告同时保留全样本、剔除Top1%高频用户、剔除Top3热评和活动净化后的结果。只有同方向结论才能进入预算决策。')}
    <h3>管理层一页看板的12个字段</h3>
    ${list([
      '本周合格曝光、独立观看者、独立评论者、首触评论者；',
      '7日跨视频观看与跨视频评论，两者分开；',
      '严格玩家解码用户、玩家×萌化混合核、有机共创用户；',
      '多人线程率、作者回复RCT执行率；',
      '商品点击、有效预约、订金/支付与取消；',
      '当前最大证据风险和下一项必须验证的假设。',
    ])}
    <div class="verdict"><strong>看板原则：</strong>总量回答“发生了多少”，比例回答“结构如何”，区间回答“有多不确定”，队列回答“关系是否继续”，实验回答“是不是动作造成”。四类问题不能由一个KPI代答。</div>
  </section>`);

  sections.push(`
  ${partHead(26, '证据限制与反误读审计', '把不能回答的问题写清楚，才能让能回答的结论更有决策价值')}
  <section class="band">
    ${heading('审计结论 26.1', '本报告是评论关系与语境研究，不是全平台受众画像', `数据覆盖 ${fmt(coverage.videos)} 条视频、${fmt(coverage.audienceComments)} 条非作者观众评论、${fmt(coverage.audienceUsers)} 位可识别评论者；语义分析只在 ${fmt(coverage.audienceTextComments)} 条有文本评论和 ${fmt(coverage.audienceTextUsers)} 位有文本用户上进行。它能深入解释“留下评论的人怎样参与”，不能代表没有评论的观看者、全部粉丝或三国杀市场总体。`) }
    <div class="priority-list">
      <article><span>01</span><div><strong>曝光分母缺失</strong><p>没有用户级曝光、有效播放、完播、关注和分享，无法计算真实获客率、互动率或平台留存。标题场景评论者也不是曝光用户。</p></div></article>
      <article><span>02</span><div><strong>全周期标签存在时间泄漏</strong><p>如果用用户整个样本期是否曾“严格玩家/萌化/共创”去解释整个样本期跨视频行为，会把未来特征带回过去。当前只作描述，实验和预测必须冻结首触特征。</p></div></article>
      <article><span>03</span><div><strong>高频用户存在机会偏差</strong><p>评论越多的人越容易命中任意语义码、跨更多视频、被作者回复，也更容易出现购买表达。组间比例不能自动解释为标签导致行为。</p></div></article>
      <article><span>04</span><div><strong>分母U1与U2不同</strong><p>生命周期使用全部可识别评论者；语义部落只使用有文本用户。无文本、图片或空文本用户不能被错误归入L0或“既非玩家也非萌化”。</p></div></article>
      <article><span>05</span><div><strong>L1不是有序深度</strong><p>L1混合一般提问、商业、仪式与边界表达，不应解释为从L0到L4的单调成长阶梯。五层是互斥分析规则，不是价值等级。</p></div></article>
      <article><span>06</span><div><strong>严格玩家需继续细分</strong><p>表字/稳定昵称反映角色身份熟悉，机制、历史、设定和经济记忆才更接近知识解码。两者不能统一称为“硬核玩家”。</p></div></article>
      <article><span>07</span><div><strong>作者回复缺少先后与随机性</strong><p>回复标记没有可靠时间，作者可能优先选择高质量评论；观察差只能作为RCT先验，不能写成回复提升复访。</p></div></article>
      <article><span>08</span><div><strong>活动流量污染自然需求</strong><p>to签、礼貌投稿和固定句式会批量召集角色与关系词。角色、关系和复访分析必须报告活动净化版本。</p></div></article>
      <article><span>09</span><div><strong>小样本比例不稳定</strong><p>关系对、价格敏感、字幕诉求和部分角色只有少量用户。比例必须配分子分母、区间或收缩估计，只作为探索信号。</p></div></article>
      <article><span>10</span><div><strong>角色词典并非全武将</strong><p>别名有碰撞，漏项仍可能存在；标题供给也会塑造评论词汇。需求指数是本账号相对机会，不是市场份额。</p></div></article>
      <article><span>11</span><div><strong>语义规则需要人工复核</strong><p>粉圈反讽、角色台词和剧情引用会误伤情感词；“卖血、屯田”等有机制与日常双义。当前是计算辅助扎根式分析，不替代双人盲编码。</p></div></article>
      <article><span>12</span><div><strong>评论购买语言不是订单</strong><p>严格购买表达是测试优先级，不是GMV或付费率。商品决策必须加入真实曝光、点击、预约、订金、支付与取消。</p></div></article>
    </div>
    <div class="quote-grid" style="margin-top:20px">
      ${boundaryQuote ? quoteBlock(boundaryQuote.text, boundaryQuote.likes, '真实内容边界反例') : ''}
      ${meaningSystem.filter(r => r.id === 'boundary').slice(0, 1).map(r => quoteBlock(r.quotes[0]?.text, r.quotes[0]?.likes, '身份/设定困惑')).join('')}
    </div>
    ${paragraph('边界与负面评论不能被平均正向声量抹去。真实拒绝可能是在要求回到“三国小剧场”，身份困惑可能说明新观众不知道卡宝与角色是什么关系，字幕诉求虽然样本小，却对应静音和听力等具体场景。这些信号不是“负面率”，而是内容产品的适配需求：需要明确账号承诺、补齐字幕、解释卡宝身份，并保留不同内容方向的选择。')}
    <h3>下一轮研究如何提高可信度</h3>
    ${list([
      '抽取不少于600条评论做双人盲编码，报告各主轴precision/recall或Cohen kappa，并记录反例和饱和过程；',
      '将“表字/昵称熟悉”与“机制/历史/设定知识”拆成两类玩家信号，分别观察内容与关系行为；',
      '按用户前两次评论冻结画像，观察之后7/30天结果，消除部分未来信息泄漏；',
      '所有视频率指标设置最小样本门槛，并报告Wilson下界或经验贝叶斯收缩排名；',
      '对作者回复、内容语境和商品概念执行随机实验，补齐曝光与真实事件链；',
      '每轮同时输出全样本、活动净化、剔除Top1%高频用户与留一视频敏感性结果。',
    ])}
    <div class="verdict"><strong>最终边界：</strong>这份报告可以支持“下一轮内容、社群和商品该测试什么”；仍不能支持“市场有多大、哪种内容必然提升留存、某角色一定能卖多少”。把这条边界守住，才不会让丰富的数据方法制造虚假确定性。</div>
  </section>`);

  return sections.join('\n');
}
