/**
 * Shared constants across Service Worker, Side Panel, and shared utilities.
 */

export const APP_VERSION = '3.0.0';
export const DB_NAME = 'XTrackerDB';
export const DB_VERSION = 2;
export const MAX_APP_LOGS = 600;

export const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,15}$/;

export const SCAN_SCOPES = Object.freeze({
  followers: {
    id: 'followers',
    path: 'followers',
    label: 'Followers',
    opNames: ['Followers']
  },
  verified_followers: {
    id: 'verified_followers',
    path: 'verified_followers',
    label: 'Verified Followers',
    opNames: ['BlueVerifiedFollowers']
  },
  followers_you_follow: {
    id: 'followers_you_follow',
    path: 'followers_you_follow',
    label: 'Followers You Know',
    opNames: ['FollowersYouKnow']
  },
  following: {
    id: 'following',
    path: 'following',
    label: 'Following',
    opNames: ['Following']
  }
});

export const CAPTURE_SCOPES = Object.freeze({
  profile: { id: 'profile', label: 'Profile Audit', opNames: ['UserByScreenName', 'UserByRestId', 'UserTweets'] },
  thread: { id: 'thread', label: 'Thread Participants', opNames: ['TweetDetail'] },
  search: { id: 'search', label: 'Search Results', opNames: ['SearchTimeline'] },
  bookmarks: { id: 'bookmarks', label: 'Bookmarks', opNames: ['Bookmarks'] },
  feed: { id: 'feed', label: 'Home Feed', opNames: ['HomeTimeline', 'HomeLatestTimeline'] }
});

export const RELATIONSHIP_EVENT_TYPES = Object.freeze([
  'followed',
  'refollowed',
  'unfollowed',
  'reunfollowed',
  'renamed',
  'suspended',
  'deactivated',
  'you_followed',
  'you_unfollowed'
]);

export const RESERVED_X_PATHS = new Set([
  'i',
  'home',
  'search',
  'hashtag',
  'explore',
  'notifications',
  'messages',
  'settings',
  'compose',
  'login',
  'signup',
  'logout',
  'tos',
  'privacy',
  'about',
  'intent',
  'share',
  'account',
  'topics',
  'lists',
  'bookmarks',
  'communities',
  'grok',
  'jobs',
  'spaces',
  'articles',
  'premium',
  'verified',
  'downloads',
  'help',
  'ads',
  'analytics',
  'directory'
]);

export const AUTO_SCAN_ALARM = 'autoFollowersScan';
export const SCAN_WATCHDOG_ALARM = 'scanWatchdog';

export const DEFAULT_AUTO_SCAN_INTERVAL_MINUTES = 120;
export const AUTO_SCAN_FORCED_SYNC_MS = 24 * 60 * 60 * 1000;
export const AUTO_SCAN_RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000; // Default 15m if header absent
export const SCAN_WATCHDOG_STALE_MS = 95 * 1000;

export const DEFAULT_PRE_SAVE_FILTERS = Object.freeze({
  verifiedMode: 'all', // 'all' | 'verified_only' | 'blue_only' | 'non_verified'
  excludeDefaultAvatar: false,
  minFollowers: 0,
  excludeBioKeywords: []
});

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system', // 'system' | 'dark' | 'light'
  scanTabMode: 'dedicated', // 'dedicated' | 'background' | 'active'
  notificationsEnabled: true,
  inPageBadgeEnabled: false,
  autoScanEnabled: false,
  autoScanIntervalMinutes: DEFAULT_AUTO_SCAN_INTERVAL_MINUTES,
  preSaveFilters: DEFAULT_PRE_SAVE_FILTERS
});

export const STORAGE_KEYS = Object.freeze({
  currentUser: 'currentUser',
  settings: 'xTrackerSettings',
  scanStatus: 'scanStatus',
  scanState: 'scanLiveState',
  lastDbMutationAt: 'lastDbMutationAt',
  lastLogMutationAt: 'lastLogMutationAt',
  lastError: 'lastError',
  autoScanMeta: 'autoScanMeta',
  legacyMigrated: 'legacyMigratedV3'
});

export const SESSION_KEYS = Object.freeze({
  activeScan: 'activeScanSession',
  passiveCapture: 'passiveCaptureSession'
});
