#!/usr/bin/env node
import crypto from 'crypto';

function toStringSafe(input) {
  return typeof input === 'string' ? input : '';
}

export function stripHtmlTags(input) {
  return toStringSafe(input).replace(/<[^>]+>/g, ' ');
}

export function normalizeComparableText(input) {
  return toStringSafe(input).replace(/\s+/g, ' ').trim();
}

export function collectImageSources(inputHtml) {
  const html = toStringSafe(inputHtml);
  const sources = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/ig;
  let match = re.exec(html);
  while (match) {
    const src = String(match[1] || '').trim();
    if (src) {
      sources.push(src);
    }
    match = re.exec(html);
  }
  return Array.from(new Set(sources));
}

export function stripImageTags(inputHtml, replacement = '') {
  return toStringSafe(inputHtml).replace(/<img\b[^>]*>/ig, replacement);
}

function stableHashHex(input) {
  return crypto.createHash('sha256').update(toStringSafe(input), 'utf8').digest('hex');
}

export function validateEditorContentSnapshot(params) {
  const inputHtml = toStringSafe(params?.inputHtml);
  const editorHtml = toStringSafe(params?.editorHtml);
  const editorTextRaw = toStringSafe(params?.editorText);

  const normalizedInputText = normalizeComparableText(stripHtmlTags(inputHtml));
  const normalizedEditorText = normalizeComparableText(editorTextRaw || stripHtmlTags(editorHtml));
  const contentLength = normalizedEditorText.length;

  const expectedImages = collectImageSources(inputHtml);
  const actualImages = collectImageSources(editorHtml);
  const missingImages = expectedImages.filter((src) => !actualImages.includes(src));

  const fragmentSample = normalizedInputText.slice(0, Math.min(48, normalizedInputText.length));
  const fragmentMatched = fragmentSample ? normalizedEditorText.includes(fragmentSample) : true;
  const imageInsertFailed = expectedImages.length > 0 && missingImages.length > 0;

  let errorCode = '';
  if (contentLength <= 0) {
    errorCode = 'BROWSER_EDITOR_EMPTY';
  } else if (!fragmentMatched) {
    errorCode = 'BROWSER_CONTENT_INJECTION_FAILED';
  } else if (imageInsertFailed) {
    errorCode = 'BROWSER_IMAGE_INSERT_FAILED';
  }

  return {
    ok: errorCode.length === 0,
    error_code: errorCode || undefined,
    content_length: contentLength,
    editor_text_hash: stableHashHex(normalizedEditorText),
    input_text_hash: stableHashHex(normalizedInputText),
    fragment_sample: fragmentSample,
    fragment_matched: fragmentMatched,
    expected_image_count: expectedImages.length,
    actual_image_count: actualImages.length,
    missing_images: missingImages,
  };
}

export function isSubmissionConfirmed(params) {
  const mode = String(params?.mode || '').toLowerCase();
  const successHintMatched = Boolean(params?.successHintMatched);
  const url = toStringSafe(params?.url);
  const hasAppMsgId = /[?&]appmsgid=\d+/.test(url);

  if (successHintMatched) return true;
  if (mode === 'draft' && hasAppMsgId) return true;
  if (mode === 'publish' && /publish|sent|group/i.test(url)) return true;
  return false;
}
