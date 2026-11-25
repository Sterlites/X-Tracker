/**
 * Pure utility functions for handle normalization, localized count parsing,
 * safe URL validation, formatting, and multi-format export generation.
 */

import { USERNAME_REGEX } from './constants.js';

const UNIT_MULTIPLIERS = Object.freeze({
  k: 1_000,
  mil: 1_000,
  тыс: 1_000,
  m: 1_000_000,
  mio: 1_000_000,
  млн: 1_000_000,
  b: 1_000_000_000,
  mrd: 1_000_000_000,
  t: 1_000_000_000_000,
  万: 10_000,
  萬: 10_000,
  亿: 100_000_000,
  億: 100_000_000
});

/**
 * Normalize an X handle (strips leading @, trims whitespace, lowercases).
 * @param {string} value
 * @returns {string}
 */
export function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@+/, '').trim().toLowerCase();
}

/**
 * Check whether a string is a syntactically valid X handle.
 * @param {string} value
 * @returns {boolean}
 */
export function isValidHandle(value) {
  return USERNAME_REGEX.test(normalizeHandle(value));
}

/**
 * Compute canonical storage ID for a user object.
 * Prefers immutable numeric restId; falls back to handle:<normalized>.
 * @param {Object} user
 * @returns {string}
 */
export function makeCanonicalId(user) {
  if (user?.restId !== undefined && user?.restId !== null && String(user.restId).trim() !== '') {
    return String(user.restId).trim();
  }
  const handle = normalizeHandle(user?.username || user?.screen_name);
  return handle ? `handle:${handle}` : '';
}

/**
 * Parse abbreviated or localized follower/following counts into an integer.
 * Correctly handles both "12.4K" (dot decimal), "12,4K" (comma decimal),
 * "1,234" (comma thousands), "1.234" (dot thousands), and CJK/multilingual suffixes.
 * @param {string|number|null|undefined} raw
 * @returns {number|null}
 */
export function parseLocalizedCount(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.round(raw) : null;
  }
  if (!raw) {
    return null;
  }

  const text = String(raw).trim();
  if (!text) {
    return null;
  }

  const match = text.match(
    /(\d[\d\s.,\u00A0\u202F]*)\s*(mil|mio|тыс\.?|млн|mrd|K|M|B|T|万|萬|亿|億)?/i
  );
  if (!match) {
    return null;
  }

  let numToken = match[1].replace(/[\s\u00A0\u202F]/g, '');
  const rawSuffix = (match[2] || '').replace(/\.$/, '').toLowerCase();
  const multiplier = rawSuffix ? (UNIT_MULTIPLIERS[rawSuffix] || 1) : 1;

  const hasComma = numToken.includes(',');
  const hasDot = numToken.includes('.');

  if (hasComma && hasDot) {
    // Whichever appears last before <= 2 digits (or when scaled) is decimal
    const lastComma = numToken.lastIndexOf(',');
    const lastDot = numToken.lastIndexOf('.');
    if (lastComma > lastDot) {
      numToken = numToken.replaceAll('.', '').replace(',', '.');
    } else {
      numToken = numToken.replaceAll(',', '');
    }
  } else if (hasComma) {
    if (/^\d{1,3}(,\d{3})+$/.test(numToken) && multiplier === 1) {
      numToken = numToken.replaceAll(',', '');
    } else if (/^\d+,\d{1,2}$/.test(numToken) || multiplier > 1) {
      numToken = numToken.replaceAll(',', '.');
    } else {
      numToken = numToken.replaceAll(',', '');
    }
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(numToken) && multiplier === 1) {
      numToken = numToken.replaceAll('.', '');
    }
  }

  const parsed = Number.parseFloat(numToken);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round(parsed * multiplier);
}

/**
 * Sanitize an avatar image URL strictly to HTTPS without CSS/HTML breakout chars.
 * @param {string|null|undefined} rawUrl
 * @returns {string}
 */
export function sanitizeAvatarUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }
  const trimmed = rawUrl.trim();
  if (/[\s"'()<>\\]/.test(trimmed)) {
    return '';
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Sanitize an external URL for safe linking/navigation.
 * @param {string|null|undefined} rawUrl
 * @returns {string}
 */
export function sanitizeExternalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

/**
 * Escape a single CSV cell per RFC 4180 and neutralize spreadsheet formula prefixes.
 * @param {unknown} value
 * @returns {string}
 */
export function csvEscapeCell(value) {
  let str = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

/**
 * Build an RFC 4180 CSV document with UTF-8 BOM for reliable Excel encoding.
 * @param {Array<Object>} rows
 * @param {Array<{ key: string, header: string, transform?: (row: Object) => unknown }>} columns
 * @returns {string}
 */
export function buildCsv(rows, columns) {
  const headerLine = columns.map((col) => csvEscapeCell(col.header)).join(',');
  const bodyLines = (rows || []).map((row) =>
    columns
      .map((col) => {
        const val = typeof col.transform === 'function' ? col.transform(row) : row?.[col.key];
        return csvEscapeCell(val);
      })
      .join(',')
  );
  return `\uFEFF${[headerLine, ...bodyLines].join('\r\n')}\r\n`;
}

/**
 * Escape Markdown table cell pipes and newlines.
 * @param {unknown} value
 * @returns {string}
 */
function mdCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/**
 * Build a readable Markdown audit report for a tracked account.
 * @param {Object} params
 * @returns {string}
 */
export function buildMarkdownReport({
  accountHandle,
  generatedAt = Date.now(),
  summary = {},
  unfollowers = [],
  newFollowers = [],
  notFollowingBack = [],
  renamed = []
}) {
  const lines = [
    `# X Tracker Audit Report — @${normalizeHandle(accountHandle)}`,
    '',
    `Generated: ${new Date(generatedAt).toISOString()}`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '| :--- | ---: |',
    `| Followers | ${(summary.followersCount ?? 0).toLocaleString()} |`,
    `| Following | ${(summary.followingCount ?? 0).toLocaleString()} |`,
    `| Unfollowers (Active) | ${(summary.unfollowersCount ?? unfollowers.length).toLocaleString()} |`,
    `| New Followers | ${(summary.newFollowersCount ?? newFollowers.length).toLocaleString()} |`,
    `| Fans | ${(summary.fansCount ?? 0).toLocaleString()} |`,
    `| Not Following Back | ${(summary.notFollowingBackCount ?? notFollowingBack.length).toLocaleString()} |`,
    `| Scan Coverage | ${summary.coverage != null ? `${Math.round(summary.coverage * 100)}%` : 'N/A'} |`,
    ''
  ];

  const appendUserTable = (title, items, extraHeader, extraGetter) => {
    lines.push(`## ${title} (${items.length})`, '');
    if (!items.length) {
      lines.push('_None recorded._', '');
      return;
    }
    lines.push(
      `| Handle | Name | Verified | ${extraHeader} |`,
      '| :--- | :--- | :--- | :--- |'
    );
    items.slice(0, 500).forEach((item) => {
      lines.push(
        `| @${mdCell(item.username)} | ${mdCell(item.name || item.username)} | ${item.verified ? 'Yes' : 'No'} | ${mdCell(extraGetter(item))} |`
      );
    });
    if (items.length > 500) {
      lines.push('', `_Truncated to first 500 of ${items.length} entries._`);
    }
    lines.push('');
  };

  appendUserTable(
    'Unfollowers',
    unfollowers,
    'Reason / Timestamp',
    (u) => `${u.unfollowReason || 'unfollowed'} (${u.unfollowedAt ? new Date(u.unfollowedAt).toISOString().slice(0, 10) : 'unknown'})`
  );
  appendUserTable(
    'New Followers',
    newFollowers,
    'Timestamp',
    (u) => (u.followedAt ? new Date(u.followedAt).toISOString().slice(0, 10) : 'unknown')
  );
  appendUserTable(
    'Handle Renames Detected',
    renamed,
    'Previous Handle',
    (u) => (u.previousHandle ? `@${u.previousHandle}` : '-')
  );
  appendUserTable(
    'Not Following Back',
    notFollowingBack,
    'Whitelisted',
    (u) => (u.whitelisted ? 'Keep' : 'No')
  );

  return lines.join('\n');
}

/**
 * Format signed numeric delta (+12, -4, 0).
 * @param {number|null|undefined} value
 * @returns {string}
 */
export function formatSignedNumber(value) {
  if (!Number.isFinite(value)) {
    return 'N/A';
  }
  if (value > 0) {
    return `+${value.toLocaleString()}`;
  }
  return value.toLocaleString();
}

/**
 * Format compact relative time string.
 * @param {number|null|undefined} timestamp
 * @returns {string}
 */
export function formatRelativeTime(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 'Never';
  }
  const diff = Date.now() - timestamp;
  const abs = Math.abs(diff);
  if (abs < 60_000) {
    return 'Just now';
  }
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) {
    return diff >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return diff >= 0 ? `${hours}h ago` : `in ${hours}h`;
  }
  const date = new Date(timestamp);
  const now = new Date();
  const options = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) {
    options.year = 'numeric';
  }
  return date.toLocaleDateString([], options);
}

/**
 * Format localized date + time string.
 * @param {number|null|undefined} timestamp
 * @returns {string}
 */
export function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return 'Unknown';
  }
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/**
 * Format byte counts nicely.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Create a unique scan ID.
 * @param {string} scanType
 * @param {number} timestamp
 * @returns {string}
 */
export function makeScanId(scanType, timestamp = Date.now()) {
  const rand = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${scanType}-${timestamp}-${rand}`;
}
