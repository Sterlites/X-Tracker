/**
 * Pure parser for X client-side GraphQL / REST payloads captured passively from MAIN world.
 * Tolerates both legacy (`result.legacy.*`) and modern (`result.core.*`, `result.avatar.*`,
 * `result.verification.*`) X web schemas.
 */
(function initGraphQLParser(root) {
  function normalizeHandle(value) {
    return String(value || '').trim().replace(/^@+/, '').trim().toLowerCase();
  }

  function sanitizeAvatar(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (/[\s"'()<>\\]/.test(trimmed)) return '';
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === 'https:' ? parsed.toString() : '';
    } catch {
      return '';
    }
  }

  /**
   * Normalize a GraphQL User result object (handling core + legacy + verification + privacy shapes).
   * @param {Object} rawResult
   * @returns {Object|null}
   */
  function normalizeGraphQLUser(rawResult) {
    if (!rawResult || typeof rawResult !== 'object') return null;

    // Unwrap wrapper { result: { ... } } if passed directly
    const node = rawResult.user_results?.result || rawResult.result || rawResult;

    if (node.__typename === 'UserUnavailable') {
      return {
        unavailable: true,
        reason: node.reason || 'Unavailable',
        message: node.message || ''
      };
    }

    const legacy = node.legacy || {};
    const core = node.core || {};
    const avatarObj = node.avatar || {};
    const verification = node.verification || {};
    const privacy = node.privacy || {};
    const relationship = node.relationship_perspectives || {};

    const rawHandle = core.screen_name || legacy.screen_name;
    const username = normalizeHandle(rawHandle);
    const restId = node.rest_id ? String(node.rest_id).trim() : null;

    if (!username && !restId) {
      return null;
    }

    const name = (core.name || legacy.name || username || '').trim();
    const avatarRaw = avatarObj.image_url || legacy.profile_image_url_https || '';
    const avatar = sanitizeAvatar(avatarRaw.replace('_normal.', '_bigger.')) || sanitizeAvatar(avatarRaw);
    const isBlueVerified = Boolean(
      node.is_blue_verified ?? verification.is_blue_verified ?? false
    );
    const verifiedType = verification.verified_type || legacy.verified_type || null;
    const verified = Boolean(
      isBlueVerified || verification.verified || legacy.verified || verifiedType
    );

    const relCounts = node.relationship_counts || {};
    const followersCount = Number.isFinite(legacy.followers_count)
      ? legacy.followers_count
      : (Number.isFinite(relCounts.followers) ? relCounts.followers : null);
    const followingCount = Number.isFinite(legacy.friends_count)
      ? legacy.friends_count
      : (Number.isFinite(relCounts.following) ? relCounts.following : null);
    const statusesCount = Number.isFinite(legacy.statuses_count)
      ? legacy.statuses_count
      : null;

    return {
      restId,
      username,
      name: name || username,
      bio: String(legacy.description || '').trim(),
      avatar,
      verified,
      isBlueVerified,
      verifiedType,
      protected: Boolean(privacy.protected ?? legacy.protected ?? false),
      suspended: false,
      defaultProfileImage: Boolean(legacy.default_profile_image ?? false),
      followersCount,
      followingCount,
      statusesCount,
      createdAt: core.created_at || legacy.created_at || null,
      followedBy:
        typeof relationship.followed_by === 'boolean'
          ? relationship.followed_by
          : (typeof legacy.followed_by === 'boolean' ? legacy.followed_by : null),
      following:
        typeof relationship.following === 'boolean'
          ? relationship.following
          : (typeof legacy.following === 'boolean' ? legacy.following : null),
      canDm: typeof legacy.can_dm === 'boolean' ? legacy.can_dm : null,
      profileUrl: username ? `https://x.com/${username}` : '',
      timestamp: Date.now()
    };
  }

  /**
   * Recursively collect timeline entries, users, cursors, and tweet records from a GraphQL JSON payload.
   * @param {Object} json
   */
  function extractTimelinePayload(json) {
    const users = [];
    const tweets = [];
    const seenUserKeys = new Set();
    const seenTweetIds = new Set();
    let bottomCursor = null;
    let topCursor = null;
    let profileOwner = null;

    function addUser(u) {
      if (!u || u.unavailable) return;
      const key = u.restId || u.username;
      if (!key || seenUserKeys.has(key)) return;
      seenUserKeys.add(key);
      users.push(u);
    }

    function walk(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 25) return;

      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }

      // Timeline cursor detection
      if (
        (node.entryType === 'TimelineTimelineCursor' || node.__typename === 'TimelineTimelineCursor') &&
        typeof node.value === 'string'
      ) {
        if (node.cursorType === 'Bottom') bottomCursor = node.value;
        if (node.cursorType === 'Top') topCursor = node.value;
      }

      // Direct User object inside user_results / user / viewer
      if (node.__typename === 'User' || (node.rest_id && (node.legacy?.screen_name || node.core?.screen_name))) {
        const parsedUser = normalizeGraphQLUser(node);
        if (parsedUser && !parsedUser.unavailable) {
          addUser(parsedUser);
        }
      }

      // Profile owner detection (UserByScreenName / UserByRestId)
      if (node.data?.user?.result) {
        const owner = normalizeGraphQLUser(node.data.user.result);
        if (owner) profileOwner = owner;
      }

      // Tweet / post extraction for passive capture scopes
      if (
        (node.__typename === 'Tweet' || node.__typename === 'TweetWithVisibilityResults') &&
        (node.rest_id || node.tweet?.rest_id)
      ) {
        const t = node.tweet || node;
        const legacy = t.legacy || {};
        const rawAuthor = t.core?.user_results?.result;
        const author = rawAuthor ? normalizeGraphQLUser(rawAuthor) : null;
        const tweetId = String(t.rest_id || legacy.id_str || '');
        if (tweetId && !seenTweetIds.has(tweetId)) {
          seenTweetIds.add(tweetId);
          tweets.push({
            tweetId,
            text: String(t.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '').trim(),
            createdAt: legacy.created_at || null,
            likes: Number(legacy.favorite_count) || 0,
            reposts: Number(legacy.retweet_count) || 0,
            replies: Number(legacy.reply_count) || 0,
            bookmarks: Number(legacy.bookmark_count) || 0,
            url: author?.username ? `https://x.com/${author.username}/status/${tweetId}` : '',
            author: author && !author.unavailable ? author : null
          });
        }
      }

      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
          walk(value, depth + 1);
        }
      }
    }

    walk(json);

    return {
      users,
      tweets,
      profileOwner,
      bottomCursor,
      topCursor
    };
  }

  /**
   * Extract profile counts and unavailability diagnostics from UserByScreenName / UserByRestId JSON.
   */
  function extractProfileCounts(json, expectedHandle = null) {
    const result = json?.data?.user?.result;
    if (!result) return null;

    if (result.__typename === 'UserUnavailable') {
      return {
        unavailable: true,
        reason: result.reason || 'Unavailable',
        message: result.message || ''
      };
    }

    const user = normalizeGraphQLUser(result);
    if (!user || user.unavailable) return null;

    if (expectedHandle && user.username && user.username !== normalizeHandle(expectedHandle)) {
      return null;
    }

    return {
      restId: user.restId,
      username: user.username,
      name: user.name,
      avatar: user.avatar,
      followers: user.followersCount,
      following: user.followingCount,
      protected: user.protected,
      unavailable: false
    };
  }

  const api = {
    normalizeGraphQLUser,
    extractTimelinePayload,
    extractProfileCounts
  };

  root.__XTrackerGraphQL = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
