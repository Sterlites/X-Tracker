/**
 * X Tracker - MAIN-World Passive Network Observer
 * Runs at document_start in the page's MAIN world.
 * Passively observes X's own authenticated GraphQL/REST fetch and XHR responses
 * on both same-origin (/i/api/...) and api.x.com / api.twitter.com endpoints,
 * and emits sanitized telemetry events for continuous reliability diagnostics.
 */
(function installXTrackerMainObserver() {
  if (window.__xTrackerMainObserverInstalled) {
    return;
  }
  window.__xTrackerMainObserverInstalled = true;

  const MAX_BUFFER = 24;
  const MAX_TELEMETRY_BUFFER = 40;
  const recentPayloads = [];
  const recentTelemetry = [];
  let passiveCaptureScopes = new Set();

  const ALLOWED_ORIGINS = new Set([
    location.origin,
    'https://x.com',
    'https://twitter.com',
    'https://api.x.com',
    'https://api.twitter.com'
  ]);

  const CORE_OP_REGEX =
    /(?:\/i\/api)?\/(?:graphql\/[^/]+\/(Followers|BlueVerifiedFollowers|Following|FollowersYouKnow|UserByScreenName|UserByRestId|UsersByRestIds|Viewer)|1\.1\/(?:followers|friends)\/(?:list|ids)\.json)/i;
  const GQL_OP_REGEX = /(?:\/i\/api)?\/graphql\/[^/]+\/([A-Za-z0-9_]+)/;
  const REST_OP_REGEX = /(?:\/i\/api)?\/1\.1\/([A-Za-z0-9_./-]+?)(?:\.json)?$/i;

  const CAPTURE_OP_MAP = {
    TweetDetail: 'thread',
    SearchTimeline: 'search',
    Bookmarks: 'bookmarks',
    HomeTimeline: 'feed',
    HomeLatestTimeline: 'feed',
    UserTweets: 'profile'
  };

  function resolveOpInfo(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let url;
    try {
      url = new URL(rawUrl, location.origin);
    } catch {
      return null;
    }

    if (!ALLOWED_ORIGINS.has(url.origin)) {
      return null;
    }

    const coreMatch = url.pathname.match(CORE_OP_REGEX);
    if (coreMatch) {
      return {
        matched: true,
        op: coreMatch[1] || 'RestUserList',
        category: 'core',
        host: url.host,
        path: url.pathname,
        url: url.pathname + url.search
      };
    }

    const gqlMatch = url.pathname.match(GQL_OP_REGEX);
    if (gqlMatch) {
      const opName = gqlMatch[1];
      const scope = CAPTURE_OP_MAP[opName];
      if (scope && passiveCaptureScopes.has(scope)) {
        return {
          matched: true,
          op: opName,
          category: scope,
          host: url.host,
          path: url.pathname,
          url: url.pathname + url.search
        };
      }
      return {
        matched: false,
        op: opName,
        category: 'other_gql',
        host: url.host,
        path: url.pathname
      };
    }

    const restMatch = url.pathname.match(REST_OP_REGEX);
    if (restMatch) {
      return {
        matched: false,
        op: `1.1/${restMatch[1]}`,
        category: 'other_rest',
        host: url.host,
        path: url.pathname
      };
    }

    return null;
  }

  function extractRateLimit(headers) {
    if (!headers) return null;
    try {
      const getHeader = (name) =>
        typeof headers.get === 'function' ? headers.get(name) : headers[name];
      const limit = Number(getHeader('x-rate-limit-limit'));
      const remaining = Number(getHeader('x-rate-limit-remaining'));
      const resetSec = Number(getHeader('x-rate-limit-reset'));
      if (!Number.isFinite(limit) && !Number.isFinite(remaining) && !Number.isFinite(resetSec)) {
        return null;
      }
      return {
        limit: Number.isFinite(limit) ? limit : null,
        remaining: Number.isFinite(remaining) ? remaining : null,
        resetAtMs: Number.isFinite(resetSec) ? resetSec * 1000 : null
      };
    } catch {
      return null;
    }
  }

  function parseXhrHeaders(rawHeaderString) {
    const map = {};
    if (!rawHeaderString) return map;
    rawHeaderString.split(/\r?\n/).forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) {
        map[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
    });
    return map;
  }

  function emitTelemetry(entry) {
    try {
      const payload = { ...entry, at: entry.at || Date.now() };
      recentTelemetry.push(payload);
      if (recentTelemetry.length > MAX_TELEMETRY_BUFFER) {
        recentTelemetry.shift();
      }
      document.dispatchEvent(
        new CustomEvent('x-tracker:telemetry', {
          detail: JSON.stringify(payload)
        })
      );
    } catch {
      // Never interfere with host page execution
    }
  }

  function emitEnvelope(envelope) {
    try {
      recentPayloads.push(envelope);
      if (recentPayloads.length > MAX_BUFFER) {
        recentPayloads.shift();
      }
      try {
        document.dispatchEvent(
          new CustomEvent('x-tracker:network', {
            detail: envelope
          })
        );
      } catch {
        document.dispatchEvent(
          new CustomEvent('x-tracker:network', {
            detail: JSON.stringify(envelope)
          })
        );
      }
    } catch {
      // Never interfere with host page execution
    }
  }

  // Listen for config and handshake from ISOLATED world
  document.addEventListener('x-tracker:config', (event) => {
    try {
      const cfg = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
      if (Array.isArray(cfg?.captureScopes)) {
        passiveCaptureScopes = new Set(cfg.captureScopes);
      }
    } catch {
      // Ignore malformed config
    }
  });

  document.addEventListener('x-tracker:handshake', () => {
    for (const envelope of recentPayloads) {
      try {
        try {
          document.dispatchEvent(
            new CustomEvent('x-tracker:network', {
              detail: envelope
            })
          );
        } catch {
          document.dispatchEvent(
            new CustomEvent('x-tracker:network', {
              detail: JSON.stringify(envelope)
            })
          );
        }
      } catch {
        // Ignore
      }
    }
    for (const tel of recentTelemetry) {
      try {
        document.dispatchEvent(
          new CustomEvent('x-tracker:telemetry', {
            detail: JSON.stringify(tel)
          })
        );
      } catch {
        // Ignore
      }
    }
  });

  // Wrap window.fetch passively
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = async function wrappedFetch(input) {
      const rawUrl = typeof input === 'string' ? input : input?.url;
      const opInfo = resolveOpInfo(rawUrl);
      const startedAt = Date.now();

      try {
        const response = await nativeFetch.apply(this, arguments);

        if (opInfo) {
          const durationMs = Date.now() - startedAt;
          const rateLimit = extractRateLimit(response.headers);

          if (!opInfo.matched) {
            emitTelemetry({
              kind: 'gql_unmatched',
              op: opInfo.op,
              category: opInfo.category,
              host: opInfo.host,
              status: response.status,
              durationMs
            });
          } else {
            queueMicrotask(async () => {
              let json = null;
              let parseError = null;
              try {
                if (response.status >= 200 && response.status < 300) {
                  json = await response.clone().json();
                }
              } catch (err) {
                parseError = err?.message || 'json_parse_failed';
              }

              emitTelemetry({
                kind: response.status >= 400 ? 'http_error' : 'gql_matched',
                op: opInfo.op,
                category: opInfo.category,
                host: opInfo.host,
                status: response.status,
                durationMs,
                rateLimitRemaining: rateLimit?.remaining ?? null,
                error: parseError
              });

              emitEnvelope({
                op: opInfo.op,
                category: opInfo.category,
                url: opInfo.url,
                status: response.status,
                rateLimit,
                json,
                at: Date.now()
              });
            });
          }
        }

        return response;
      } catch (err) {
        if (opInfo) {
          emitTelemetry({
            kind: 'http_error',
            op: opInfo.op,
            category: opInfo.category,
            host: opInfo.host,
            status: 0,
            durationMs: Date.now() - startedAt,
            error: err?.message || 'fetch_rejected'
          });
        }
        throw err;
      }
    };
  }

  // Wrap XMLHttpRequest passively
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function wrappedOpen(method, url) {
    this.__xTrackerUrl = typeof url === 'string' ? url : String(url || '');
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function wrappedSend() {
    const opInfo = resolveOpInfo(this.__xTrackerUrl);
    if (opInfo) {
      const startedAt = Date.now();
      this.addEventListener(
        'load',
        function onLoad() {
          const durationMs = Date.now() - startedAt;
          if (!opInfo.matched) {
            emitTelemetry({
              kind: 'gql_unmatched',
              op: opInfo.op,
              category: opInfo.category,
              host: opInfo.host,
              status: this.status,
              durationMs
            });
            return;
          }

          try {
            const rateLimit = extractRateLimit(parseXhrHeaders(this.getAllResponseHeaders()));
            let json = null;
            let parseError = null;
            if (this.status >= 200 && this.status < 300 && this.responseText) {
              try {
                json = JSON.parse(this.responseText);
              } catch (err) {
                parseError = err?.message || 'xhr_json_parse_failed';
              }
            }

            emitTelemetry({
              kind: this.status >= 400 ? 'http_error' : 'gql_matched',
              op: opInfo.op,
              category: opInfo.category,
              host: opInfo.host,
              status: this.status,
              durationMs,
              rateLimitRemaining: rateLimit?.remaining ?? null,
              error: parseError
            });

            emitEnvelope({
              op: opInfo.op,
              category: opInfo.category,
              url: opInfo.url,
              status: this.status,
              rateLimit,
              json,
              at: Date.now()
            });
          } catch {
            // Ignore XHR error cleanly
          }
        },
        { once: true }
      );
    }
    return origSend.apply(this, arguments);
  };
})();
