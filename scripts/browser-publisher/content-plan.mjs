#!/usr/bin/env node
import { collectImageSources, normalizeLinkTarget } from './publish-validation.mjs';

function escapeHtmlAttribute(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractNormalizedHrefFromAttrs(rawAttrs) {
  const attrs = String(rawAttrs || '');
  const attrRe = /\b(?:href|data-href)\s*=\s*["']([^"']+)["']/ig;
  let href = '';
  let m = attrRe.exec(attrs);
  while (m) {
    const candidate = normalizeLinkTarget(m[1] || '');
    if (candidate) {
      href = candidate;
      break;
    }
    m = attrRe.exec(attrs);
  }
  return href;
}

export function normalizeAnchorsForWechat(inputHtml) {
  const html = String(inputHtml || '');
  return html.replace(/<a\b([^>]*)>/ig, (full, rawAttrs) => {
    const attrs = String(rawAttrs || '');
    const href = extractNormalizedHrefFromAttrs(attrs);

    if (!href) {
      return full;
    }

    const cleanedAttrs = attrs
      .replace(/\s*\b(?:href|data-href|data-linktype|target|rel)\s*=\s*["'][^"']*["']/ig, '')
      .trim();
    const safeHref = escapeHtmlAttribute(href);
    const preserved = cleanedAttrs ? ` ${cleanedAttrs}` : '';
    return `<a${preserved} href="${safeHref}" data-href="${safeHref}" data-linktype="2" target="_blank" rel="noopener noreferrer">`;
  });
}

export function appendLinkUrlsAsVisibleText(inputHtml) {
  const html = String(inputHtml || '');
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/ig, (full, rawAttrs, inner) => {
    const href = extractNormalizedHrefFromAttrs(rawAttrs);
    if (!href) {
      return full;
    }

    const innerText = String(inner || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (innerText.includes(href)) {
      return full;
    }

    const safeHref = escapeHtmlAttribute(href);
    return `${full}<span data-link-fallback-url="${safeHref}">（${safeHref}）</span>`;
  });
}

export function prepareContentForPublish(inputHtml) {
  const html = normalizeAnchorsForWechat(String(inputHtml || ''));
  const inputImages = collectImageSources(html);
  return {
    html,
    image_mode: 'keep',
    input_image_count: inputImages.length,
    image_skipped_count: 0,
  };
}

export function createInitialCoverPlan(inputImageCount) {
  const hasImages = Number(inputImageCount || 0) > 0;
  return {
    content_image_found: hasImages,
    attempted: false,
    applied: false,
    reason: hasImages ? 'not_attempted' : 'no_content_image',
  };
}
