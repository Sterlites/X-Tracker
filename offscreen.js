/**
 * X-Unfollow Tracker - Offscreen Document Script
 * Handles ONLY parameter discovery (parsing X's JS bundles for query IDs and feature flags).
 * All actual API calls are made from the background service worker which has proper
 * host_permissions and cookie access.
 */

// ================== X API Configuration ==================

// Hardcoded fallback GraphQL endpoints (widely known, used by X's web client)
const GRAPHQL_ENDPOINTS = {
  followers: { queryId: 'xBB-_3k-LNxWg8TFpuQiWQ', operationName: 'Followers' },
  following: { queryId: 'OEx3R66nP411LbwQ0xgAIg', operationName: 'Following' },
  userByScreenName: { queryId: 'pLsOiyHJ1eFwPJlNmLp4Bg', operationName: 'UserByScreenName' }
};

// Default features flags that X's web client sends (for followers/following timeline endpoints)
const DEFAULT_FEATURES = {
  "rweb_video_screen_enabled": false,
  "profile_label_improvements_pcf_label_in_post_enabled": true,
  "responsive_web_profile_redirect_enabled": false,
  "rweb_tipjar_consumption_enabled": false,
  "verified_phone_label_enabled": true,
  "creator_subscriptions_tweet_preview_api_enabled": true,
  "responsive_web_graphql_timeline_navigation_enabled": true,
  "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
  "premium_content_api_read_enabled": false,
  "communities_web_enable_tweet_community_results_fetch": true,
  "c9s_tweet_anatomy_moderator_badge_enabled": true,
  "responsive_web_grok_analyze_button_fetch_trends_enabled": false,
  "responsive_web_grok_analyze_post_followups_enabled": true,
  "responsive_web_jetfuel_frame": true,
  "responsive_web_grok_share_attachment_enabled": true,
  "responsive_web_grok_annotations_enabled": true,
  "articles_preview_enabled": true,
  "responsive_web_edit_tweet_api_enabled": true,
  "graphql_is_translatable_rweb_tweet_is_translatable_enabled": true,
  "view_counts_everywhere_api_enabled": true,
  "longform_notetweets_consumption_enabled": true,
  "responsive_web_twitter_article_tweet_consumption_enabled": true,
  "tweet_awards_web_tipping_enabled": false,
  "content_disclosure_indicator_enabled": true,
  "content_disclosure_ai_generated_indicator_enabled": true,
  "responsive_web_grok_show_grok_translated_post": false,
  "responsive_web_grok_analysis_button_from_backend": true,
  "post_ctas_fetch_enabled": true,
  "freedom_of_speech_not_reach_fetch_enabled": true,
  "standardized_nudges_misinfo": true,
  "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": true,
  "longform_notetweets_rich_text_read_enabled": true,
  "longform_notetweets_inline_media_enabled": false,
  "responsive_web_grok_image_annotation_enabled": true,
  "responsive_web_grok_imagine_annotation_enabled": true,
  "responsive_web_grok_community_note_auto_translation_is_enabled": false,
  "responsive_web_enhance_cards_enabled": false
};

// Features specifically for UserByScreenName
const USER_FEATURES = {
  "hidden_profile_subscriptions_enabled": true,
  "profile_label_improvements_pcf_label_in_post_enabled": true,
  "responsive_web_profile_redirect_enabled": false,
  "rweb_tipjar_consumption_enabled": false,
  "verified_phone_label_enabled": true,
  "subscriptions_verification_info_is_identity_verified_enabled": true,
  "subscriptions_verification_info_verified_since_enabled": true,
  "highlights_tweets_tab_ui_enabled": true,
  "responsive_web_twitter_article_notes_tab_enabled": true,
  "subscriptions_feature_can_gift_premium": true,
  "creator_subscriptions_tweet_preview_api_enabled": true,
  "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
  "responsive_web_graphql_timeline_navigation_enabled": true
};

// ================== Parameter Discovery ==================

/**
 * Discover current GraphQL query IDs and feature flags from X's JS bundles.
 * @returns {Object} { endpoints, features, userFeatures }
 */
async function discoverParameters() {
  console.log('--- STARTING DYNAMIC X PARAMETER DISCOVERY ---');

  const result = {
    endpoints: JSON.parse(JSON.stringify(GRAPHQL_ENDPOINTS)),
    features: DEFAULT_FEATURES,
    userFeatures: USER_FEATURES
  };

  try {
    // 1. Fetch main page to find JS bundles
    const mainResp = await fetch('https://x.com');
    const html = await mainResp.text();

    // Broad JS bundle extraction
    const scriptRegex = /src="(https:\/\/[^"]+\.js)"/g;
    const bundles = [];
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
      const url = match[1];
      if (!url.includes('twimg.com') && !url.includes('x.com')) continue;
      const name = url.split('/').pop() || '';
      if (name.includes('main') || name.includes('api') || name.includes('vendor')) {
        bundles.unshift(url);
      } else {
        bundles.push(url);
      }
    }

    console.log(`Scanning ${Math.min(bundles.length, 15)} of ${bundles.length} bundles for API patterns...`);

    const operations = ['Followers', 'Following', 'UserByScreenName'];
    const foundIds = {};
    let foundFeatures = null;

    for (const url of bundles.slice(0, 15)) {
      if (Object.keys(foundIds).length === operations.length && foundFeatures) break;

      try {
        const js = await (await fetch(url)).text();

        // Find Query IDs
        for (const op of operations) {
          if (foundIds[op]) continue;
          const idMatch = new RegExp(`queryId\\s*:\\s*"([A-Za-z0-9_-]+)"\\s*,\\s*operationName\\s*:\\s*"${op}"`, 'i').exec(js) ||
                          new RegExp(`"([A-Za-z0-9_-]+)"\\s*,\\s*operationName\\s*:\\s*"${op}"`, 'i').exec(js);
          if (idMatch) {
            foundIds[op] = idMatch[1];
            console.log(`[ID] Found ${op}: ${idMatch[1]}`);
          }
        }

        // Find Feature Flags using balanced-brace matching
        if (!foundFeatures && js.includes('rweb_video_screen_enabled')) {
          const flagStart = js.indexOf('{"rweb_video_screen_enabled":');
          if (flagStart !== -1) {
            let depth = 0;
            let end = flagStart;
            for (let i = flagStart; i < Math.min(flagStart + 5000, js.length); i++) {
              if (js[i] === '{') depth++;
              else if (js[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
            }
            try {
              foundFeatures = JSON.parse(js.substring(flagStart, end));
              console.log(`[FLAGS] Successfully extracted ${Object.keys(foundFeatures).length} feature flags`);
            } catch (e) {
              console.warn('[FLAGS] Failed to parse feature flags:', e.message);
            }
          }
        }
      } catch (err) {
        // Individual bundle fetch failed — continue
      }
    }

    // Update result with discovered values
    const idsFound = Object.keys(foundIds).length;
    if (idsFound > 0) {
      result.endpoints.followers.queryId = foundIds['Followers'] || result.endpoints.followers.queryId;
      result.endpoints.following.queryId = foundIds['Following'] || result.endpoints.following.queryId;
      result.endpoints.userByScreenName.queryId = foundIds['UserByScreenName'] || result.endpoints.userByScreenName.queryId;
    }
    if (foundFeatures) {
      result.features = foundFeatures;
    }

    console.log(`--- DISCOVERY COMPLETE (${idsFound}/3 IDs, features: ${foundFeatures ? 'YES' : 'NO (using defaults)'}) ---`);
    console.log('Final endpoints:', JSON.stringify(result.endpoints, null, 2));
  } catch (error) {
    console.error('Discovery failed - using fallback values:', error);
  }

  return result;
}

// ================== Message Handler ==================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.action) {
    case 'discoverParameters':
      discoverParameters()
        .then(result => sendResponse(result))
        .catch(error => {
          console.error('Discovery handler failed:', error);
          sendResponse({
            error: error.message,
            // Return defaults even on failure
            endpoints: JSON.parse(JSON.stringify(GRAPHQL_ENDPOINTS)),
            features: DEFAULT_FEATURES,
            userFeatures: USER_FEATURES
          });
        });
      return true; // Keep channel open for async response

    default:
      return false;
  }
});

console.log('Offscreen document loaded - ready for parameter discovery');
