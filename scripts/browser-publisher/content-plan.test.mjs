import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendLinkUrlsAsVisibleText,
  createInitialCoverPlan,
  normalizeAnchorsForWechat,
  prepareContentForPublish,
} from './content-plan.mjs';

test('content plan without image should keep html and skip cover attempt', () => {
  const plan = prepareContentForPublish('<p>纯文本正文</p>');
  const cover = createInitialCoverPlan(plan.input_image_count);

  assert.equal(plan.image_mode, 'keep');
  assert.equal(plan.input_image_count, 0);
  assert.equal(plan.image_skipped_count, 0);
  assert.equal(plan.html.includes('纯文本正文'), true);

  assert.equal(cover.content_image_found, false);
  assert.equal(cover.attempted, false);
  assert.equal(cover.applied, false);
  assert.equal(cover.reason, 'no_content_image');
});

test('content plan with image should keep html and mark cover candidate', () => {
  const plan = prepareContentForPublish('<p>正文</p><p><img src="https://example.com/a.png" /></p>');
  const cover = createInitialCoverPlan(plan.input_image_count);

  assert.equal(plan.image_mode, 'keep');
  assert.equal(plan.input_image_count, 1);
  assert.equal(plan.image_skipped_count, 0);
  assert.equal(plan.html.includes('<img'), true);

  assert.equal(cover.content_image_found, true);
  assert.equal(cover.attempted, false);
  assert.equal(cover.applied, false);
  assert.equal(cover.reason, 'not_attempted');
});

test('duplicate image src should be deduplicated in input image count', () => {
  const plan = prepareContentForPublish(
    '<p><img src="https://example.com/a.png" /></p><p><img src="https://example.com/a.png" /></p>',
  );
  assert.equal(plan.input_image_count, 1);
  assert.equal(plan.image_skipped_count, 0);
  assert.equal(plan.image_mode, 'keep');
});

test('normalize anchors for wechat should add data-href/data-linktype', () => {
  const html = '<p>参考：<a class="ref-link" href="https://example.com/a?x=1&amp;y=2">链接</a></p>';
  const normalized = normalizeAnchorsForWechat(html);
  assert.match(normalized, /data-linktype="2"/);
  assert.match(normalized, /data-href="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
  assert.match(normalized, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
});

test('append visible url fallback after anchor text', () => {
  const html = '<p>资料：<a href="https://example.com/paper">论文</a></p>';
  const withFallback = appendLinkUrlsAsVisibleText(html);
  assert.match(withFallback, /data-link-fallback-url="https:\/\/example\.com\/paper"/);
  assert.match(withFallback, /（https:\/\/example\.com\/paper）/);
});
