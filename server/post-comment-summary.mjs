const TOPIC_GROUPS = [
  { id: 'style', label: '\u53d1\u578b\u4e0e\u6548\u679c', terms: ['\u77ed\u53d1', '\u957f\u53d1', '\u5218\u6d77', '\u53d1\u578b', '\u526a\u53d1', '\u7406\u53d1', '\u5c42\u6b21', '\u5377\u53d1', '\u67d3\u53d1', '\u957f\u5ea6', '\u8138\u578b'] },
  { id: 'tutorial', label: '\u6559\u7a0b\u4e0e\u540c\u6b3e', terms: ['\u6559\u7a0b', '\u600e\u4e48', '\u5982\u4f55', '\u6b65\u9aa4', '\u6c42\u94fe\u63a5', '\u540c\u6b3e', '\u7528\u7684', '\u4ea7\u54c1', '\u5de5\u5177', '\u94fe\u63a5'] },
  { id: 'fit', label: '\u9002\u914d\u4e0e\u98ce\u683c', terms: ['\u597d\u770b', '\u663e\u8138\u5c0f', '\u51cf\u9f84', '\u663e\u7626', '\u9002\u5408', '\u6548\u679c', '\u7ffb\u8f66', '\u98ce\u683c', '\u6c14\u8d28'] },
  { id: 'purchase', label: '\u4ef7\u683c\u4e0e\u8d2d\u4e70', terms: ['\u4ef7\u683c', '\u591a\u5c11\u94b1', '\u8d35', '\u5e73\u4ef7', '\u8d2d\u4e70', '\u8d2d\u5165', '\u54ea\u91cc\u4e70'] },
];

const POSITIVE_TERMS = ['\u597d\u770b', '\u559c\u6b22', '\u7edd\u4e86', '\u597d\u7f8e', '\u663e\u8138\u5c0f', '\u51cf\u9f84', '\u9002\u5408', '\u540c\u6b3e', '\u7231\u4e86', '\u9ad8\u7ea7', '\u597d\u7528', '\u63a8\u8350', '\u6f02\u4eae', '\u60f3\u526a', '\u79cd\u8349'];
const NEGATIVE_TERMS = ['\u4e0d\u597d', '\u4e0d\u9002\u5408', '\u7ffb\u8f66', '\u5931\u671b', '\u8e29\u96f7', '\u592a\u8d35', '\u663e\u8001', '\u96be\u770b', '\u522b\u526a', '\u540e\u6094', '\u4e0d\u63a8\u8350'];
const QUESTION_PATTERN = /[?？]|\u600e\u4e48|\u5982\u4f55|\u54ea\u91cc|\u54ea\u4e2a|\u4ec0\u4e48|\u6c42|\u80fd\u5426|\u53ef\u4ee5/;

function text(value, maximum = 0) {
  if (value === undefined || value === null || typeof value === 'object') return '';
  const result = String(value).replace(/\s+/g, ' ').trim();
  return maximum ? result.slice(0, maximum) : result;
}

function boundedComments(comments) {
  return (Array.isArray(comments) ? comments : [])
    .map((comment, index) => ({
      id: text(comment?.id, 160) || `comment-${index + 1}`,
      text: text(comment?.text, 1_200),
      authorName: text(comment?.authorName, 120),
      likeCount: Number.isFinite(Number(comment?.likeCount)) ? Number(comment.likeCount) : null,
      rank: Number.isFinite(Number(comment?.rank)) ? Number(comment.rank) : index + 1,
    }))
    .filter((comment) => comment.text)
    .slice(0, 10);
}

function matchingTerms(value, terms) {
  return terms.filter((term) => value.includes(term));
}

function sentimentFor(comments) {
  let positive = 0;
  let negative = 0;
  comments.forEach((comment) => {
    positive += matchingTerms(comment.text, POSITIVE_TERMS).length;
    negative += matchingTerms(comment.text, NEGATIVE_TERMS).length;
  });
  const total = positive + negative;
  const id = total === 0 ? 'neutral' : positive > negative * 1.4 ? 'positive' : negative > positive * 1.4 ? 'negative' : 'mixed';
  const labels = {
    positive: '\u6b63\u5411\u5174\u8da3',
    negative: '\u5b58\u5728\u987e\u8651',
    mixed: '\u8bc4\u4ef7\u5206\u5316',
    neutral: '\u4fe1\u606f\u4e0d\u8db3',
  };
  return { id, label: labels[id], positive, negative };
}

function topicSignals(comments) {
  return TOPIC_GROUPS.map((group) => {
    const evidence = comments.filter((comment) => matchingTerms(comment.text, group.terms).length > 0);
    return {
      id: group.id,
      label: group.label,
      count: evidence.length,
      evidenceCommentIds: evidence.slice(0, 4).map((comment) => comment.id),
    };
  }).filter((topic) => topic.count > 0).sort((left, right) => right.count - left.count).slice(0, 3);
}

function commentExcerpt(comment) {
  return text(comment?.text, 90);
}

function deriveStatement({ post, comments, topics, sentiment, questionComments }) {
  const title = text(post?.title, 60);
  const topicText = topics.length ? topics.map((topic) => topic.label).join('\u3001') : '\u8bdd\u9898\u5185\u5bb9';
  const sentimentText = sentiment.id === 'positive'
    ? '\u6574\u4f53\u5174\u8da3\u504f\u6b63\u5411'
    : sentiment.id === 'negative'
      ? '\u8bc4\u8bba\u4e2d\u5b58\u5728\u660e\u663e\u987e\u8651'
      : sentiment.id === 'mixed' ? '\u8bc4\u8bba\u540c\u65f6\u5305\u542b\u559c\u597d\u4e0e\u987e\u8651' : '\u8bc4\u8bba\u4fe1\u606f\u8fd8\u4e0d\u8db3\u4ee5\u5224\u65ad\u6001\u5ea6';
  const questionText = questionComments.length ? `\u5176\u4e2d ${questionComments.length} \u6761\u5728\u8ffd\u95ee\u6559\u7a0b\u3001\u540c\u6b3e\u6216\u8d2d\u4e70\u4fe1\u606f` : '\u6682\u672a\u53d1\u73b0\u96c6\u4e2d\u95ee\u9898';
  return `${title ? `\u300a${title}\u300b` : '\u8be5\u5e16'}\u7684 ${comments.length} \u6761\u70ed\u8bc4\u4e3b\u8981\u56f4\u7ed5${topicText}\u5c55\u5f00\uff0c${sentimentText}\uff0c${questionText}\u3002`;
}

export function derivePostCommentSummary({ post = null, comments = [], generatedAt = new Date().toISOString() } = {}) {
  const bounded = boundedComments(comments);
  const topics = topicSignals(bounded);
  const sentiment = sentimentFor(bounded);
  const questionComments = bounded.filter((comment) => QUESTION_PATTERN.test(comment.text)).slice(0, 3);
  const topComment = bounded[0] || null;
  const statement = bounded.length
    ? deriveStatement({ post, comments: bounded, topics, sentiment, questionComments })
    : '\u5f53\u524d\u6ca1\u6709\u53ef\u5206\u6790\u7684\u516c\u5f00\u70ed\u8bc4\u3002';
  const primaryTopic = topics[0]?.label || '\u5e16\u5b50\u4e3b\u9898';
  const recommendedAction = questionComments.length
    ? `\u4f18\u5148\u56f4\u7ed5\u201c${primaryTopic}\u201d\u56de\u5e94\u95ee\u9898\uff0c\u5e76\u5728\u7ad9\u5185\u4fe1\u4e2d\u5f15\u7528\u8bc4\u8bba\u5173\u5fc3\u70b9\u3002`
    : bounded.length
      ? `\u53ef\u4ee5\u7528\u201c${primaryTopic}\u201d\u4f5c\u4e3a\u5efa\u8054\u5207\u5165\uff0c\u5148\u8be2\u95ee\u535a\u4e3b\u7684\u5185\u5bb9\u7ecf\u9a8c\u3002`
      : '\u83b7\u53d6\u70ed\u8bc4\u540e\u518d\u751f\u6210\u9488\u5bf9\u6027\u5efa\u8bae\u3002';
  return {
    version: 1,
    status: bounded.length ? 'ready' : 'empty',
    method: 'deterministic_comment_insights',
    generatedAt,
    sourceCommentCount: bounded.length,
    confidence: bounded.length >= 5 ? 0.82 : bounded.length >= 3 ? 0.68 : bounded.length ? 0.52 : 0,
    statement,
    sentiment,
    topics,
    questions: questionComments.map((comment) => ({ id: comment.id, authorName: comment.authorName, text: commentExcerpt(comment) })),
    topSignal: topComment ? { commentId: topComment.id, text: commentExcerpt(topComment), likeCount: topComment.likeCount } : null,
    recommendedAction,
  };
}
