/**
 * Multi-format exporter (CSV with UTF-8 BOM, Markdown Report, Restorable JSON Archive)
 * and JSON backup importer.
 */

import { buildDiagnosticReport, exportArchiveBundle, importArchiveBundle } from '../shared/db.js';
import { buildCsv, buildMarkdownReport, normalizeHandle } from '../shared/utils.js';

function triggerFileDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

const USER_CSV_COLUMNS = [
  { key: 'username', header: 'Handle', transform: (u) => `@${u.username || ''}` },
  { key: 'name', header: 'Display Name' },
  { key: 'restId', header: 'X User ID' },
  { key: 'verified', header: 'Verified', transform: (u) => (u.verified || u.isBlueVerified ? 'Yes' : 'No') },
  { key: 'verifiedType', header: 'Verification Tier' },
  { key: 'followersCount', header: 'Followers' },
  { key: 'followingCount', header: 'Following' },
  { key: 'followsBack', header: 'Follows You', transform: (u) => (u.followsBack ? 'Yes' : 'No') },
  { key: 'whitelisted', header: 'Whitelisted', transform: (u) => (u.whitelisted ? 'Yes' : 'No') },
  { key: 'unfollowReason', header: 'Status / Reason' },
  {
    key: 'eventDate',
    header: 'Event Date (ISO)',
    transform: (u) => {
      const ts = u.unfollowedAt || u.followedAt || u.refollowedAt || u.lastSeenAt;
      return ts ? new Date(ts).toISOString() : '';
    }
  },
  { key: 'bio', header: 'Bio' },
  { key: 'profileUrl', header: 'Profile URL' }
];

/**
 * Export the currently displayed list as RFC 4180 CSV.
 */
export function exportViewCsv({ accountHandle, viewName, items }) {
  const safeUser = normalizeHandle(accountHandle) || 'account';
  const dateStamp = new Date().toISOString().slice(0, 10);
  const csv = buildCsv(items || [], USER_CSV_COLUMNS);
  triggerFileDownload(`x-tracker-${safeUser}-${viewName}-${dateStamp}.csv`, csv, 'text/csv;charset=utf-8');
}

/**
 * Export a formatted Markdown audit summary report.
 */
export function exportMarkdownAudit(dataset) {
  if (!dataset?.account) return;
  const safeUser = normalizeHandle(dataset.account.accountKey);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const latestSnap = dataset.snapshots?.[dataset.snapshots.length - 1] || null;
  const renamed = (dataset.events || [])
    .filter((e) => e.type === 'renamed')
    .map((e) => {
      const prof = dataset.profileMap?.get(e.targetId);
      return {
        username: prof?.username || e.meta?.newHandle || e.targetId,
        name: prof?.name || '',
        verified: Boolean(prof?.verified),
        previousHandle: e.meta?.previousHandle || ''
      };
    });

  const md = buildMarkdownReport({
    accountHandle: safeUser,
    summary: {
      followersCount: dataset.followers.length,
      followingCount: dataset.following.length,
      unfollowersCount: dataset.unfollowers.length,
      newFollowersCount: dataset.newFollowers.length,
      fansCount: dataset.fans.length,
      notFollowingBackCount: dataset.notFollowingBack.length,
      coverage: latestSnap?.coverage ?? null
    },
    unfollowers: dataset.unfollowers,
    newFollowers: dataset.newFollowers,
    notFollowingBack: dataset.notFollowingBack,
    renamed
  });

  triggerFileDownload(`x-tracker-${safeUser}-report-${dateStamp}.md`, md, 'text/markdown;charset=utf-8');
}

/**
 * Export a single account or full IndexedDB v3 JSON backup archive.
 */
export async function exportJsonArchive(accountKey = null) {
  const bundle = await exportArchiveBundle(accountKey);
  const label = accountKey ? normalizeHandle(accountKey) : 'all-accounts';
  const dateStamp = new Date().toISOString().slice(0, 10);
  triggerFileDownload(
    `x-tracker-backup-${label}-${dateStamp}.json`,
    JSON.stringify(bundle, null, 2),
    'application/json;charset=utf-8'
  );
}

/**
 * Read and restore a JSON archive file.
 */
export async function importJsonFile(file, { replace = false } = {}) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  return importArchiveBundle(parsed, { replace });
}


/**
 * Export sanitized diagnostic bundle (logs + settings + snapshots + runtime state).
 */
export async function exportDiagnosticsReport({ accountKey = null, runtime = null } = {}) {
  const report = await buildDiagnosticReport({ accountKey, runtime });
  const label = normalizeHandle(accountKey) || 'global';
  const dateStamp = new Date().toISOString().slice(0, 10);
  triggerFileDownload(
    `x-tracker-diagnostics-${label}-${dateStamp}.json`,
    JSON.stringify(report, null, 2),
    'application/json;charset=utf-8'
  );
  return report;
}
