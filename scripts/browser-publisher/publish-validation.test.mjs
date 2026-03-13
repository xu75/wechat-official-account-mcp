import test from 'node:test';
import assert from 'node:assert/strict';
import { isSubmissionConfirmed, normalizeLinkTarget, validateEditorContentSnapshot } from './publish-validation.mjs';

test('empty editor content must not pass validation', () => {
  const result = validateEditorContentSnapshot({
    inputHtml: '<p>hello world</p>',
    editorHtml: '',
    editorText: '',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'BROWSER_EDITOR_EMPTY');
  assert.equal(result.content_length, 0);
});

test('content injection success should pass validation and be publishable', () => {
  const result = validateEditorContentSnapshot({
    inputHtml: '<p>hello world</p>',
    editorHtml: '<p>hello world</p>',
    editorText: 'hello world',
  });

  assert.equal(result.ok, true);
  assert.equal(result.error_code, undefined);
  assert.ok(result.content_length > 0);

  const submitted = isSubmissionConfirmed({
    mode: 'draft',
    successHintMatched: true,
    beforeUrl: 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1',
    url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&appmsgid=10001',
  });
  assert.equal(submitted, true);
});

test('draft submit without success hint should fail on stale editor with existing appmsgid', () => {
  const submitted = isSubmissionConfirmed({
    mode: 'draft',
    successHintMatched: false,
    beforeUrl: 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&appmsgid=10001',
    url: 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&appmsgid=10001',
  });
  assert.equal(submitted, false);
});

test('image insertion failure must keep non-empty content and expose explicit error', () => {
  const result = validateEditorContentSnapshot({
    inputHtml: '<p>正文保留</p><p><img src="https://example.com/a.png" /></p>',
    editorHtml: '<p>正文保留</p>',
    editorText: '正文保留',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'BROWSER_IMAGE_INSERT_FAILED');
  assert.ok(result.content_length > 0);
  assert.equal(result.expected_image_count, 1);
  assert.equal(result.actual_image_count, 0);
});

test('image insertion success should pass with non-empty content', () => {
  const result = validateEditorContentSnapshot({
    inputHtml: '<p>正文A</p><p><img src="https://example.com/a.png" /></p><p>正文B</p>',
    editorHtml: '<p>正文A</p><p><img src="https://example.com/a.png" /></p><p>正文B</p>',
    editorText: '正文A 正文B',
  });

  assert.equal(result.ok, true);
  assert.equal(result.error_code, undefined);
  assert.equal(result.expected_image_count, 1);
  assert.equal(result.actual_image_count, 1);
  assert.ok(result.content_length > 0);
});

test('image url rewrite by editor should not be treated as insertion failure', () => {
  const result = validateEditorContentSnapshot({
    inputHtml: '<p>正文A</p><p><img src="https://example.com/a.png" /></p>',
    editorHtml: '<p>正文A</p><p><img src="https://mmbiz.qpic.cn/sz_mmbiz_png/abc/0?wx_fmt=png&from=appmsg" /></p>',
    editorText: '正文A',
  });

  assert.equal(result.ok, true);
  assert.equal(result.error_code, undefined);
  assert.equal(result.expected_image_count, 1);
  assert.equal(result.actual_image_count, 1);
  assert.equal(result.image_src_rewritten, true);
  assert.equal(result.missing_image_count_by_quantity, 0);
});

test('link insertion failure should return explicit link error code', () => {
  const result = validateEditorContentSnapshot({
    inputHtml: '<p>资料：<a href="https://example.com/paper">论文链接</a></p>',
    editorHtml: '<p>资料：论文链接</p>',
    editorText: '资料： 论文链接',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'BROWSER_LINK_INSERT_FAILED');
  assert.equal(result.expected_link_count, 1);
  assert.equal(result.actual_link_count, 0);
  assert.equal(result.missing_link_count_by_quantity, 1);
});

test('link insertion success should keep link counts aligned', () => {
  const result = validateEditorContentSnapshot({
    inputHtml: '<p>资料：<a href="https://example.com/paper">论文链接</a></p>',
    editorHtml: '<p>资料：<a href="https://example.com/paper">论文链接</a></p>',
    editorText: '资料： 论文链接',
  });

  assert.equal(result.ok, true);
  assert.equal(result.error_code, undefined);
  assert.equal(result.expected_link_count, 1);
  assert.equal(result.actual_link_count, 1);
  assert.equal(result.missing_link_count_by_quantity, 0);
});

test('link validation should accept data-href links from editor html', () => {
  const result = validateEditorContentSnapshot({
    inputHtml: '<p>资料：<a href="https://example.com/paper?a=1&b=2">论文链接</a></p>',
    editorHtml: '<p>资料：<a data-linktype="2" data-href="https://example.com/paper?a=1&amp;b=2">论文链接</a></p>',
    editorText: '资料：论文链接',
  });

  assert.equal(result.ok, true);
  assert.equal(result.error_code, undefined);
  assert.equal(result.expected_link_count, 1);
  assert.equal(result.actual_link_count, 1);
});

test('normalizeLinkTarget should decode html entities in urls', () => {
  const actual = normalizeLinkTarget('http://example.com/a?x=1&#x26;y=2');
  assert.equal(actual, 'http://example.com/a?x=1&y=2');
});

test('rich text reorder should not fail when multi-fragment content still matches', () => {
  const inputHtml = [
    '<h1>家长会后的一点思考</h1>',
    '<p>12岁之前，你塑造孩子的习惯；12岁之后，你成为孩子的镜子。</p>',
    '<p>老师说：12岁是价值观和人生导向的关键窗口期。</p>',
    '<p>回家后我一直在想，教育不是控制，而是示范。</p>',
  ].join('');
  const editorHtml = [
    '<p>老师说：12岁是价值观和人生导向的关键窗口期。</p>',
    '<p>回家后我一直在想，教育不是控制，而是示范。</p>',
    '<p>12岁之前，你塑造孩子的习惯；12岁之后，你成为孩子的镜子。</p>',
  ].join('');
  const result = validateEditorContentSnapshot({
    inputHtml,
    editorHtml,
    editorText: '老师说：12岁是价值观和人生导向的关键窗口期。回家后我一直在想，教育不是控制，而是示范。12岁之前，你塑造孩子的习惯；12岁之后，你成为孩子的镜子。',
  });

  assert.equal(result.ok, true);
  assert.equal(result.error_code, undefined);
  assert.ok(result.fragment_hit_count >= result.fragment_required_hits);
});

test('stale editor content should fail content injection check', () => {
  const result = validateEditorContentSnapshot({
    inputHtml: '<p>这是本次要发布的新文章内容，含关键短语：家庭教育的分水岭。</p>',
    editorHtml: '<p>旧草稿内容：昨天的备忘，不相关。</p>',
    editorText: '旧草稿内容：昨天的备忘，不相关。',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'BROWSER_CONTENT_INJECTION_FAILED');
});
