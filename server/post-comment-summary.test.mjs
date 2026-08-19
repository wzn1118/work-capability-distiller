import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePostCommentSummary } from './post-comment-summary.mjs';

test('derives structured insight from the first ten hot comments', () => {
  const summary = derivePostCommentSummary({
    post: { title: '\u77ed\u53d1\u540c\u6b3e\u5206\u4eab' },
    comments: [
      { id: 'c1', text: '\u8fd9\u4e2a\u77ed\u53d1\u771f\u7684\u663e\u8138\u5c0f\uff0c\u60f3\u526a\uff01', likeCount: 100 },
      { id: 'c2', text: '\u6c42\u540c\u6b3e\u6559\u7a0b\uff0c\u8fd9\u4e2a\u53d1\u578b\u600e\u4e48\u6253\u7406\uff1f', likeCount: 80 },
      { id: 'c3', text: '\u8bf7\u95ee\u9002\u5408\u5706\u8138\u5417\uff1f', likeCount: 60 },
    ],
  });
  assert.equal(summary.status, 'ready');
  assert.equal(summary.sourceCommentCount, 3);
  assert.equal(summary.sentiment.id, 'positive');
  assert.equal(summary.topics[0].id, 'style');
  assert.equal(summary.questions.length, 2);
  assert.match(summary.recommendedAction, /\u56de\u5e94/);
});

test('returns an explicit empty summary when no public comments are available', () => {
  const summary = derivePostCommentSummary({ comments: [] });
  assert.equal(summary.status, 'empty');
  assert.equal(summary.sourceCommentCount, 0);
  assert.equal(summary.confidence, 0);
  assert.equal(summary.questions.length, 0);
});
