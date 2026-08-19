export function buildRepeatCommenterSection(ctx) {
  const { repeatData, identifiedTiming, fmt, dec, pct, esc, partHead, metricCard, finding, table } = ctx;
  const repeat = repeatData.repeat;
  const core = repeatData.coreRepeat;
  const tiers = repeatData.allTiers;
  const strictCuteCells = repeatData.strictCuteRepeatCells;
  const contextByLabel = new Map(repeat.contextLevels.map((row) => [row.label, row]));
  const flag = (name) => repeat.flags[name] || { users: 0, rate: 0 };
  const cellByLabel = new Map(strictCuteCells.map((row) => [row.label, row]));
  const cell = (label) => cellByLabel.get(label) || { users: 0, flags: {}, continuedObservation: { day30: { users: 0, denominator: 0 } } };
  const contextCount = (label) => contextByLabel.get(label)?.count || 0;
  const contextShare = (label) => contextByLabel.get(label)?.share || 0;
  const repeatSemanticUsers = repeat.textUsers;
  const seven = repeat.continuedObservation.day7;
  const thirty = repeat.continuedObservation.day30;
  const first = tiers[0];
  const frequent = tiers[2];
  const coreCell = cell('玩家×萌化');
  const temporal = identifiedTiming || {};
  const intervals = temporal.intervals || { n: 0, buckets: {}, bucketShares: {} };
  const sessions = temporal.sessions || {};
  const topProfiles = Array.isArray(temporal.topProfiles) ? temporal.topProfiles.slice(0, 5) : [];
  const monthRows = Array.isArray(temporal.entryMonths) ? temporal.entryMonths : [];
  const weekdayRows = Array.isArray(temporal.weekdays) ? temporal.weekdays : [];
  const displayProfile = (row) => row['昵称（样本期常用）'] || '未提供昵称';
  const profileLink = (row) => {
    const url = row['主页'] || '';
    return url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(displayProfile(row))}</a>` : esc(displayProfile(row));
  };

  const paragraph = (text) => `<p class="longform">${text}</p>`;
  const list = (items) => `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
  const archetypeRows = repeatData.archetypes.map((row) => ({
    ...row,
    repeatTextShare: row.users / Math.max(1, repeatSemanticUsers),
  }));

  return `
  ${partHead(27, '多次评论用户的具名背景与时序', '保留昵称、主页、原始评论与精确时间：从“谁评论得多”还原为可核查的参与轨迹')}
  <section class="band">
    <p class="lead"><strong>结论先行：</strong>本节按需求启用<strong>内部具名口径</strong>，保留用户在源数据中提供的昵称、主页、原始评论与精确时间。${fmt(repeatData.meta.repeatUsers)} 位至少评论两次的用户占全部可识别评论者 ${pct(repeatData.meta.repeatUserRate)}，却贡献 ${fmt(repeat.comments)} 条观众评论、占 ${pct(repeat.commentShare)}。他们不是可由年龄、性别或收入概括的人群，而是一条由<strong>角色识别 → 玩家解码 / 萌化情感 → 关系共创</strong>构成的可观察参与带。以下具名证据仅限内部复盘，不公开转载或二次分发。</p>

    <div class="metric-grid">
      ${metricCard('多次评论用户', `${fmt(repeat.users)}人`, `占全部评论用户 ${pct(repeat.userShare)}；定义为样本内至少两次评论`, 'blue')}
      ${metricCard('跨视频评论', `${pct(repeat.crossVideoRate)}`, `${fmt(Math.round(repeat.users * repeat.crossVideoRate))}/${fmt(repeat.users)} 人至少跨两条视频发言`, 'green')}
      ${metricCard('超过7天跨视频', `${pct(repeat.cross7Rate)}`, `不是同日连评；仍只是可见评论关系代理`, 'violet')}
      ${metricCard('10次以上核心', `${fmt(core.users)}人`, `占用户 ${pct(core.userShare)}，贡献 ${pct(core.commentShare)} 的观众评论`, 'amber')}
    </div>

    <div class="finding-grid">
      ${finding('这是一群“会迁移”的评论者，而不只是同帖回话的人', `复评者平均涉及 ${dec(repeat.avgVideos, 2)} 条视频，${pct(repeat.crossVideoRate)} 跨视频评论；第二次可观测互动的中位间隔为 ${dec(repeat.secondLagHours.median, 1)} 小时（n=${fmt(repeat.secondLagHours.n)}）。其中 ${pct(repeat.cross30Rate)} 的人跨视频跨度超过30天。`, 'Behavior background', 'green')}
      ${finding('可见续评在时间窗内仍然存在，但不能叫“平台留存”', `在首个评论后仍有至少7天观察机会的 ${fmt(seven.denominator)} 人中，${fmt(seven.users)} 人此后继续评论（${pct(seven.users / seven.denominator)}）；30天机会窗口为 ${fmt(thirty.users)}/${fmt(thirty.denominator)}（${pct(thirty.users / thirty.denominator)}）。这是样本内可见回评，不含只看不评、关注或推荐曝光。`, 'Observation window', 'blue')}
    </div>

    <h3>1. 频次不是“铁粉”标签，而是一条关系深度梯度</h3>
    ${table(tiers, [
      { label: '样本内评论频次', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '用户 / 评论贡献', className: 'num', render: (r) => `${fmt(r.users)}人 · ${pct(r.userShare)}<br>${fmt(r.comments)}评 · ${pct(r.commentShare)}` },
      { label: '平均涉及视频', className: 'num', render: (r) => `${dec(r.avgVideos, 2)} 条` },
      { label: '跨视频', className: 'num', render: (r) => pct(r.crossVideoRate) },
      { label: '跨视频且>7天', className: 'num', render: (r) => pct(r.cross7Rate) },
      { label: '严格玩家语境', className: 'num', render: (r) => `${fmt(r.flags['严格玩家解码'].users)}/${fmt(r.textUsers)} · ${pct(r.flags['严格玩家解码'].rate)}` },
      { label: '萌化情感', className: 'num', render: (r) => `${fmt(r.flags['萌化情感'].users)}/${fmt(r.textUsers)} · ${pct(r.flags['萌化情感'].rate)}` },
      { label: '严格购买表达', className: 'num', render: (r) => `${fmt(r.flags['严格购买表达'].users)}/${fmt(r.textUsers)} · ${pct(r.flags['严格购买表达'].rate)}` },
    ])}
    ${paragraph(`频次越高，跨视频、跨7天、角色/玩家/萌化语境和周边表达均呈单调上升：单次评论者不跨视频；2–3次用户中已有 ${pct(tiers[1].crossVideoRate)} 跨视频；4–9次用户达到 ${pct(frequent.crossVideoRate)}；10次以上核心达到 ${pct(core.crossVideoRate)}。这更像“有更多可见互动机会的人，更容易显示出更丰富的内容关系”，而不是高频评论本身造成了兴趣加深。经营上，频次适合作为<strong>服务优先级</strong>，不能充当“忠诚度真值”或消费能力标签。`)}

    <h3>2. 复评者的文化背景：角色是入口，玩家语境与共创是加深关系的两条路径</h3>
    <div class="two-col">
      <div>
        <h4>五层可观测语境（${fmt(repeatSemanticUsers)} 位有文本复评用户）</h4>
        ${table([
          ['L0 未编码互动', '现有词典未命中，不等于不是玩家或没有兴趣'],
          ['L1 其他已编码表达', '提问、商业、仪式或边界表达，尚未进入主轴'],
          ['L2 角色/萌化身份', '点名武将、别称、卡宝人格或可爱化表达'],
          ['L3 严格玩家解码', '表字/稳定昵称、机制、版本、史事或设定互文'],
          ['L4 有机共创', '关系剧情、护短、修复、角色扮演、追更；排除纯活动口令'],
        ].map(([label, meaning]) => ({ label, meaning, count: contextCount(label), share: contextShare(label) })), [
          { label: '语境层', render: (r) => `<strong>${esc(r.label)}</strong>` },
          { label: '用户', className: 'num', render: (r) => `${fmt(r.count)} / ${pct(r.share)}` },
          { label: '可观测背景', render: (r) => esc(r.meaning) },
        ])}
      </div>
      <div>
        <h4>不能把“严格玩家命中”缩成技能专家</h4>
        ${list([
          `角色识别：${fmt(flag('角色识别').users)}人 / ${pct(flag('角色识别').rate)}。角色名、表字和稳定昵称是复评关系最广泛的内容入口。`,
          `严格玩家解码：${fmt(flag('严格玩家解码').users)}人 / ${pct(flag('严格玩家解码').rate)}。它包含表字、稳定昵称、机制、版本、史事和设定等圈内语言，不等于全部是规则专家。`,
          `严格机制重映射：${fmt(flag('机制映射').users)}人 / ${pct(flag('机制映射').rate)}；史事/设定互文：${fmt(flag('史事与设定').users)}人 / ${pct(flag('史事与设定').rate)}。这是更窄、更高置信度的“懂游戏/懂典故”信号。`,
          `关系/剧情共创：${fmt(flag('关系共创').users)}人 / ${pct(flag('关系共创').rate)}；叙事追问：${fmt(flag('叙事追问').users)}人 / ${pct(flag('叙事追问').rate)}。他们把内容从“看懂”推进到“要下一段”。`,
          `投稿仪式：${fmt(flag('投稿仪式').users)}人 / ${pct(flag('投稿仪式').rate)}。这是账号活动语法的参与，不可直接并作自然角色偏好或商业意图。`,
        ])}
      </div>
    </div>
    ${paragraph(`有文本的复评用户中，L2–L4 合计 ${fmt(contextCount('L2 角色/萌化身份') + contextCount('L3 严格玩家解码') + contextCount('L4 有机共创'))} 人，占 ${pct((contextCount('L2 角色/萌化身份') + contextCount('L3 严格玩家解码') + contextCount('L4 有机共创')) / repeatSemanticUsers)}；其中 L3+L4 为 ${fmt(contextCount('L3 严格玩家解码') + contextCount('L4 有机共创'))} 人、占 ${pct((contextCount('L3 严格玩家解码') + contextCount('L4 有机共创')) / repeatSemanticUsers)}。所以复评不是单纯“打卡”：相当一部分人会使用角色别称、技能/版本黑话、历史设定或关系剧情继续参与。但分析只说明他们在这批语料中这样表达，不能断言他们的游戏时长、段位、消费等级或真实身份。`)}

    <h3>3. “懂游戏”和“愿意萌化角色”同时出现时，才构成最稳定的可观测社群核</h3>
    ${table(['二者皆无', '仅玩家', '仅萌化', '玩家×萌化'].map((label) => {
      const row = cell(label);
      const d30 = row.continuedObservation.day30;
      return {
        label,
        ...row,
        return30: d30.users / Math.max(1, d30.denominator),
        relationship: row.flags['关系共创'],
        merchandise: row.flags['周边兴趣'],
        purchase: row.flags['严格购买表达'],
      };
    }), [
      { label: '语境组合', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '复评用户', className: 'num', render: (r) => `${fmt(r.users)} / ${pct(r.users / repeatSemanticUsers)}` },
      { label: '跨视频', className: 'num', render: (r) => pct(r.crossVideoRate) },
      { label: '跨视频且>7天', className: 'num', render: (r) => pct(r.cross7Rate) },
      { label: '30日可见续评', className: 'num', render: (r) => `${fmt(r.continuedObservation.day30.users)}/${fmt(r.continuedObservation.day30.denominator)} · ${pct(r.return30)}` },
      { label: '关系共创', className: 'num', render: (r) => `${fmt(r.relationship.users)} · ${pct(r.relationship.rate)}` },
      { label: '周边 / 购买', className: 'num', render: (r) => `${pct(r.merchandise.rate)} / ${pct(r.purchase.rate)}` },
    ])}
    ${paragraph(`四格不是互斥的人口学部落，而是复评用户全周期出现过的表达组合。最值得经营的是 ${fmt(coreCell.users)} 人“玩家×萌化”混合核：${pct(coreCell.crossVideoRate)} 跨视频、${pct(coreCell.cross7Rate)} 跨视频且超过7天，30日机会校正的可见续评为 ${pct(coreCell.continuedObservation.day30.users / coreCell.continuedObservation.day30.denominator)}，关系共创达到 ${pct(coreCell.flags['关系共创'].rate)}。这说明“机制可信度”和“情感占有”并非互相稀释，反而经常共同出现。与此同时，只有萌化语言的复评者购买表达率为 ${pct(cell('仅萌化').flags['严格购买表达'].rate)}，高于仅玩家的 ${pct(cell('仅玩家').flags['严格购买表达'].rate)}：萌化更像商品想象入口，严格玩家语境更像持续讨论与内容信誉入口。两者都只是关联，不能作销售预测。`)}

    <h3>4. 多次评论者在账号里分别扮演什么角色</h3>
    ${table(archetypeRows, [
      { label: '可重叠行为背景', render: (r) => `<strong>${esc(r.label)}</strong>` },
      { label: '复评用户', className: 'num', render: (r) => `${fmt(r.users)} / ${pct(r.repeatTextShare)}` },
      { label: '人均评论', className: 'num', render: (r) => dec(r.avgComments, 2) },
      { label: '跨视频', className: 'num', render: (r) => pct(r.crossVideoRate) },
      { label: '周边 / 购买', className: 'num', render: (r) => `${pct(r.flags['周边兴趣'].rate)} / ${pct(r.flags['严格购买表达'].rate)}` },
      { label: '应该承担的任务', render: (r) => {
        const notes = {
          '圈内机制/考据型': '解释、校验、机制反转和历史钩子；需要一句白话承接圈外人。',
          '角色萌化/收藏型': '角色人格、可爱动作、实物概念与商品细节测试。',
          '关系剧情/共创型': '开放结尾、追更、投稿和二次剧情；不把同提自动写成CP。',
          '活动仪式/任务型': '活动扩散和召集；必须净化固定话术后再判断自然内容需求。',
        };
        return esc(notes[r.label] || '按语境单独设计内容任务。');
      } },
    ])}
    <div class="finding-grid">
      ${finding('“高频”首先是内容生产资源', `复评者中根评论占 ${pct(repeat.threadShape.rootComments / (repeat.threadShape.rootComments + repeat.threadShape.replyComments))}，回复占 ${pct(repeat.threadShape.replyShare)}。他们更多是在发起自己的解释、点名、投稿或续作请求，而不仅是跟随热门楼中楼。应给他们角色选择、解释任务和开放结尾，而非只用统一的“求互动”。`, 'Community role', 'violet')}
      ${finding('“高频”不等于“热评制造机”', `复评用户 ${fmt(repeat.comments)} 条评论的中位点赞仍为 ${dec(repeat.likes.median, 0)}，${pct(repeat.likes.zeroRate)} 为零赞。用户价值更多体现在持续的语境生产与跨视频迁移，不应只按单条点赞挑选核心用户。`, 'Measurement correction', 'amber')}
    </div>

    <h3>5. 具名轨迹证据：把“高频用户”还原为可核查的人与原话</h3>
    <p class="longform">下面列出评论量最高的 5 位复评用户。昵称与主页来自源数据，首评、二评、末评均为精确到秒的可观察评论时间，原文不做匿名改写。完整的 ${fmt(temporal.scope?.repeatUsers || 0)} 位用户、${fmt(temporal.scope?.repeatCommentEvents || 0)} 条逐评论时间线见本节末尾具名附录。这里的“最早”仅指当前样本中最早采集到的评论，不等于首次观看、首次关注或真实成为粉丝的时间。</p>
    ${table(topProfiles, [
      { label: '用户与主页', render: (r) => `<strong>${profileLink(r)}</strong><br><span class="muted">${esc(r['主要评论地点标签'] || '无地点标签')} · ${esc(r['语境层'] || '')} · ${esc(r['严格×萌化'] || '')}</span>` },
      { label: '规模', className: 'num', render: (r) => `${fmt(r['评论数'])}评<br>${fmt(r['涉及视频数'])}条视频<br>${fmt(r['评论日期数'])}个日期` },
      { label: '精确时间轨迹', render: (r) => `<strong>首评</strong> ${esc(r['首评精确时间'])}<br><strong>二评</strong> ${esc(r['二评精确时间'])}<br><strong>末评</strong> ${esc(r['末评精确时间'])}<br><span class="muted">跨度 ${dec(r['活跃跨度天'], 1)} 天 · 中位间隔 ${dec(r['中位评论间隔小时'], 1)} 小时</span>` },
      { label: '原始评论证据', render: (r) => `<strong>${esc(r['最早评论时间'])}</strong><br>${esc(r['最早评论原文']) || '<span class="muted">[空文本/图片评论]</span>'}<br><br><strong>最高赞 ${fmt(r['最高单评点赞'])}赞 · ${esc(r['最高赞评论时间'])}</strong><br>${esc(r['最高赞评论原文']) || '<span class="muted">[空文本/图片评论]</span>'}` },
    ])}
    <div class="finding-grid">
      ${topProfiles[0] ? finding(`${displayProfile(topProfiles[0])}：长期跨视频参与`, `从 ${esc(topProfiles[0]['首评精确时间'])} 的“${esc(topProfiles[0]['最早评论原文'])}”，到 ${esc(topProfiles[0]['末评精确时间'])} 的“${esc(topProfiles[0]['最新评论原文'])}”，样本内横跨 ${dec(topProfiles[0]['活跃跨度天'], 1)} 天、${fmt(topProfiles[0]['涉及视频数'])} 条视频；最高赞原话“${esc(topProfiles[0]['最高赞评论原文'])}”获得 ${fmt(topProfiles[0]['最高单评点赞'])} 赞。这是长期内容关系的具体例子，但仍不等于平台关注留存。`, 'Named longitudinal trace', 'green') : ''}
      ${topProfiles[1] ? finding(`${displayProfile(topProfiles[1])}：从角色称谓进入玩家共创`, `首条可见原话“${esc(topProfiles[1]['最早评论原文'])}”发生于 ${esc(topProfiles[1]['首评精确时间'])}；最高赞原话“${esc(topProfiles[1]['最高赞评论原文'])}”发生于 ${esc(topProfiles[1]['最高赞评论时间'])}。该用户命中“${esc(topProfiles[1]['命中语境信号'])}”，把角色昵称、老三国记忆与卡宝互动放在同一轨迹中。`, 'Named semantic trace', 'violet') : ''}
    </div>

    <h3>6. 时间结构：入场、短时会话、跨日回流与长期活跃必须分开看</h3>
    <div class="metric-grid">
      ${metricCard('相邻评论间隔', `${dec(intervals.medianHours, 1)}小时`, `n=${fmt(intervals.n)} 个相邻间隔；P25 ${dec(intervals.p25Hours, 1)}h，P75 ${dec(intervals.p75Hours, 1)}h`, 'blue')}
      ${metricCard('P90相邻间隔', `${dec(intervals.p90Hours, 1)}小时`, '约9天；揭示持续参与并不等于每天连续打卡', 'violet')}
      ${metricCard('同日复评用户', `${pct(sessions.sameDayRepeatRate)}`, `${fmt(sessions.sameDayRepeatUsers)}/${fmt(repeat.users)} 人至少在同一自然日评论两次`, 'green')}
      ${metricCard('6小时内3+连评', `${pct(sessions.threePlusBurstRate)}`, `${fmt(sessions.threePlusBurstUsers)}/${fmt(repeat.users)} 人出现过短时高强度会话`, 'amber')}
    </div>
    <div class="two-col">
      <div>
        <h4>所有相邻评论的等待时间</h4>
        ${table(Object.entries(intervals.buckets || {}).map(([label, count]) => ({ label, count, share: intervals.bucketShares?.[label] || 0 })), [
          { label: '相邻间隔', render: (r) => `<strong>${esc(r.label)}</strong>` },
          { label: '间隔数', className: 'num', render: (r) => fmt(r.count) },
          { label: '占全部相邻间隔', className: 'num', render: (r) => pct(r.share) },
          { label: '解释', render: (r) => esc({ '≤1小时': '楼内对话、刚发布后的连评或短时追看', '1–6小时': '同一运营会话内的延续', '6–24小时': '跨时段但未跨一天', '1–7天': '随新视频回流的主要区间', '7–30天': '跨周持续关系', '>30天': '长周期重新出现' }[r.label] || '') },
        ])}
        ${paragraph(`以相邻评论为单位，${pct((intervals.bucketShares?.['≤1小时'] || 0) + (intervals.bucketShares?.['1–6小时'] || 0))} 在6小时内，${pct(intervals.bucketShares?.['1–7天'] || 0)} 落在1–7天，另有 ${pct((intervals.bucketShares?.['7–30天'] || 0) + (intervals.bucketShares?.['>30天'] || 0))} 超过7天。短时爆发与跨周回流是两种不同关系：前者适合实时回复，后者需要连载、回调和账号级叙事记忆。`)}
      </div>
      <div>
        <h4>复评用户首次出现在样本中的月份</h4>
        ${table(monthRows, [
          { label: '首次可见月份', render: (r) => `<strong>${esc(r.label)}</strong>` },
          { label: '复评用户', className: 'num', render: (r) => `${fmt(r.count)} / ${pct(r.share)}` },
          { label: '经营解释', render: (r) => r.label === '2026-07' ? '样本中最大的复评用户进入批次；需结合当月供给与活动复盘。' : r.label === '2026-06' ? '第二大进入批次，随后承接至7–8月。' : '该月仅代表当前评论样本首次出现，不等于账号真实新增粉丝。' },
        ])}
        ${paragraph(`复评用户首次可见进入高度集中在6–7月：${fmt((monthRows.find(r => r.label === '2026-06')?.count || 0) + (monthRows.find(r => r.label === '2026-07')?.count || 0))} 人，占 ${pct((monthRows.find(r => r.label === '2026-06')?.share || 0) + (monthRows.find(r => r.label === '2026-07')?.share || 0))}。这能定位“何时形成可见复评资产”，但90/107条视频缺失发布时间，且评论采集窗口右删失，不能把月份差异直接归因于发布策略。`)}
      </div>
    </div>
    <h4>星期与小时：用于运营排班，不用于推断职业或自然作息</h4>
    <div class="two-col">
      <div>
        ${table(weekdayRows, [
          { label: '星期', render: (r) => `<strong>${esc(r.label)}</strong>` },
          { label: '评论事件', className: 'num', render: (r) => `${fmt(r.count)} / ${pct(r.share)}` },
        ])}
      </div>
      <div>
        ${table([
          { label: '18:00–23:59', comments: repeat.timing.evening18To23.comments, share: repeat.timing.evening18To23.share, use: '覆盖复评评论的主要晚间高密度窗口' },
          { label: '18:00–22:59', comments: repeat.timing.evening18To22.comments, share: repeat.timing.evening18To22.share, use: '集中回复、投票和二次问题承接' },
          { label: '12:00–13:59', comments: repeat.timing.noon12To13.comments, share: repeat.timing.noon12To13.share, use: '午间二次触达测试窗口' },
        ], [
          { label: '时段', render: (r) => `<strong>${esc(r.label)}</strong>` },
          { label: '评论事件', className: 'num', render: (r) => `${fmt(r.comments)} / ${pct(r.share)}` },
          { label: '用途', render: (r) => esc(r.use) },
        ])}
      </div>
    </div>
    ${paragraph(`周五在复评事件中占 ${pct(weekdayRows.find(r => r.label === '周五')?.share || 0)}，周一为 ${pct(weekdayRows.find(r => r.label === '周一')?.share || 0)}；18点单小时具名附录记录 ${fmt(temporal.eventHours?.find(r => r.label === '18')?.count || 0)} 条，占复评事件 ${pct(temporal.eventHours?.find(r => r.label === '18')?.share || 0)}。这些分布受视频发布时间、推荐流和活动任务强烈混杂，只适合安排运营值守和提出A/B时段实验，不是自然活跃度结论。`)}

    <h3>7. 可见地域标签：可用于检查样本覆盖，不可用于人口画像</h3>
    <div class="two-col">
      <div>
        <h4>地域只能做覆盖检查</h4>
        ${paragraph('地点字段来自平台评论IP聚合标签，不是GPS、户籍或稳定常住地。同一人以样本期出现最多的标签作为用户主标签；不由此推断年龄、收入、职业、消费力或地区市场规模。')}
      </div>
      <div>
        <h4>评论IP地点标签的主要聚合（用户主标签）</h4>
        ${table(repeat.locationsByUser.slice(0, 6), [
          { label: '地点标签', render: (r) => esc(r.label) },
          { label: '复评文本用户', className: 'num', render: (r) => `${fmt(r.count)} / ${pct(r.share)}` },
          { label: '解释纪律', render: () => '平台评论IP的聚合标签；不等于真实常住地、年龄、消费力或市场规模。' },
        ])}
        ${paragraph('地域标签分散，前列标签只能帮助观察样本覆盖，不支持地区投放预算或“某地用户更多”的结论。真要做人群背景，需要在自愿、合规的前提下收集问卷、兴趣、购买、关注与曝光数据，并与评论行为分开保存。')}
      </div>
    </div>

    <h3>8. 针对不同复评层的运营动作：把复评变成可验证的关系，而不是反复消耗核心</h3>
    <div class="three-col">
      ${finding('2–3次：促成“跨一条视频”', `共 ${fmt(tiers[1].users)} 人。用下一集、同角色对照、角色投票和一问一答承接，主指标为后续非活动视频跨视频评论者，而非本帖总评。`, 'Activation', 'blue')}
      ${finding('4–9次：邀请解释与轻共创', `共 ${fmt(tiers[2].users)} 人，${pct(tiers[2].crossVideoRate)} 已跨视频。给机制梗的白话解释、角色关系投票、评论采纳和选题回访，让他们从重复反应升级为内容贡献。`, 'Participation', 'green')}
      ${finding('10次以上：建立小型共创面板', `共 ${fmt(core.users)} 人却贡献 ${pct(core.commentShare)} 评论。可做内测题、设定核验、投稿选题和商品细节访谈；同时按用户去重并限制单一高频群左右账号方向。`, 'Stewardship', 'violet')}
    </div>
    <div class="verdict"><strong>内部证据入口：</strong><a href="多次评论用户具名时序附录.html">打开 2,059 位用户可搜索具名时间线</a>；<a href="多次评论用户具名画像与时序.csv">下载用户级具名画像 CSV</a>；<a href="多次评论用户逐条评论时序明细.csv">下载 11,364 条逐评论时序 CSV</a>。这些文件含昵称、主页、原始文本和精确时间，只限本项目内部分析。<br><br><strong>下一步验证：</strong>补充作者回复精确时间、视频精确发布时间、曝光、观看、关注、点击、预约与订单事件，再以随机化内容或回复实验验证哪些动作真正提高后续参与。现阶段所有结果仍是评论样本中的观察关联。</div>
  </section>`;
}
