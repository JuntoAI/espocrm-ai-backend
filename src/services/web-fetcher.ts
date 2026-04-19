/**
 * Web Fetcher — extracts text content from public URLs.
 *
 * Used by the AI assistant to analyze investor websites, company pages,
 * portfolio listings, and other publicly accessible web content.
 *
 * @module web-fetcher
 */

import axios from 'axios';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_LENGTH = 500_000; // 500KB max response
const MAX_TEXT_LENGTH = 30_000; // 30K chars max extracted text

/** Domains we refuse to fetch (privacy, security). */
const BLOCKED_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '10.',
  '172.16.',
  '192.168.',
  'internal',
];

// ────────────────────────────────────────────────────────────────
// HTML to text extraction
// ────────────────────────────────────────────────────────────────

/**
 * Strip HTML tags and extract readable text content.
 * Removes scripts, styles, nav, footer, and other non-content elements.
 */
function htmlToText(html: string): string {
  let text = html;

  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Remove nav, header, footer elements (usually boilerplate)
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');

  // Convert common block elements to newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi, '\n');

  // Convert list items to bullet points
  text = text.replace(/<li[^>]*>/gi, '\n• ');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&#\d+;/g, '');
  text = text.replace(/&\w+;/g, '');

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  text = text.trim();

  // Truncate if too long
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.substring(0, MAX_TEXT_LENGTH) + '\n\n[Content truncated — page too long]';
  }

  return text;
}

/**
 * Extract the page title from HTML.
 */
function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match?.[1]) {
    return match[1].replace(/\s+/g, ' ').trim();
  }
  return '';
}

/**
 * Extract meta description from HTML.
 */
function extractDescription(html: string): string {
  const match = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  return '';
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

export interface FetchResult {
  success: boolean;
  url: string;
  title: string;
  description: string;
  content: string;
  contentLength: number;
  error?: string;
}

/**
 * Fetch a URL and extract its text content.
 */
export async function fetchUrl(url: string): Promise<FetchResult> {
  // Validate URL
  if (!url || typeof url !== 'string') {
    return {
      success: false,
      url: url || '',
      title: '',
      description: '',
      content: '',
      contentLength: 0,
      error: 'URL is required.',
    };
  }

  const trimmedUrl = url.trim();

  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
    return {
      success: false,
      url: trimmedUrl,
      title: '',
      description: '',
      content: '',
      contentLength: 0,
      error: 'URL must start with http:// or https://',
    };
  }

  // Block internal/private URLs
  try {
    const parsed = new URL(trimmedUrl);
    const hostname = parsed.hostname.toLowerCase();
    for (const blocked of BLOCKED_DOMAINS) {
      if (hostname.startsWith(blocked) || hostname === blocked) {
        return {
          success: false,
          url: trimmedUrl,
          title: '',
          description: '',
          content: '',
          contentLength: 0,
          error: 'Cannot fetch internal or private URLs.',
        };
      }
    }
  } catch {
    return {
      success: false,
      url: trimmedUrl,
      title: '',
      description: '',
      content: '',
      contentLength: 0,
      error: 'Invalid URL format.',
    };
  }

  try {
    logger.info('WebFetcher: fetching URL', { url: trimmedUrl });

    const response = await axios.get(trimmedUrl, {
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_CONTENT_LENGTH,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JuntoAI-Assistant/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      responseType: 'text',
      // Follow redirects
      maxRedirects: 5,
    });

    const html = typeof response.data === 'string' ? response.data : String(response.data);
    const title = extractTitle(html);
    const description = extractDescription(html);
    const content = htmlToText(html);

    logger.info('WebFetcher: fetch complete', {
      url: trimmedUrl,
      title,
      contentLength: content.length,
    });

    return {
      success: true,
      url: trimmedUrl,
      title,
      description,
      content,
      contentLength: content.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.warn('WebFetcher: fetch failed', { url: trimmedUrl, error: message });

    // User-friendly error messages
    let userError = 'Failed to fetch the webpage.';
    if (message.includes('timeout')) {
      userError = 'The website took too long to respond.';
    } else if (message.includes('404')) {
      userError = 'Page not found (404).';
    } else if (message.includes('403') || message.includes('forbidden')) {
      userError = 'Access denied — the website blocked the request.';
    } else if (message.includes('ENOTFOUND')) {
      userError = 'Website not found — check the URL.';
    }

    return {
      success: false,
      url: trimmedUrl,
      title: '',
      description: '',
      content: '',
      contentLength: 0,
      error: userError,
    };
  }
}
