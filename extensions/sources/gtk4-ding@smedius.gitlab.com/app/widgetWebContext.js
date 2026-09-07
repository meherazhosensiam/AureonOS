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

import {Gdk, Gio, GLib, Gtk, Soup, WebKit} from '../dependencies/gi.js';
import {_} from '../dependencies/gettext.js';
import {HtmlWidgetHost, WidgetApi} from '../dependencies/localFiles.js';

export {WebWidgetContext};

/**
 * WebWidgetContext
 *
 * Single runtime for all HTML widgets:
 *  - Owns shared WebKit.WebContext and WebKit.UserContentManager.
 *  - Injects WIDGET_API (window.ding) into all frames.
 *  - Receives script messages ("dingWidget") and parses JSON payloads.
 *  - Delegates semantics to WidgetManager (config, host state, prefs).
 *
 * Lifetime:
 *  - Created lazily by WidgetManager when the first HTML widget is created.
 *  - Destroyed explicitly by WidgetManager when the last HTML widget is removed.
 */
const WebWidgetContext = class {
    constructor(desktopManager, widgetManager) {
        this._desktopManager = desktopManager;
        this._widgetManager = widgetManager;

        this._prefs = desktopManager.Prefs;
        this.Enums = desktopManager.Enums;
        this._mainApp = desktopManager.mainApp;
        this._desktopIconsUtil = desktopManager.DesktopIconsUtil;

        this._webContext = null;
        this._userContentManager = null;
        this._networkSession = null;
        this._scriptHandlerId = 0;
        this._cspString = null;

        this._prefsWindow = null;
        this._prefsWebView = null;
        this._prefsInstanceId = null;

        this._instanceRoots = new Map();

        this._setCspString();
    }

    // ---------------------------------------------------------------------
    // Public WebKit runtime access
    // ---------------------------------------------------------------------

    get webContext() {
        this._initWebKitRuntime();
        return this._webContext;
    }

    get userContentManager() {
        this._initWebKitRuntime();
        return this._userContentManager;
    }

    destroy() {
        this.closePreferencesIfAny();

        if (this._userContentManager && this._scriptHandlerId) {
            this._userContentManager.disconnect(this._scriptHandlerId);

            this._scriptHandlerId = 0;
        }

        if (this._userContentManager) {
            this._userContentManager.unregister_script_message_handler(
                'dingWidget',
                null
            );
        }

        this._userContentManager = null;
        this._webContext = null;
    }

    /*
     * Create a WebView for a widget instance and bind its FS root.
     *
     * @param {string} widgetId   - logical widget ID (e.g. 'weather')
     * @param {string} instanceId - UUID-like instance ID
     * @param {Gio.File} rootDir  - widget bundle root directory
     */
    async newViewForInstance(widgetId, instanceId) {
        // Ensure runtime is set up before constructing a view.
        this._initWebKitRuntime();

        const webViewOptions = {
            web_context: this._webContext,
            user_content_manager: this._userContentManager,
            network_session: this._networkSession,
        };

        const webView = new WebKit.WebView(webViewOptions);

        const rootDir = await this._getInstanceRoot(instanceId);

        // Per-view FS jail root (we ignore URL host in scheme handler)
        webView._dingWidgetRoot = rootDir;
        webView._dingWidgetId = widgetId;
        webView._dingInstanceId = instanceId;

        const settings = webView.get_settings();
        settings.set_enable_write_console_messages_to_stdout(true);
        settings.set_enable_webgl(true);

        webView.set_background_color(new Gdk.RGBA({
            red: 0,
            green: 0,
            blue: 0,
            alpha: 0,
        }));
        webView.set_name('ding-widget-webview');
        webView.set_hexpand(true);
        webView.set_vexpand(true);

        return webView;
    }

    // ---------------------------------------------------------------------
    // Preferences window helpers (called from WidgetManager)
    // ---------------------------------------------------------------------

    /**
     * Open or focus the preferences window for a given instance.
     *
     *  - Only one prefs window at a time (shared runtime).
     *  - Only opens if that instance is currently selected.
     *  - If already open for another instance, closes and reopens for this one.
     *
     * WidgetManager should:
     *  - Calls this in response to gear-icon click for the selected widget.
     *  - Calls closePreferencesForInstance() or closePreferencesIfForInstance()
     *    when unselecting/destroying the widget.
     *
     * @param {string} instanceId
     * @param {string} prefsUri
     */
    openPreferencesForInstance(instanceId, prefsUri) {
        if (!instanceId || !prefsUri)
            return;

        // Only for currently selected instance
        const selectedId = this._widgetManager.getSelectedInstanceId();
        if (!selectedId || selectedId !== instanceId)
            return;

        if (this._prefsWindow && this._prefsInstanceId === instanceId) {
            this._prefsWindow.present();
            return;
        }

        this.closePreferencesIfAny();

        const inst = this._widgetManager.getInstance(instanceId);
        if (!inst) {
            console.warn(
                'WebWidgetContext.openPreferencesForInstance: no instance',
                instanceId
            );
            return;
        }

        const defaultWidth = 420;
        const defaultHeight = 520;

        const window = new Gtk.Window({
            title: _('Widget Preferences'),
            default_width: defaultWidth,
            default_height: defaultHeight,
        });
        const closeShortcut = new Gtk.ShortcutController({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        closeShortcut.add_shortcut(new Gtk.Shortcut({
            trigger: Gtk.ShortcutTrigger.parse_string('Escape'),
            action: Gtk.CallbackAction.new(() => {
                window.close();
                return true;
            }),
        }));
        window.add_controller(closeShortcut);

        const parentWindow = this._mainApp.get_active_window();
        if (parentWindow)
            window.set_transient_for(parentWindow);

        const host = new HtmlWidgetHost({
            instanceId,
            widgetId: inst.widgetId,
            frameRect: {x: 0, y: 0, width: defaultWidth, height: defaultHeight},
            widgetRegistry: this._widgetManager._widgetRegistry,
            webContext: this,
            mode: 'prefs',
            prefsUri,
        });

        this._prefsHost = host;
        host.actor.set_name('ding-prefs-frame');

        window.set_child(host.actor);

        window.connect('close-request', () => {
            this._prefsHost?.destroy();
            this._prefsHost = null;
            this._prefsWindow = null;
            this._prefsInstanceId = null;
            return false;
        });

        this._prefsWindow = window;
        this._prefsInstanceId = instanceId;

        window.present();
    }

    closePreferencesForInstance(instanceId) {
        if (!instanceId || instanceId !== this._prefsInstanceId)
            return;

        this.closePreferencesIfAny();
    }

    closePreferencesIfAny() {
        if (!this._prefsWindow)
            return;

        this._prefsHost?.destroy();
        this._prefsHost = null;
        this._prefsWindow.destroy();
        this._prefsWindow = null;
        this._prefsInstanceId = null;
    }

    // ---------------------------------------------------------------------
    // Internal: WebKit runtime setup
    // ---------------------------------------------------------------------

    _initPaths() {
        const appId = this._mainApp.get_application_id();

        const baseData = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            appId,
            'webkit',
        ]);

        const baseCache = GLib.build_filenamev([
            GLib.get_user_cache_dir(),
            appId,
            'webkit',
        ]);

        this._dataBase = this._desktopIconsUtil.ensureDir(baseData);
        this._cacheBase = this._desktopIconsUtil.ensureDir(baseCache);
    }

    _initWebKitRuntime() {
        if (this._webContext && this._userContentManager)
            return;

        this._initPaths();

        // Shared WebKit plumbing: one WebContext, one UserContentManager
        this._webContext = new WebKit.WebContext();
        this._webContext.set_cache_model(WebKit.CacheModel.DOCUMENT_VIEWER);

        try {
            const cacheDir = this._desktopIconsUtil.ensureDir(
                GLib.build_filenamev([this._cacheBase, 'cache'])
            );
            const storageDir = this._desktopIconsUtil.ensureDir(
                GLib.build_filenamev([this._dataBase, 'storage'])
            );

            this._networkSession =
                WebKit.NetworkSession.new(storageDir, cacheDir);
        } catch (e) {
            logError(e, 'WidgetWebKit: WebContext directory setup failed');
        }

        this._userContentManager = new WebKit.UserContentManager();

        const defaultWorld = null; // default JS world

        // Register script message handler for window.ding → "dingWidget"
        try {
            this._userContentManager.register_script_message_handler(
                'dingWidget',
                defaultWorld
            );
        } catch (e) {
            console.error(
                'WebWidgetContext: failed to register dingWidget handler:',
                e
            );
        }

        this._webContext.register_uri_scheme(
            'ding-widget',
            this._onDingWidgetUriRequest.bind(this)
        );

        this._scriptHandlerId = this._userContentManager.connect(
            'script-message-received::dingWidget',
            this._onWidgetScriptMessage.bind(this)
        );

        const whitelist = null;
        const blacklist = null;

        try {
            const userScript = WebKit.UserScript.new(
                WidgetApi.WIDGET_API,
                WebKit.UserContentInjectedFrames.ALL_FRAMES,
                WebKit.UserScriptInjectionTime.START,
                whitelist,
                blacklist
            );

            this._userContentManager.add_script(userScript);
        } catch (e) {
            console.error(
                'WebWidgetContext: failed to install WIDGET_API user script:',
                e
            );
        }
    }

    _setCspString() {
        const profile = this.Enums.DEFAULT_CSP_PROFILE;
        let cspString = '';

        switch (profile) {
        case this.Enums.CspProfile.STRICT:
            cspString = WidgetApi.CSP_STRICT;
            break;
        case this.Enums.CspProfile.DEV:
            cspString = WidgetApi.CSP_DEV;
            break;
        case this.Enums.CspProfile.RELAXED:
            cspString = WidgetApi.RELAXED;
            break;
        default:
            console.warn('Unknown CSP profile, enforcing STRICT');
            cspString = this.Enums.CspProfile.STRICT;
        }

        this._cspString = cspString.replace(/\s+/g, ' ').trim();
    }

    // ---------------------------------------------------------------------
    // Internal: JS API bridge (window.ding)
    // ---------------------------------------------------------------------

    // Debug Helpers

    _debugHostState(op, inst, patch) {
        if (!(this.Enums.WIDGET_MANAGER_DEBUG &
             this.Enums.WidgetManagerDebugFlags.HOST_STATE))
            return;

        const id = inst?.instanceId ?? '<none>';
        console.log('>>> WebWidgetContext[HOST]', op, 'id=', id, 'patch=', patch);
    }

    _debugWidgetMessage(payload, direction = 'in') {
        if (!(this.Enums.WIDGET_MANAGER_DEBUG &
          this.Enums.WidgetManagerDebugFlags.WIDGET_MESSAGES))
            return;

        const id = payload?.instanceId ?? '<none>';
        const type = payload?.type ?? '<none>';
        const mode = payload?.mode ?? '<none>';
        const arrow = direction === 'out' ? '>>>' : '<<<';

        console.log(
            `${arrow} WebWidgetContext[WIDGET]`,
            'type=',
            type,
            'id=',
            id,
            'mode=',
            mode,
            payload
        );
    }

    // Script Handler

    _onWidgetScriptMessage(_manager, jsResult) {
        let jsValue;

        try {
            if (typeof jsResult.get_js_value === 'function')
                jsValue = jsResult.get_js_value();
            else if (typeof jsResult.get_value === 'function')
                jsValue = jsResult.get_value();
            else
                jsValue = jsResult;
        } catch (e) {
            console.error('WebWidgetContext: failed to read widget message:', e);
            return;
        }

        if (jsValue === undefined || jsValue === null)
            return;

        let json = null;

        try {
            if (jsValue.is_string && jsValue.is_string())
                json = jsValue.to_string();
            else if (jsValue.to_json && jsValue.is_object && jsValue.is_object())
                json = jsValue.to_json(0); // stringify objects
            else if (jsValue.to_string)
                json = jsValue.to_string();
        } catch (e) {
            console.error(
                'WebWidgetContext: failed to convert widget message to string:',
                e
            );
            return;
        }

        if (typeof json !== 'string') {
            console.warn(
                'WebWidgetContext: unexpected widget message payload',
                json,
                typeof json,
                'raw jsValue:',
                jsValue,
                'ctor:',
                jsValue?.constructor?.name
            );
            return;
        }

        let payload;
        try {
            payload = JSON.parse(json);
        } catch (e) {
            console.error('WebWidgetContext: invalid widget JSON payload:', e);
            return;
        }

        if (!payload || typeof payload !== 'object')
            return;

        const {
            instanceId,
            type,
            message,
        } = payload;

        this._debugWidgetMessage(payload);

        // Log messages are always allowed through
        if (type === 'log') {
            console.log(
                'HtmlWidget log:',
                '(instanceId=',
                instanceId,
                ')',
                message
            );
            return;
        }

        if (!instanceId || typeof instanceId !== 'string')
            return;

        const manager = this._widgetManager;
        if (!manager)
            return;

        this._dispatchWidgetMessage(manager, payload);
    }

    async _dispatchWidgetMessage(manager, payload) {
        const {
            instanceId,
            type,
            config,
            requestId,
            mode,
        } = payload || {};

        const inst = manager.getInstance(instanceId);

        if (!inst)
            return;

        let webView;

        try {
            webView = await inst.host.getWebViewAsync();
        } catch (e) {
            return;
        }

        const uri = webView?.get_uri?.() ?? '';

        if (!uri.startsWith(`ding-widget://${instanceId}/`))
            return;

        // Delegate semantics to WidgetManager, reusing its existing helpers.
        switch (type) {
        case 'updateConfig':
            if (config && typeof config === 'object')
                manager.updateInstanceConfig(instanceId, config);

            // Broadcast so widget + prefs can update live
            this._pushConfigChangedForInstance(inst, mode);
            break;

        case 'getConfig': {
            this._doWidgetGetConfig(inst, mode, requestId);
            break;
        }

        case 'hostReady': {
            this._pushFullHostStateForInstance(inst);
            this._pushConfigChangedForInstance(inst);
            break;
        }

        case 'openPreferences': {
            if (!inst.hasPreferences || !inst.prefsUri)
                break;

            this.openPreferencesForInstance(instanceId, inst.prefsUri);
            break;
        }

        case 'closePreferences': {
            this.closePreferencesForInstance(instanceId);
            break;
        }

        case 'backendRequest': {
            const hasBackend = typeof inst.host?.backendRequest === 'function';

            if (!hasBackend) {
                this._postNoBackendError(inst, payload);
                break;
            }

            await inst.host.backendRequest(inst, payload);
            break;
        }

        case 'backendSend': {
            const hasBackend = typeof inst.host?.backendSend === 'function';
            if (!hasBackend) {
                this._debugWidgetMessage({
                    instanceId,
                    type: 'backendSendDropped',
                    name: payload?.name,
                }, 'out');
                break;
            }

            inst.host.backendSend(inst, payload);
            break;
        }

        default:
            // Unknown message type; ignore for now
            break;
        }
    }

    // Script Helpers
    _postNoBackendError(inst, payload) {
        // Ensure the JSAPI Promise resolves/rejects; otherwise it hangs.
        const instanceId = inst?.instanceId ?? payload?.instanceId;

        const reply = {
            _dingInternal: true,
            type: 'backendReply',
            instanceId,
            requestId: payload?.requestId,
            ok: false,
            error: {
                code: 'E_NO_BACKEND',
                message: 'This widget has no backend configured',
            },
        };

        this._debugWidgetMessage({
            instanceId,
            type: 'backendReply',
            requestId: payload?.requestId,
            ok: false,
        }, 'out');

        this._routeAndPost(payload?.mode, inst, reply);
    }

    _postToWidget(inst, msg) {
        const host = inst?.host;
        if (!host)
            return;

        host.postMessage(msg);
    }

    _postToPrefs(inst, msg) {
        if (!inst)
            return;

        if (this._prefsHost &&
            this._prefsInstanceId === inst.instanceId
        )
            this._prefsHost.postMessage(msg);
    }

    _postToBoth(inst, msg) {
        this._postToWidget(inst, msg);
        this._postToPrefs(inst, msg);
    }

    _routeAndPost(mode, inst, msg) {
        switch (mode) {
        case 'prefs':
            this._postToPrefs(inst, msg);
            break;
        case 'widget':
            this._postToWidget(inst, msg);
            break;
        default:
            this._postToBoth(inst, msg);
        }
    }

    _doWidgetGetConfig(inst, mode, requestId) {
        const reply = {
            _dingInternal: true,
            requestId,
            config: inst.config || {},
        };

        this._debugWidgetMessage({
            instanceId: inst?.instanceId,
            type: 'getConfigReply',
            requestId,
            mode,
            config: reply.config,
        }, 'out');

        this._routeAndPost(mode, inst, reply);
    }

    _pushConfigChangedForInstance(inst, mode = null) {
        const msg = {
            _dingInternal: true,
            type: 'configChanged',
            instanceId: inst.instanceId,
            config: inst.config || {},
            reason: 'configSaved',
            sourceMode: mode,
        };

        this._debugWidgetMessage({
            instanceId: inst?.instanceId,
            type: 'configChanged',
            mode,
            config: inst.config,
        }, 'out');

        this._postToBoth(inst, msg);
    }

    _pushFullHostStateForInstance(inst) {
        const state = this._widgetManager.computeHostStateForInstance(inst);
        this._debugHostState('full', inst, state);
        this._pushPatchtoTarget(inst, state);
    }

    _pushPatchtoTarget(inst, patch) {
        if (!inst || inst.kind !== 'html' || !inst.host)
            return;

        inst.host.setHostStatePatch(patch);

        if (this._prefsHost && inst.instanceId === this._prefsInstanceId)
            this._prefsHost.setHostStatePatch(patch);
    }

    updateHtmlWidgetSelected(inst, selected) {
        const patch = {selected};
        this._debugHostState('selected', inst, patch);
        this._pushPatchtoTarget(inst, patch);
    }

    updateHtmlWidgetAnimation(inst, reducedMotion) {
        const patch = {reducedMotion};
        this._debugHostState('reducedMotion', inst, patch);
        this._pushPatchtoTarget(inst, patch);
    }

    updateHtmlWidgetLayer(inst, onTop) {
        const patch = {editMode: !!onTop};
        this._debugHostState('editMode', inst, patch);
        this._pushPatchtoTarget(inst, patch);
    }

    updateHtmlWidgetTheme(inst, theme) {
        const patch = {theme};
        this._debugHostState('theme', inst, patch);
        this._pushPatchtoTarget(inst, patch);
    }

    /* -----------------------------------------------------------------
    * Instance roots and FS isolation
    * -----------------------------------------------------------------*/

    async _getInstanceRoot(instanceId) {
        if (this._instanceRoots.has(instanceId))
            return this._instanceRoots.get(instanceId);

        const inst = this._widgetManager.getInstance(instanceId);
        const widgetId = inst.widgetId;
        const registry = this._widgetManager._widgetRegistry;
        const desc = await registry.getDescriptor(widgetId)
            .catch(e => console.error(`No description for ${widgetId}`, e));
        const dir = desc?.dir;

        if (!dir) {
            console.warn(
                'WebWidgetContext: no descriptor.dir for instance',
                instanceId
            );
            return null;
        }

        this._instanceRoots.set(instanceId, dir);
        return dir;
    }

    /*
     * URI scheme handler for ding-widget://instanceId/path
    */
    _onDingWidgetUriRequest(request) {
        this._onDingWidgetUriRequestAsync(request).catch(e => {
            console.error(
                'WebWidgetContext: unhandled error in ding-widget handler:',
                e
            );
        });
    }

    async _onDingWidgetUriRequestAsync(request) {
        const sep = GLib.DIR_SEPARATOR_S;

        const finishError = (code, message) => {
            request.finish_error(new GLib.Error(
                Gio.IOErrorEnum,
                code,
                message
            ));
        };

        let uri;
        try {
            uri = request.get_uri?.() ?? null;
        } catch (e) {
            console.error('WebWidgetContext: URI request without URI:', e);
            finishError(Gio.IOErrorEnum.INVALID_ARGUMENT, 'Missing URI');
            return;
        }

        if (!uri) {
            console.error('WebWidgetContext: URI request had no URI');
            finishError(Gio.IOErrorEnum.INVALID_ARGUMENT, 'Missing URI');
            return;
        }

        let guri;
        try {
            guri = GLib.Uri.parse(uri, GLib.UriFlags.NONE);
        } catch (e) {
            console.error('WebWidgetContext: failed to parse URI:', uri, e);
            finishError(Gio.IOErrorEnum.INVALID_ARGUMENT, 'Invalid URI');
            return;
        }

        // Basic parse: ding-widget://<instanceId>/<relPath>
        const scheme = 'ding-widget';

        if (guri.get_scheme() !== scheme) {
            console.error('WebWidgetContext: unexpected scheme URI:', uri);
            finishError(
                Gio.IOErrorEnum.INVALID_ARGUMENT,
                'Unexpected URI scheme'
            );
            return;
        }

        const instanceId = guri.get_host();

        if (!instanceId) {
            console.error('WebWidgetContext: missing instanceId in URI', uri);
            finishError(
                Gio.IOErrorEnum.INVALID_ARGUMENT,
                'Missing instanceId in widget URI'
            );
            return;
        }

        const webView = request.get_web_view();

        if (!webView._dingWidgetRoot || webView._dingInstanceId !== instanceId) {
            finishError(
                Gio.IOErrorEnum.PERMISSION_DENIED,
                'Widget root not bound to this view'
            );
            return;
        }

        const rootDir = await this._getInstanceRoot(instanceId);

        if (!rootDir) {
            console.error(
                'WebWidgetContext: no root dir registered for instance',
                instanceId,
                'URI =',
                uri
            );
            finishError(
                Gio.IOErrorEnum.NOT_FOUND,
                'Widget root not registered for this instance'
            );
            return;
        }

        // Extra guard: ensure the bound root on the WebView matches registry
        try {
            const boundRootPath = webView._dingWidgetRoot?.get_path?.();
            const registryRootPath = rootDir.get_path?.();

            if (!boundRootPath || !registryRootPath ||
            boundRootPath !== registryRootPath) {
                finishError(
                    Gio.IOErrorEnum.PERMISSION_DENIED,
                    'Widget root mismatch for this view'
                );
                return;
            }
        } catch (e) {
            finishError(
                Gio.IOErrorEnum.FAILED,
                'Failed to verify widget root'
            );
            return;
        }

        // Normalize relPath:
        //  - treat URI path as widget-root-relative (strip leading "/")
        //  - strip leading "./" segments (so "./clock.css" works)
        const path = guri.get_path?.() ?? '';
        const effectiveRelPath =
            path
            .replace(/^\/+/, '')
            .replace(/^(\.\/)+/, '');

        if (!effectiveRelPath) {
            finishError(Gio.IOErrorEnum.NOT_FOUND, 'No file specified');
            return;
        }

        // Lexical confinement: canonicalize +
        // prefix check to block "../" traversal.
        const rootPath = rootDir.get_path();
        if (!rootPath) {
            console.error('WebWidgetContext: cannot enforce confinement (no root path)');
            finishError(Gio.IOErrorEnum.FAILED, 'Cannot enforce confinement');
            return;
        }

        try {
            const candidatePath = GLib.build_filenamev([
                rootPath,
                effectiveRelPath,
            ]);

            const canonRoot = GLib.canonicalize_filename(rootPath, null);
            const canonFile = GLib.canonicalize_filename(candidatePath, null);

            const normalizedRoot = canonRoot.endsWith(sep)
                ? canonRoot
                : `${canonRoot}${sep}`;

            if (!canonFile.startsWith(normalizedRoot)) {
                console.error(
                    'WebWidgetContext: attempted escape from root:',
                    canonFile,
                    'not under',
                    normalizedRoot
                );
                finishError(
                    Gio.IOErrorEnum.PERMISSION_DENIED,
                    'Path escapes widget root'
                );
                return;
            }
        } catch (e) {
            console.error(
                'WebWidgetContext: exception during confinement check:', e
            );
            finishError(Gio.IOErrorEnum.FAILED, 'Confinement check failed');
            return;
        }

        // Symlink confinement: reject symlinks anywhere
        // in the path (NOFOLLOW_SYMLINKS).
        let file = rootDir;
        try {
            const parts = effectiveRelPath.split('/').filter(p => p.length > 0);

            for (const part of parts) {
                file = file.get_child(part);

                const info = file.query_info(
                    'standard::type,standard::is-symlink',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    null
                );

                if (info.get_is_symlink()) {
                    finishError(Gio.IOErrorEnum.PERMISSION_DENIED,
                        'Symlinks are not allowed in widget paths'
                    );
                    return;
                }
            }
        } catch (e) {
            finishError(
                Gio.IOErrorEnum.NOT_FOUND,
                'File not found in widget root'
            );
            return;
        }

        let bytes;
        try {
            const [loadedBytes] = await file.load_bytes_async(null);
            bytes = loadedBytes;
        } catch (e) {
            console.error(
                'WebWidgetContext: exception loading file (async)',
                file.get_path?.(),
                e
            );
            finishError(
                Gio.IOErrorEnum.NOT_FOUND, 'File not found in widget root');
            return;
        }

        // Guess MIME type using filename + data,
        // but then *force* sane types for HTML/CSS/JS.
        let mimeType = null;
        let filePathForMime = '';

        try {
            filePathForMime = file.get_path?.() ?? '';
            const [mimetype] = Gio.content_type_guess(
                filePathForMime,
                bytes.toArray ? bytes.toArray() : null
            );
            if (mimetype)
                mimeType = mimetype;
        } catch (e) {
            console.error('WebWidgetContext: content_type_guess failed', e);
        }

        // Force explicit types by extension – important for the main HTML.
        if (filePathForMime.endsWith('.html') ||
        filePathForMime.endsWith('.htm'))
            mimeType = 'text/html';
        else if (filePathForMime.endsWith('.css'))
            mimeType = 'text/css';
        else if (filePathForMime.endsWith('.js'))
            mimeType = 'application/javascript';

        if (!mimeType)
            mimeType = 'application/octet-stream';

        try {
            const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
            const length = bytes.get_size?.() ?? bytes.length ?? -1;

            const response = new WebKit.URISchemeResponse({
                stream,
                'stream-length': length,
            });

            response.set_content_type(mimeType);

            // To Do: set cspstring depending on widgetID with a manager...
            if (this._cspString) {
                const headers = new Soup.MessageHeaders(
                    Soup.MessageHeadersType.RESPONSE
                );
                headers.append('Content-Security-Policy', this._cspString);
                response.set_http_headers(headers);
            }

            request.finish_with_response(response);
        } catch (e) {
            console.error(
                'WebWidgetContext: failed to finish ding-widget request for',
                uri,
                e
            );
            finishError(
                Gio.IOErrorEnum.FAILED,
                'Failed to serve widget resource'
            );
        }
    }
};
