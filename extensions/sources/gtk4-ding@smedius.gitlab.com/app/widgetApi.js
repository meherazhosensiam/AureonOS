/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Gtk4 Port Copyright (C) 2022 - 2025 Sundeep Mediratta (smedius@gmail.com)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */


// widget-js-api.js
// Exports the script that gets injected into each WebView.

const transparencyCSS = `
/* Keep the page transparent without nuking widget element backgrounds */
html, body {
    background: transparent !important;
    background-color: transparent !important;
    background-image: none !important;
}
`;

export const CSP_STRICT = `
default-src 'none';
base-uri 'none';
object-src 'none';
frame-ancestors 'none';
form-action 'none';

script-src 'self' 'unsafe-inline';
style-src  'self' 'unsafe-inline';

img-src    'self' data: blob:;
font-src   'self' data:;
media-src  'self' blob:;

connect-src 'self' https: ;
navigate-to 'self';
block-all-mixed-content;

worker-src 'none';
frame-src  'none';
`;

export const CSP_DEV = `
default-src 'none';
base-uri 'none';
object-src 'none';
frame-ancestors 'none';
form-action 'none';

script-src 'self' 'unsafe-inline';
style-src  'self' 'unsafe-inline';

img-src    'self' data: blob:;
font-src   'self' data:;
media-src  'self' blob:;

connect-src
    'self'
    https:
    http:
    http://localhost:*
    ws://localhost:*;

worker-src 'none';
frame-src  'none';
`;

export const CSP_RELAXED = `
default-src 'none';
base-uri 'self';
object-src 'none';
frame-ancestors 'none';

script-src
    'self'
    'unsafe-inline'
    https:;

style-src
    'self'
    'unsafe-inline'
    https:;

img-src    'self' data: blob: https:;
font-src   'self' data: https:;
media-src  'self' blob: https:;

connect-src
    'self'
    https:
    http:
    ws:
    wss:;

worker-src blob:;
frame-src  https:;
`;

export const WIDGET_UNAVAILABLE_HTML = `
<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;display:flex;align-items:center;justify-content:center;font:14px system-ui;background:rgba(0,0,0,0.05);color:#555;">
<div>
<div style="font-weight:600;">Widget unavailable</div>
<div style="font-size:12px;opacity:0.8;">__REASON__</div>
</div>
</body>
</html>`;

export const WIDGET_API =
`(function() {
    'use strict';

    // Avoid re-injecting if the page has already been initialized
    if (window.ding)
        return;

    try {
        const style = document.createElement('style');
        style.id = 'ding-widget-background';
        style.textContent = \`${transparencyCSS}\`;
        document.documentElement.insertAdjacentElement('afterbegin', style);
    } catch (e) {
        // Failing to inject style is non-fatal.
        console.error('ding: failed to inject default style', e);
    }

    // ---------------------------------------------------------------------
    // Upward channel: widget -> host (via WebKit messageHandler)
    // ---------------------------------------------------------------------

    function post(message) {
        try {
            if (!window.webkit ||
                !window.webkit.messageHandlers ||
                !window.webkit.messageHandlers.dingWidget)
                return;

            window.webkit.messageHandlers.dingWidget.postMessage(
                JSON.stringify(message)
            );
        } catch (e) {
            try {
                console.error('ding: post failed', e);
            } catch (_ignored) {
                // ignore logging failures
            }
        }
    }

    // ---------------------------------------------------------------------
    // Small helper: query parameter parsing
    // ---------------------------------------------------------------------

    function getQueryParam(qs, key) {
        if (!qs || qs.length <= 1)
            return null;

        if (qs.charAt(0) === '?')
            qs = qs.substring(1);

        var parts = qs.split('&');
        for (var i = 0; i < parts.length; i++) {
            var kv = parts[i].split('=');
            if (kv.length === 2 && kv[0] === key) {
                try {
                    return decodeURIComponent(kv[1]);
                } catch (e) {
                    return kv[1];
                }
            }
        }

        return null;
    }

    // ---------------------------------------------------------------------
    // Config cache + configChanged (downward push)
    // ---------------------------------------------------------------------

    var _configCache = {};
    var _configListeners = new Set();

    function _cloneObject(obj) {
        if (!obj || typeof obj !== 'object')
            return {};
        var out = {};
        for (var k in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, k))
                out[k] = obj[k];
        }
        return out;
    }

    function _notifyConfigListeners(meta) {
        var snapshot = _cloneObject(_configCache);

        _configListeners.forEach(function(cb) {
            try {
                cb(snapshot, meta || null);
            } catch (e) {
                try {
                    console.error('ding: configChanged listener failed', e);
                } catch (_ignored) {}
            }
        });
    }

    function _setConfigCache(nextConfig, meta) {
        if (!nextConfig || typeof nextConfig !== 'object')
            nextConfig = {};

        _configCache = _cloneObject(nextConfig);
        _notifyConfigListeners(meta);
    }

    function getConfigCached() {
        return _cloneObject(_configCache);
    }

    // ---------------------------------------------------------------------
    // getConfig request/response plumbing
    // ---------------------------------------------------------------------

    var pending = new Map();
    var msgCounter = 1;
    var _backendPending = new Map();
    var _backendListeners = new Set();

    // Host responds to getConfig by running:
    //   window.postMessage({ _dingInternal: true, requestId, config }, '*');
    window.addEventListener('message', function(event) {
        var data = event.data;
        if (!data || data._dingInternal !== true)
            return;

        var type = data.type || null;

        // --- Backend first ---
        if (type === 'backendEvent') {
            _backendListeners.forEach(function(cb) {
                try {
                    cb(data.name, data.payload);
                } catch (_e) {}
            });
            return;
        }

        if (type === 'backendReply') {
            var requestId = data.requestId;
            if (requestId === undefined || requestId === null)
                return;

            var pendingReq = _backendPending.get(requestId);
            if (!pendingReq)
                return;

            _backendPending.delete(requestId);

            if (data.ok)
                pendingReq.resolve(data.result);
            else
                pendingReq.reject(data.error || {
                    code: 'E_BACKEND',
                    message: 'Backend request failed',
                });

            return;
        }

        // --- Config plumbing (only for config message types) ---
        var requestId = data.requestId || null;
        var config = data.config;

        if (config && typeof config === 'object') {
            _setConfigCache(config, {
                reason: type === 'configChanged'
                ? (data.reason || 'configChanged')
                : 'getConfigReply',
                sourceMode: data.sourceMode || null,
            });
        }

        if (type === 'configChanged')
            return;

        if (!requestId)
            return;

        var resolver = pending.get(requestId);
        if (!resolver)
            return;

        pending.delete(requestId);

        try {
            resolver(config || {});
        } catch (e) {
            try {
                console.error('ding: getConfig resolver failed', e);
            } catch (_ignored) {}
        }
    });

    // ---------------------------------------------------------------------
    // Host state (downward channel)
    // ---------------------------------------------------------------------

    var _hostState = {
        editMode: false,
        selected: false,
        theme: 'light',
        reducedMotion: false,
        direction: 'ltr',
        locale: (typeof navigator !== 'undefined' && navigator.language) ?
            navigator.language :
            'en_US',
    };

    var _hostStateListeners = new Set();

    // ---------------------------------------------------------------------
    // Page-side debug flag:
    // Host can flip this with:
    //   webView.evaluate_javascript("window.DING_DEBUG_HOST_STATE = true;", ...)
    // ---------------------------------------------------------------------
    window.DING_DEBUG_HOST_STATE = false;

    function _debugHostState(msg, data) {
        if (!window.DING_DEBUG_HOST_STATE)
            return;

        try {
            console.log('ding[host-state]', msg, data);
        } catch (_e) {
            // ignore
        }
    }

    function _applyHostStateToDom() {
        try {
            var docEl = document.documentElement;
            var body = document.body;

            if (!docEl || !body)
                return;

            // Direction
            docEl.dir = _hostState.direction || 'ltr';

            // Theme
            body.dataset.theme = _hostState.theme || 'light';

            // Edit mode & selection
            body.classList.toggle('ding-edit-mode', !!_hostState.editMode);
            body.classList.toggle('ding-selected', !!_hostState.selected);

            // Reduced motion:
            body.classList.toggle('ding-reduced-motion', !!_hostState.reducedMotion);
        } catch (_e) {
            // Don't let DOM sync failures break host-state updates
        }
    }

    function _cloneHostState() {
        var out = {};
        for (var k in _hostState) {
            if (Object.prototype.hasOwnProperty.call(_hostState, k))
                out[k] = _hostState[k];
        }
        return out;
    }

    function _notifyHostStateListeners() {
        var snapshot = _cloneHostState();
        _debugHostState('notify', snapshot);

        _applyHostStateToDom()

        _hostStateListeners.forEach(function(cb) {
            try {
                cb(snapshot);
            } catch (e) {
                try {
                    console.error('ding: hostState listener failed', e);
                } catch (_ignored) {}
            }
        });
    }

    function _setHostState(patch) {
        if (!patch || typeof patch !== 'object')
            return;

        _debugHostState('patch', patch);

        var changed = false;
        for (var key in patch) {
            if (!Object.prototype.hasOwnProperty.call(patch, key))
                continue;

            var value = patch[key];
            if (_hostState[key] !== value) {
                _hostState[key] = value;
                changed = true;
            }
        }

        if (changed)
            _notifyHostStateListeners();
    }

    // ---------------------------------------------------------------------
    // Instance ID derivation from URL query parameters
    // ---------------------------------------------------------------------

    var initialInstanceId = null;
    var initialMode = 'widget'; // default

    try {
        var search = (window.location && window.location.search) || '';

        var qmode = getQueryParam(search, 'dingMode');
        if (qmode === 'prefs' || qmode === 'widget')
            initialMode = qmode;

        var qid =
            getQueryParam(search, 'dingInstanceId') ||
            getQueryParam(search, 'widgetInstanceId') ||
            getQueryParam(search, 'instanceId');
        if (qid)
            initialInstanceId = qid;
    } catch (e) {
        // ignore
    }

    // ---------------------------------------------------------------------
    // Public API: window.ding
    // ---------------------------------------------------------------------

    window.ding = {
        apiVersion: 1,
        instanceId: initialInstanceId,
        mode: initialMode,

        // Expose raw post() if widgets want it
        post: post,

        getInstanceId: function() {
            return this.instanceId;
        },

        // -----------------------------
        // Widget -> host helpers
        // -----------------------------

        log: function(message) {
            post({
                type: 'log',
                instanceId: this.instanceId,
                message: String(message),
            });
        },

        saveConfig: function(config) {
            if (!this.instanceId)
                return;

            post({
                type: 'updateConfig',
                instanceId: this.instanceId,
                config: config || {},
            });
        },

        getConfig: function() {
            if (!this.instanceId)
                return Promise.resolve(null);

            var requestId = msgCounter++;
            return new Promise(function(resolve) {
                pending.set(requestId, resolve);
                post({
                    type: 'getConfig',
                    instanceId: window.ding.instanceId,
                    requestId: requestId,
                });
            });
        },

        // Can return {} if the cache is not initialized yet
        getConfigSync: function() {
            return getConfigCached();
        },

        // -----------------------------
        // Host -> widget helpers
        // -----------------------------

        /**
         * Returns a shallow copy of the current host state:
         * {
         *   editMode, selected, theme, visible,
         *   reducedMotion, direction, locale
         * }
         */
        getHostState: function() {
            return _cloneHostState();
        },

        /**
         * Subscribe to host state changes.
         * Returns an unsubscribe() function.
         */
        onHostStateChanged: function(cb) {
            if (typeof cb !== 'function')
                return function() {};

            _hostStateListeners.add(cb);

            // Immediately deliver current snapshot
            try {
                cb(_cloneHostState());
            } catch (e) {
                try {
                    console.error('ding: hostState listener failed (initial)', e);
                } catch (_ignored) {}
            }

            return function() {
                _hostStateListeners.delete(cb);
            };
        },

        onConfigChanged: function(cb) {
            if (typeof cb !== 'function')
                return function() {};

            _configListeners.add(cb);

            try {
                cb(
                    _cloneObject(_configCache),
                    { reason: 'initial', sourceMode: null }
                 );
            } catch (_e) {}

            // Return unsubscribe
            return function() {
                _configListeners.delete(cb);
            };
        },

        backendRequest: function(method, params) {
            if (!this.instanceId)
                return Promise.reject(new Error('No instanceId'));

            var requestId = msgCounter++;

            return new Promise(function(resolve, reject) {
                _backendPending.set(requestId, { resolve, reject });
                post({
                    type: 'backendRequest',
                    instanceId: window.ding.instanceId,
                    requestId: requestId,
                    method: method,
                    params: params || {},
                });
            });
        },

        backendSend: function(name, payload) {
            if (!this.instanceId)
                return;

            post({
                type: 'backendSend',
                instanceId: window.ding.instanceId,
                name: name,
                payload: payload || {},
            });
        },

        onBackendEvent: function(cb) {
            if (typeof cb !== 'function')
                return function() {};

            _backendListeners.add(cb);
            return function() {
                _backendListeners.delete(cb);
            };
        },

        // ---------------------------------------------------------------------
        // INTERNAL: host-only entrypoint. The GJS side calls this via
        // evaluate_javascript() to push patches into _hostState.
        // ---------------------------------------------------------------------

        _setHostState: _setHostState,
    };
        
    (function() {
        function doInitialDomSync() {
            try {
                _debugHostState('initial-dom-sync', _cloneHostState());
                _notifyHostStateListeners();
            } catch (_e) {
                // Ignore; we don't want this to break the widget
            }
        }

        if (document.readyState === 'loading') {
            // Body not ready yet; wait for DOMContentLoaded
            document.addEventListener('DOMContentLoaded', function onReady() {
                document.removeEventListener('DOMContentLoaded', onReady);
                doInitialDomSync();
            });
        } else {
            // DOM is already ready (e.g. script injected later)
            doInitialDomSync();
        }
    })();

    // Notify the host that the widget API is ready and has an instanceId
    try {
        post({
            type: 'hostReady',
            instanceId: initialInstanceId || null,
        });
    } catch (_e) {
        // ignore
    }
})();`;
