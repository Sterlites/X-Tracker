import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  buildCsv,
  buildMarkdownReport,
  makeCanonicalId,
  normalizeHandle,
  parseLocalizedCount,
  sanitizeAvatarUrl
} from '../shared/utils.js';
import {
  computeScanDiff,
  evaluatePreSaveFilter,
  evaluateScanQuality
} from '../shared/diff.js';
import {
  createEmptyAccountRecord,
  getSettings,
  saveSettings
} from '../shared/db.js';

const require = createRequire(import.meta.url);
const graphqlParser = require('../content/graphql-parser.js');

test('normalizeHandle and makeCanonicalId prefer immutable restId', () => {
  assert.equal(normalizeHandle(' @Alice_99 '), 'alice_99');
  assert.equal(makeCanonicalId({ restId: '42', username: 'alice' }), '42');
  assert.equal(makeCanonicalId({ username: '@Alice' }), 'handle:alice');
});

test('parseLocalizedCount handles dot/comma decimals, thousands, and CJK/European suffixes', () => {
  assert.equal(parseLocalizedCount('1,234'), 1234);
  assert.equal(parseLocalizedCount('1.234'), 1234);
  assert.equal(parseLocalizedCount('12.4K'), 12400);
  assert.equal(parseLocalizedCount('12,4K'), 12400);
  assert.equal(parseLocalizedCount('1.5M'), 1500000);
  assert.equal(parseLocalizedCount('2.5万'), 25000);
  assert.equal(parseLocalizedCount('12 mil'), 12000);
  assert.equal(parseLocalizedCount(''), null);
});

test('sanitizeAvatarUrl blocks non-https and CSS/HTML injection payloads', () => {
  assert.equal(
    sanitizeAvatarUrl('https://pbs.twimg.com/profile_images/1/pic.jpg'),
    'https://pbs.twimg.com/profile_images/1/pic.jpg'
  );
  assert.equal(sanitizeAvatarUrl('http://insecure.example.com/a.png'), '');
  assert.equal(sanitizeAvatarUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeAvatarUrl('https://x.com/a.jpg);background:red'), '');
  assert.equal(sanitizeAvatarUrl('https://x.com/a.jpg" onclick="x()'), '');
});

test('buildCsv applies RFC 4180 escaping, UTF-8 BOM, and formula prefix hardening', () => {
  const csv = buildCsv(
    [{ handle: 'alice', bio: 'Hello, "world"', formula: '=CMD|calc' }],
    [
      { key: 'handle', header: 'Handle' },
      { key: 'bio', header: 'Bio' },
      { key: 'formula', header: 'Formula' }
    ]
  );
  assert.ok(csv.startsWith('\uFEFFHandle,Bio,Formula'));
  assert.ok(csv.includes('"Hello, ""world"""'));
  assert.ok(csv.includes("'=CMD|calc"));
});

test('buildMarkdownReport renders summary and unfollower table', () => {
  const md = buildMarkdownReport({
    accountHandle: 'alice',
    summary: { followersCount: 10, followingCount: 5, coverage: 1 },
    unfollowers: [{ username: 'bob', name: 'Bob', verified: true, unfollowReason: 'suspended', unfollowedAt: 1700000000000 }]
  });
  assert.match(md, /# X Tracker Audit Report — @alice/);
  assert.match(md, /\| @bob \| Bob \| Yes \| suspended/);
});

test('evaluateScanQuality allows small fast scans and ghost-adjusted coverage', () => {
  const small = evaluateScanQuality({ currentCount: 4, expectedCount: 4 });
  assert.equal(small.isValid, true);
  assert.equal(small.qualityStatus, 'verified_complete');

  const ghost = evaluateScanQuality({ currentCount: 91, expectedCount: 100 });
  assert.equal(ghost.isValid, true);
  assert.equal(ghost.qualityStatus, 'ghost_adjusted');
});

test('computeScanDiff detects unfollows, refollows, handle renames, and upgrades handle->restId', () => {
  const t1 = 1700000000000;
  const baseAccount = {
    accountKey: 'owner',
    username: 'owner',
    followerIds: [],
    followingIds: [],
    verifiedFollowerIds: [],
    mutualFollowerIds: [],
    whitelistIds: [],
    scanCount: 0
  };

  // Scan 1: alice (DOM-only handle) and bob (restId 200)
  const scan1 = computeScanDiff({
    account: baseAccount,
    existingProfiles: {},
    incomingUsers: [
      { username: 'alice', name: 'Alice' },
      { restId: '200', username: 'bob_old', name: 'Bob' },
      { restId: '300', username: 'carol', name: 'Carol' }
    ],
    scanType: 'followers',
    expectedCount: 3,
    now: t1,
    scanId: 's1'
  });

  assert.equal(scan1.account.followerIds.length, 3);
  assert.equal(scan1.snapshot.delta.lost.length, 0);

  // Scan 2: alice upgraded to restId 100, bob renamed to bob_new, carol unfollowed, dave followed
  const t2 = t1 + 3600_000;
  const scan2 = computeScanDiff({
    account: scan1.account,
    existingProfiles: scan1.profiles,
    incomingUsers: [
      { restId: '100', username: 'alice', name: 'Alice', isBlueVerified: true },
      { restId: '200', username: 'bob_new', name: 'Bob' },
      { restId: '400', username: 'dave', name: 'Dave' }
    ],
    scanType: 'followers',
    expectedCount: 3,
    now: t2,
    scanId: 's2',
    priorActiveUnfollowerMap: new Map(Object.entries(scan1.account.activeUnfollowers || {})),
    priorActiveNewFollowerMap: new Map(Object.entries(scan1.account.activeNewFollowers || {})),
    priorRefollowerMap: new Map(Object.entries(scan1.account.refollowers || {}))
  });

  // Handle upgrade must NOT trigger unfollow or new follower
  assert.ok(!scan2.account.activeUnfollowers['handle:alice']);
  assert.ok(scan2.profiles['100']);
  assert.equal(scan2.profiles['handle:alice'], undefined);

  // Handle rename on restId 200 must be caught as rename, NOT unfollow
  assert.equal(scan2.renamedRecords.length, 1);
  assert.equal(scan2.renamedRecords[0].previousHandle, 'bob_old');
  assert.equal(scan2.renamedRecords[0].username, 'bob_new');
  assert.deepEqual(scan2.profiles['200'].previousHandles, ['bob_old']);

  // Carol unfollowed, Dave followed
  assert.ok(scan2.account.activeUnfollowers['300']);
  assert.ok(scan2.account.activeNewFollowers['400']);
  assert.equal(scan2.snapshot.delta.lost.length, 1);
  assert.equal(scan2.snapshot.delta.gained.length, 1);

  // Scan 3: Carol refollows -> moved out of activeUnfollowers and flagged refollowed
  const t3 = t2 + 3600_000;
  const scan3 = computeScanDiff({
    account: scan2.account,
    existingProfiles: scan2.profiles,
    incomingUsers: [
      { restId: '100', username: 'alice', name: 'Alice' },
      { restId: '200', username: 'bob_new', name: 'Bob' },
      { restId: '300', username: 'carol', name: 'Carol' },
      { restId: '400', username: 'dave', name: 'Dave' }
    ],
    scanType: 'followers',
    expectedCount: 4,
    now: t3,
    scanId: 's3',
    priorLossIds: new Set(['300']),
    priorActiveUnfollowerMap: new Map(Object.entries(scan2.account.activeUnfollowers || {})),
    priorActiveNewFollowerMap: new Map(Object.entries(scan2.account.activeNewFollowers || {})),
    priorRefollowerMap: new Map(Object.entries(scan2.account.refollowers || {}))
  });

  assert.equal(scan3.account.activeUnfollowers['300'], undefined);
  assert.equal(scan3.account.activeNewFollowers['300'].refollowed, true);
  assert.ok(scan3.account.refollowers['300']);
});

test('computeScanDiff preserves baseline when additive partial scan stops early', () => {
  const base = {
    accountKey: 'owner',
    username: 'owner',
    followerIds: ['1', '2', '3', '4', '5'],
    followingIds: [],
    verifiedFollowerIds: [],
    mutualFollowerIds: [],
    whitelistIds: [],
    lastFollowersCheck: 1000
  };
  const out = computeScanDiff({
    account: base,
    existingProfiles: {},
    incomingUsers: [{ restId: '1', username: 'u1' }, { restId: '6', username: 'u6' }],
    scanType: 'followers',
    expectedCount: 5,
    partial: true,
    now: 2000,
    scanId: 'partial-1'
  });

  assert.equal(out.account.followerIds.length, 6);
  assert.equal(Object.keys(out.account.activeUnfollowers).length, 0);
});

test('evaluatePreSaveFilter respects whitelist override and exclusion rules', () => {
  const rules = {
    verifiedMode: 'verified_only',
    excludeDefaultAvatar: true,
    minFollowers: 100,
    excludeBioKeywords: ['giveaway']
  };
  const spam = { restId: '9', username: 'spam', verified: false, defaultProfileImage: true, followersCount: 5, bio: 'free giveaway' };
  assert.equal(evaluatePreSaveFilter(spam, rules).pass, false);

  const whitelisted = evaluatePreSaveFilter(spam, rules, new Set(['9']));
  assert.equal(whitelisted.pass, true);
});

test('graphql-parser handles both legacy and modern core/avatar/verification X schemas', () => {
  const samplePayload = {
    data: {
      user: {
        result: {
          __typename: 'User',
          rest_id: '777',
          is_blue_verified: true,
          core: { name: 'Modern User', screen_name: 'ModernHandle' },
          avatar: { image_url: 'https://pbs.twimg.com/profile_images/777/avatar_normal.jpg' },
          legacy: { followers_count: 1450, friends_count: 210, description: 'Full bio text' }
        }
      },
      timeline: {
        instructions: [
          {
            entries: [
              {
                content: {
                  itemContent: {
                    user_results: {
                      result: {
                        __typename: 'User',
                        rest_id: '888',
                        legacy: {
                          screen_name: 'legacy_user',
                          name: 'Legacy User',
                          profile_image_url_https: 'https://pbs.twimg.com/profile_images/888/pic_normal.jpg',
                          verified: true,
                          followers_count: 90,
                          friends_count: 12,
                          description: 'Legacy bio'
                        }
                      }
                    }
                  }
                }
              },
              {
                content: {
                  entryType: 'TimelineTimelineCursor',
                  cursorType: 'Bottom',
                  value: 'CURSOR_NEXT_123'
                }
              }
            ]
          }
        ]
      }
    }
  };

  const counts = graphqlParser.extractProfileCounts(samplePayload, 'modernhandle');
  assert.equal(counts.followers, 1450);
  assert.equal(counts.following, 210);
  assert.equal(counts.restId, '777');

  const timeline = graphqlParser.extractTimelinePayload(samplePayload);
  assert.equal(timeline.users.length, 2);
  assert.equal(timeline.bottomCursor, 'CURSOR_NEXT_123');
  assert.equal(timeline.users[0].username, 'modernhandle');
  assert.equal(timeline.users[1].username, 'legacy_user');
});

test('manifest.json complies with MV3, description <= 132 chars, existing scripts, and exact PNG icon sizes', () => {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.description.length <= 132, `description too long: ${manifest.description.length}`);
  assert.ok(fs.existsSync(path.join(rootDir, manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(rootDir, manifest.side_panel.default_path)));

  for (const cs of manifest.content_scripts || []) {
    for (const file of cs.js || []) {
      assert.ok(fs.existsSync(path.join(rootDir, file)), `missing content script: ${file}`);
    }
  }

  const readPngDimensions = (filePath) => {
    const buf = fs.readFileSync(filePath);
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20)
    };
  };

  for (const [sizeStr, relPath] of Object.entries(manifest.icons || {})) {
    const expected = Number(sizeStr);
    const full = path.join(rootDir, relPath);
    assert.ok(fs.existsSync(full), `missing icon ${relPath}`);
    const dims = readPngDimensions(full);
    assert.equal(dims.width, expected, `${relPath} width mismatch`);
    assert.equal(dims.height, expected, `${relPath} height mismatch`);
  }
});

test('shared/db exports getSettings, saveSettings, and createEmptyAccountRecord cleanly without ReferenceError', async () => {
  const settings = await getSettings();
  assert.equal(settings.theme, 'system');
  assert.equal(settings.preSaveFilters.verifiedMode, 'all');

  const updated = await saveSettings({ theme: 'dark' });
  assert.equal(updated.theme, 'dark');

  const rec = createEmptyAccountRecord('@Demo_User');
  assert.equal(rec.accountKey, 'demo_user');
});



test('scanTabMode defaults to unthrottled dedicated active tab', async () => {
  const { DEFAULT_SETTINGS } = await import('../shared/constants.js');
  assert.equal(DEFAULT_SETTINGS.scanTabMode, 'dedicated');
});

test('service worker clears active scan session before closing dedicated tab so onRemoved does not overwrite real error', async () => {
  const sessionStore = new Map();
  const localStore = new Map();
  const idbStores = new Map();
  const onUpdatedListeners = new Set();
  const tabUrls = new Map();
  const listeners = { onMessage: null, onRemoved: null };
  const events = [];
  let activeTabId = 10;

  const makeReq = (executor) => {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      try {
        req.result = executor(req);
        req.onsuccess?.({ target: req });
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
    });
    return req;
  };

  globalThis.IDBKeyRange = {
    only: (v) => v,
    bound: () => ({})
  };

  globalThis.indexedDB = {
    open: () => {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      const storeKeyPaths = new Map();
      const getStoreMap = (name) => {
        if (!idbStores.has(name)) idbStores.set(name, new Map());
        return idbStores.get(name);
      };
      const putItem = (name, v) => {
        const kp = storeKeyPaths.get(name);
        const key = (kp && v?.[kp]) || v?.id || v?.scanId || v?.eventId || v?.captureId || v?.accountKey || String(Math.random());
        getStoreMap(name).set(key, v);
        return key;
      };
      const db = {
        objectStoreNames: { contains: (name) => idbStores.has(name) },
        createObjectStore: (name, opts = {}) => {
          getStoreMap(name);
          if (opts?.keyPath) storeKeyPaths.set(name, opts.keyPath);
          return {
            indexNames: { contains: () => true },
            createIndex: () => {},
            put: (v) => makeReq(() => putItem(name, v))
          };
        },
        transaction: () => {
          const tx = { oncomplete: null, onerror: null, onabort: null };
          let pendingOps = 0;
          const scheduleComplete = () => {
            setTimeout(() => {
              if (pendingOps === 0) tx.oncomplete?.();
              else scheduleComplete();
            }, 0);
          };
          const trackReq = (executor) => {
            pendingOps++;
            return makeReq((r) => {
              try {
                return executor(r);
              } finally {
                pendingOps--;
              }
            });
          };
          scheduleComplete();
          tx.objectStore = (name) => {
            const map = getStoreMap(name);
            return {
              get: (k) => trackReq(() => map.get(k)),
              getAll: () => trackReq(() => Array.from(map.values())),
              put: (v) => trackReq(() => putItem(name, v)),
              delete: (k) => trackReq(() => { map.delete(k); return undefined; }),
              clear: () => trackReq(() => { map.clear(); return undefined; }),
              index: () => ({ getAll: () => trackReq(() => Array.from(map.values())) })
            };
          };
          return tx;
        }
      };
      queueMicrotask(() => {
        req.result = db;
        req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    }
  };

  const fireUpdated = (id, changeInfo, tab) => {
    for (const fn of Array.from(onUpdatedListeners)) {
      fn(id, changeInfo, tab);
    }
  };

  globalThis.chrome = {
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    windows: { getLastFocused: async () => ({ id: 1 }) },
    alarms: {
      create: async () => {},
      clear: async () => true,
      get: async () => null,
      onAlarm: { addListener: () => {} }
    },
    notifications: { create: async () => {}, onClicked: { addListener: () => {} } },
    scripting: { executeScript: async () => [] },
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
      getURL: (p) => p
    },
    tabs: {
      query: async (q) => (q?.active ? [{ id: activeTabId, url: 'https://x.com/home' }] : [{ id: 10, url: 'https://x.com/home' }]),
      create: async ({ url, active }) => {
        const id = 99;
        tabUrls.set(id, url);
        if (active) activeTabId = id;
        events.push(`tabs.create:${active ? 'active' : 'bg'}:${url}`);
        setTimeout(() => {
          fireUpdated(id, { status: 'complete' }, { id, url, status: 'complete' });
        }, 0);
        return { id, url, status: 'loading' };
      },
      get: async (id) => ({ id, url: tabUrls.get(id) || 'https://x.com/home', status: 'complete' }),
      update: async (id, patch) => {
        if (patch?.active) activeTabId = id;
        if (patch?.url) tabUrls.set(id, patch.url);
        events.push(`tabs.update:${id}:${JSON.stringify(patch)}`);
        if (patch?.url) {
          setTimeout(() => {
            fireUpdated(id, { status: 'loading' }, { id, url: patch.url, status: 'loading' });
            fireUpdated(id, { status: 'complete' }, { id, url: patch.url, status: 'complete' });
          }, 0);
        }
        return { id, url: tabUrls.get(id) || 'https://x.com/alice/followers', status: 'complete' };
      },
      remove: async (id) => {
        events.push(`tabs.remove:${id}`);
        await listeners.onRemoved?.(id);
      },
      sendMessage: async (_id, msg) => {
        if (msg.action === 'pingScraper') return { ok: true };
        if (msg.action === 'probeProfileDom') return { followers: 12, following: 5, source: 'dom' };
        if (msg.action === 'runGuidedScan') return { ok: true, status: 'started' };
        return { ok: true };
      },
      onRemoved: { addListener: (fn) => { listeners.onRemoved = fn; } },
      onUpdated: {
        addListener: (fn) => { onUpdatedListeners.add(fn); },
        removeListener: (fn) => { onUpdatedListeners.delete(fn); }
      }
    },
    storage: {
      session: {
        get: async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = sessionStore.get(k);
          return out;
        },
        set: async (obj) => Object.entries(obj).forEach(([k, v]) => sessionStore.set(k, v)),
        remove: async (k) => {
          events.push(`session.remove:${k}`);
          sessionStore.delete(k);
        }
      },
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = localStore.get(k);
          return out;
        },
        set: async (obj) => Object.entries(obj).forEach(([k, v]) => localStore.set(k, v)),
        remove: async (k) => localStore.delete(k)
      }
    }
  };

  localStore.set('settings', { scanTabMode: 'dedicated', notificationsEnabled: false, inPageBadgeEnabled: false });

  try {
    await import('../background.js?test=' + Date.now());
    const dbMod = await import('../shared/db.js');
    const dispatch = (msg) => new Promise((resolve) => listeners.onMessage(msg, {}, resolve));

    const startRes = await dispatch({ action: 'startScan', username: 'alice', scanType: 'followers' });
    assert.equal(startRes.status, 'scanning');
    assert.equal(activeTabId, 99);

    const errRes = await dispatch({
      action: 'scanError',
      scanId: startRes.scanId,
      username: 'alice',
      scanType: 'followers',
      error: 'Simulated list timeout.'
    });
    assert.equal(errRes.status, 'ok');

    const removeSessionIdx = events.indexOf('session.remove:activeScanSession');
    const removeTabIdx = events.indexOf('tabs.remove:99');
    assert.ok(removeSessionIdx >= 0 && removeTabIdx > removeSessionIdx, 'session must clear before tab closes');
    assert.equal(activeTabId, 10, 'original active tab should be restored');
    assert.equal(localStore.get('scanLiveState')?.error, 'Simulated list timeout.');

    // Verify structured telemetry logs were persisted and queryable/exportable
    const allLogs = await dbMod.listAppLogs({ limit: 50 });
    assert.ok(allLogs.some((l) => l.event === 'scan.start'), 'expected scan.start log');
    assert.ok(allLogs.some((l) => l.event === 'scan.error' && l.level === 'error'), 'expected scan.error log');

    const errLogs = await dbMod.listAppLogs({ level: 'error' });
    assert.equal(errLogs[0].event, 'scan.error');

    const report = await dbMod.buildDiagnosticReport({ accountKey: 'alice', runtime: { test: true } });
    assert.equal(report.reportVersion, 1);
    assert.ok(report.logs.length >= 2);
  } finally {
    delete globalThis.chrome;
    delete globalThis.indexedDB;
    delete globalThis.IDBKeyRange;
  }
});

test('computeScanDiff auto-demotes to additive partial when coverage is catastrophically low', () => {
  // Simulates: previous full scan had 500 followers, new scan only captured 50/500 (10% coverage)
  // due to background tab throttling. Without the safety guard, this would mark 450 as unfollowed.
  const prevAccount = {
    accountKey: 'owner',
    username: 'owner',
    followerIds: Array.from({ length: 500 }, (_, i) => String(i + 1)),
    followingIds: [],
    verifiedFollowerIds: [],
    mutualFollowerIds: [],
    whitelistIds: [],
    activeUnfollowers: {},
    activeNewFollowers: {},
    refollowers: {},
    scanCount: 5,
    lastFollowersCheck: 1000
  };

  const incomingUsers = Array.from({ length: 50 }, (_, i) => ({
    restId: String(i + 1),
    username: `user_${i + 1}`,
    name: `User ${i + 1}`
  }));

  const result = computeScanDiff({
    account: prevAccount,
    existingProfiles: {},
    incomingUsers,
    scanType: 'followers',
    expectedCount: 500,
    partial: false,  // scraper thinks it's complete
    now: 2000,
    scanId: 'low-coverage-1'
  });

  // Safety guard should have auto-demoted to additive partial
  assert.equal(result.account.followerIds.length, 500, 'baseline must be preserved, not replaced with 50');
  assert.equal(Object.keys(result.account.activeUnfollowers).length, 0, 'no false unfollows');
  assert.equal(result.snapshot.delta.lost.length, 0, 'no lost events');
  // Quality should reflect partial coverage
  assert.ok(result.quality.coverage < 0.5, 'coverage must be below 50%');
});

test('computeScanDiff validates 0-follower baseline and detects subsequent +1 follower', async () => {
  const { computeScanDiff } = await import('../shared/diff.js');
  const { createEmptyAccountRecord } = await import('../shared/db.js');

  const initialAccount = createEmptyAccountRecord('zero_user');
  const scanZero = computeScanDiff({
    account: initialAccount,
    existingProfiles: {},
    incomingUsers: [],
    scanType: 'followers',
    expectedCount: 0,
    scanId: 'scan_0',
    now: 1000
  });

  assert.equal(scanZero.quality.isValid, true);
  assert.equal(scanZero.quality.qualityStatus, 'verified_complete');
  assert.equal(scanZero.account.followerIds.length, 0);
  assert.equal(scanZero.events.length, 0);

  const scanOne = computeScanDiff({
    account: scanZero.account,
    existingProfiles: scanZero.profiles,
    incomingUsers: [{ restId: '42', username: 'first_fan', name: 'First Fan' }],
    scanType: 'followers',
    expectedCount: 1,
    scanId: 'scan_1',
    now: 2000
  });

  assert.equal(scanOne.account.followerIds.length, 1);
  assert.deepEqual(scanOne.snapshot.delta.gained, ['42']);
  assert.equal(scanOne.events[0].type, 'followed');
});

test('main-interceptor captures api.x.com GraphQL requests without /i/api prefix and emits telemetry', async () => {
  const vm = await import('node:vm');
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const code = fs.readFileSync(path.join(rootDir, 'content/main-interceptor.js'), 'utf8');

  const networkEvents = [];
  const telemetryEvents = [];
  const docListeners = new Map();

  const sandbox = {
    URL,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    location: { origin: 'https://x.com' },
    document: {
      addEventListener: (name, fn) => docListeners.set(name, fn),
      dispatchEvent: (ev) => {
        if (ev.type === 'x-tracker:network') networkEvents.push(JSON.parse(ev.detail));
        if (ev.type === 'x-tracker:telemetry') telemetryEvents.push(JSON.parse(ev.detail));
      }
    },
    XMLHttpRequest: class FakeXHR {
      open() {}
      send() {}
    },
    queueMicrotask,
    setTimeout
  };
  sandbox.window = sandbox;
  sandbox.window.fetch = async () => ({
    status: 200,
    headers: { get: (k) => (k === 'x-rate-limit-remaining' ? '48' : null) },
    clone() {
      return {
        json: async () => ({ data: { user: { result: { timeline: { timeline: { instructions: [] } } } } } })
      };
    }
  });

  vm.runInNewContext(code, sandbox);
  await sandbox.window.fetch('https://api.x.com/graphql/abc123/Followers?variables=%7B%7D');
  await sandbox.window.fetch('https://api.x.com/graphql/def456/HomeSettings?variables=%7B%7D');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(networkEvents.length, 1);
  assert.equal(networkEvents[0].op, 'Followers');
  assert.equal(networkEvents[0].status, 200);
  assert.ok(telemetryEvents.some((t) => t.kind === 'gql_matched' && t.op === 'Followers' && t.host === 'api.x.com'));
  assert.ok(telemetryEvents.some((t) => t.kind === 'gql_unmatched' && t.op === 'HomeSettings' && t.host === 'api.x.com'));
});


test('graphql-parser reads relationship_counts fallback and scraper ignores HTTP 200 future x-rate-limit-reset', async () => {
  const vm = await import('node:vm');
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const parserCode = fs.readFileSync(path.join(rootDir, 'content/graphql-parser.js'), 'utf8');
  const scraperCode = fs.readFileSync(path.join(rootDir, 'content/scraper.js'), 'utf8');

  const parserSandbox = {};
  vm.runInNewContext(parserCode, parserSandbox);
  const relParsed = parserSandbox.__XTrackerGraphQL.extractProfileCounts({
    data: {
      user: {
        result: {
          rest_id: '111',
          core: { screen_name: 'rel_user', name: 'Rel User' },
          relationship_counts: { followers: 321, following: 44 },
          legacy: {}
        }
      }
    }
  });
  assert.equal(relParsed.followers, 321);
  assert.equal(relParsed.following, 44);

  const sentMessages = [];
  const docListeners = new Map();
  let runtimeListener = null;

  const docObj = {
    hidden: false,
    title: 'Followers',
    body: {
      querySelectorAll: () => [],
      querySelector: () => null,
      innerText: ''
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (name, fn) => {
      if (!docListeners.has(name)) docListeners.set(name, []);
      docListeners.get(name).push(fn);
    },
    dispatchEvent: (ev) => {
      for (const fn of docListeners.get(ev.type) || []) fn(ev);
    }
  };
  docObj.documentElement = docObj.body;
  docObj.scrollingElement = docObj.body;

  const sandbox = {
    Map,
    Set,
    URL,
    Date,
    Math,
    Number,
    String,
    Array,
    Boolean,
    JSON,
    Promise,
    Error,
    Object,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    location: { origin: 'https://x.com', pathname: '/rel_user/followers' },
    document: docObj,
    window: null,
    chrome: {
      runtime: {
        id: 'test-ext',
        lastError: null,
        onMessage: { addListener: (fn) => { runtimeListener = fn; } },
        sendMessage: (payload, cb) => {
          sentMessages.push(payload);
          cb?.({ status: 'ok' });
        }
      }
    },
    setTimeout,
    clearTimeout,
    scrollBy: () => {},
    innerHeight: 800
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__XTrackerGraphQL = parserSandbox.__XTrackerGraphQL;

  vm.runInNewContext(scraperCode, sandbox);

  let startAck = null;
  runtimeListener(
    {
      action: 'runGuidedScan',
      config: { scanId: 'scan_rl_test', username: 'rel_user', scanType: 'followers', expectedCount: 1 }
    },
    {},
    (res) => { startAck = res; }
  );
  assert.equal(startAck?.ok, true);

  // Dispatch HTTP 200 Followers with 1 user and a future x-rate-limit-reset (remaining=48)
  docObj.dispatchEvent({
    type: 'x-tracker:network',
    detail: JSON.stringify({
      op: 'Followers',
      category: 'core',
      status: 200,
      rateLimit: { limit: 50, remaining: 48, resetAtMs: Date.now() + 900_000 },
      json: {
        data: {
          user: {
            result: {
              timeline: {
                timeline: {
                  instructions: [
                    {
                      type: 'TimelineAddEntries',
                      entries: [
                        {
                          content: {
                            itemContent: {
                              user_results: {
                                result: {
                                  rest_id: '555',
                                  core: { screen_name: 'fan_one', name: 'Fan One' },
                                  legacy: {}
                                }
                              }
                            }
                          }
                        }
                      ]
                    }
                  ]
                }
              }
            }
          }
        }
      }
    })
  });

  // Give the async scan loop enough ticks to finish cleanly rather than aborting on fake rate limit
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !sentMessages.some((m) => m.action === 'scanFinalize' || m.action === 'scanError')) {
    await new Promise((r) => setTimeout(r, 80));
  }

  const errMsg = sentMessages.find((m) => m.action === 'scanError');
  const finMsg = sentMessages.find((m) => m.action === 'scanFinalize');
  assert.equal(errMsg, undefined, `unexpected scanError: ${errMsg?.error}`);
  assert.ok(finMsg, 'expected scanFinalize to run');
  assert.equal(finMsg.users.length, 1);
});
