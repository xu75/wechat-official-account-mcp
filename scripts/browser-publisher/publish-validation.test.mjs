import test from 'node:test';
import assert from 'node:assert/strict';
import { isSubmissionConfirmed, stripImageTags, validateEditorContentSnapshot } from './publish-validation.mjs';

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

test('stripImageTags keeps text content for text-only fallback mode', () => {
  const raw = '<p>正文A</p><p><img src="https://example.com/a.png" /></p><p>正文B</p>';
  const stripped = stripImageTags(raw);
  assert.equal(stripped.includes('<img'), false);
  assert.equal(stripped.includes('正文A'), true);
  assert.equal(stripped.includes('正文B'), true);
});
