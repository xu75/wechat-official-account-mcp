#!/usr/bin/env node
import crypto from 'crypto';

function toStringSafe(input) {
  return typeof input === 'string' ? input : '';
}

function decodeHtmlEntities(input) {
  return toStringSafe(input)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function normalizeLinkTarget(input) {
  const raw = decodeHtmlEntities(input).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) return raw;
    const query = url.search ? `?${url.searchParams.toString()}` : '';
    const pathname = url.pathname || '/';
    const host = url.host.toLowerCase();
    return `${url.protocol}//${host}${pathname}${query}${url.hash}`;
  } catch {
    return raw;
  }
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

export function collectAnchorHrefs(inputHtml) {
  const html = toStringSafe(inputHtml);
  const linkTargets = [];
  const anchorRe = /<a\b[^>]*>/ig;
  let anchor = anchorRe.exec(html);
  while (anchor) {
    const tag = String(anchor[0] || '');
    const attrRe = /\b(?:href|data-href)\s*=\s*["']([^"']+)["']/ig;
    let attrMatch = attrRe.exec(tag);
    while (attrMatch) {
      const normalized = normalizeLinkTarget(attrMatch[1] || '');
      if (normalized) {
        linkTargets.push(normalized);
      }
      attrMatch = attrRe.exec(tag);
    }
    anchor = anchorRe.exec(html);
  }
  return Array.from(new Set(linkTargets));
}

function stableHashHex(input) {
  return crypto.createHash('sha256').update(toStringSafe(input), 'utf8').digest('hex');
}

function collectValidationFragments(inputText) {
  const text = normalizeComparableText(inputText);
  if (!text) return [];

  const len = text.length;
  const fragmentLen = Math.max(18, Math.min(48, Math.floor(len * 0.12) || 18));
  const starts = [
    0,
    Math.max(0, Math.floor((len - fragmentLen) / 2)),
    Math.max(0, len - fragmentLen),
  ];

  const fragments = [];
  for (const start of starts) {
    const fragment = text.slice(start, start + fragmentLen).trim();
    if (!fragment || fragment.length < 8) continue;
    if (!fragments.includes(fragment)) {
      fragments.push(fragment);
    }
  }
  return fragments;
}

export function validateEditorContentSnapshot(params) {
  const inputHtml = toStringSafe(params?.inputHtml);
  const editorHtml = toStringSafe(params?.editorHtml);
  const editorTextRaw = toStringSafe(params?.editorText);

  const normalizedInputText = normalizeComparableText(stripHtmlTags(inputHtml));
  const normalizedEditorText = normalizeComparableText(editorTextRaw || stripHtmlTags(editorHtml));
  const compactInputText = normalizedInputText.replace(/\s+/g, '');
  const compactEditorText = normalizedEditorText.replace(/\s+/g, '');
  const contentLength = normalizedEditorText.length;

  const expectedImages = collectImageSources(inputHtml);
  const actualImages = collectImageSources(editorHtml);
  const missingImages = expectedImages.filter((src) => !actualImages.includes(src));
  const imageSrcRewritten = expectedImages.length > 0 && missingImages.length > 0 && actualImages.length >= expectedImages.length;
  const missingImageCountByQuantity = Math.max(0, expectedImages.length - actualImages.length);

  const expectedLinks = collectAnchorHrefs(inputHtml);
  const actualLinks = collectAnchorHrefs(editorHtml);
  const missingLinkCountByQuantity = Math.max(0, expectedLinks.length - actualLinks.length);

  const fragments = collectValidationFragments(compactInputText);
  const fragmentHitCount = fragments.filter((fragment) => compactEditorText.includes(fragment)).length;
  const requiredFragmentHits = fragments.length > 0 ? 1 : 0;
  const fragmentMatched = requiredFragmentHits === 0 ? true : fragmentHitCount >= requiredFragmentHits;
  const imageInsertFailed = expectedImages.length > 0 && missingImageCountByQuantity > 0;
  const linkInsertFailed = expectedLinks.length > 0 && missingLinkCountByQuantity > 0;

  let errorCode = '';
  if (contentLength <= 0) {
    errorCode = 'BROWSER_EDITOR_EMPTY';
  } else if (!fragmentMatched) {
    errorCode = 'BROWSER_CONTENT_INJECTION_FAILED';
  } else if (imageInsertFailed) {
    errorCode = 'BROWSER_IMAGE_INSERT_FAILED';
  } else if (linkInsertFailed) {
    errorCode = 'BROWSER_LINK_INSERT_FAILED';
  }

  return {
    ok: errorCode.length === 0,
    error_code: errorCode || undefined,
    content_length: contentLength,
    editor_text_hash: stableHashHex(normalizedEditorText),
    input_text_hash: stableHashHex(normalizedInputText),
    fragment_sample: fragments[0] || '',
    fragment_hit_count: fragmentHitCount,
    fragment_required_hits: requiredFragmentHits,
    fragment_matched: fragmentMatched,
    expected_image_count: expectedImages.length,
    actual_image_count: actualImages.length,
    missing_images: missingImages,
    image_src_rewritten: imageSrcRewritten,
    missing_image_count_by_quantity: missingImageCountByQuantity,
    expected_link_count: expectedLinks.length,
    actual_link_count: actualLinks.length,
    missing_link_count_by_quantity: missingLinkCountByQuantity,
  };
}

export function isSubmissionConfirmed(params) {
  const mode = String(params?.mode || '').toLowerCase();
  const successHintMatched = Boolean(params?.successHintMatched);
  const url = toStringSafe(params?.url);
  const beforeUrl = toStringSafe(params?.beforeUrl);
  const hasAppMsgIdBefore = /[?&]appmsgid=\d+/.test(beforeUrl);
  const hasAppMsgIdAfter = /[?&]appmsgid=\d+/.test(url);

  if (successHintMatched) return true;
  if (mode === 'draft' && !hasAppMsgIdBefore && hasAppMsgIdAfter) return true;
  if (mode === 'publish' && /publish|sent|group/i.test(url)) return true;
  return false;
}
