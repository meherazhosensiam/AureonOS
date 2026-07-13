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

const ForbiddenActions = new Set([
    WebKit?.ContextMenuAction?.OPEN_LINK_IN_NEW_WINDOW,
    WebKit?.ContextMenuAction?.DOWNLOAD_LINK_TO_DISK,
    WebKit?.ContextMenuAction?.OPEN_IMAGE_IN_NEW_WINDOW,
    WebKit?.ContextMenuAction?.DOWNLOAD_IMAGE_TO_DISK,
    WebKit?.ContextMenuAction?.OPEN_FRAME_IN_NEW_WINDOW,
    WebKit?.ContextMenuAction?.GO_BACK,
    WebKit?.ContextMenuAction?.GO_FORWARD,
    WebKit?.ContextMenuAction?.STOP,
    WebKit?.ContextMenuAction?.RELOAD,
    WebKit?.ContextMenuAction?.OPEN_VIDEO_IN_NEW_WINDOW,
    WebKit?.ContextMenuAction?.OPEN_AUDIO_IN_NEW_WINDOW,
    WebKit?.ContextMenuAction?.INSPECT_ELEMENT,
    WebKit?.ContextMenuAction?.TOGGLE_MEDIA_CONTROLS,
    WebKit?.ContextMenuAction?.TOGGLE_MEDIA_LOOP,
    WebKit?.ContextMenuAction?.ENTER_VIDEO_FULLSCREEN,
    WebKit?.ContextMenuAction?.MEDIA_PLAY,
    WebKit?.ContextMenuAction?.MEDIA_PAUSE,
    WebKit?.ContextMenuAction?.MEDIA_MUTE,
    WebKit?.ContextMenuAction?.DOWNLOAD_VIDEO_TO_DISK,
    WebKit?.ContextMenuAction?.DOWNLOAD_AUDIO_TO_DISK,
].filter(action => action !== undefined && action !== null));

const HOST_MESSAGE_WINDOW_MS = 3000;
const HOST_MESSAGE_MAX_BURST = 120;
const HOST_URI_WINDOW_MS = 3000;
const HOST_URI_MAX_BURST = 150;
const CONFIG_UPDATE_WINDOW_MS = 3000;
const CONFIG_UPDATE_MAX_BURST = 12;

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
        this._hostMessageGuard = new Map();
        this._hostUriGuard = new Map();
        this._configUpdateGuard = new Map();

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
        this._instanceRoots.clear();
        this._hostMessageGuard.clear();
        this._hostUriGuard.clear();
        this._configUpdateGuard.clear();
    }

    forgetInstance(instanceId) {
        if (!instanceId)
            return;

        this._instanceRoots.delete(instanceId);
        this._configUpdateGuard.delete(instanceId);
        this._deleteGuardEntriesForInstance(this._hostMessageGuard, instanceId);
        this._deleteGuardEntriesForInstance(this._hostUriGuard, instanceId);
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
        if (typeof settings.set_hardware_acceleration_policy === 'function' &&
            WebKit?.HardwareAccelerationPolicy?.ALWAYS !== undefined) {
            settings.set_hardware_acceleration_policy(
                WebKit.HardwareAccelerationPolicy.ALWAYS
            );
        }

        webView.set_background_color(new Gdk.RGBA({
            red: 0,
            green: 0,
            blue: 0,
            alpha: 0,
        }));
        webView.set_name('ding-widget-webview');
        webView.set_hexpand(true);
        webView.set_vexpand(true);

        webView.connect('decide-policy', (_view, decision, decisionType) => {
            const downloadType = WebKit.PolicyDecisionType.DOWNLOAD_ACTION;
            const navType = WebKit.PolicyDecisionType.NAVIGATION_ACTION;
            const newWindowType = WebKit.PolicyDecisionType.NEW_WINDOW_ACTION;
            if (decisionType === downloadType) {
                decision.ignore();
                return true;
            }

            if (decisionType !== navType && decisionType !== newWindowType)
                return false;

            const navigationAction = decision?.get_navigation_action?.() ?? null;
            const requestUri =
                navigationAction?.get_request?.()?.get_uri?.() ??
                decision?.get_request?.()?.get_uri?.() ??
                '';

            if (!requestUri)
                return false;

            let parsedUri;
            try {
                parsedUri = GLib.Uri.parse(requestUri, GLib.UriFlags.NONE);
            } catch {
                return false;
            }

            const scheme = parsedUri?.get_scheme?.()?.toLowerCase?.() ?? '';
            if (scheme === 'ding-widget')
                return false;

            if (scheme !== 'http' && scheme !== 'https')
                return false;

            decision.ignore();

            const inst = this._widgetManager?.getInstance?.(instanceId);
            if (inst)
                void this._openExternalLinkForWidget(inst, {url: requestUri});

            return true;
        });

        webView.connect(
            'context-menu',
            (_view, contextMenu, _event, _hitTestResult) => {
                this._filterWidgetContextMenu(contextMenu, ForbiddenActions);

                return false;
            }
        );

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

        const parentWindow =
            this._widgetManager.getSurfaceWindow(inst.monitorIndex);

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
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._widgetManager.restoreWidgetLayerFocus(inst.monitorIndex);
                return GLib.SOURCE_REMOVE;
            });
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

        try {
            const securityManager = this._webContext.get_security_manager();
            securityManager.register_uri_scheme_as_secure('ding-widget');
            securityManager.register_uri_scheme_as_local('ding-widget');
            securityManager.register_uri_scheme_as_cors_enabled(
                'ding-widget'
            );
        } catch (e) {
            console.warn(
                'WebWidgetContext: failed to configure ding-widget scheme security:',
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

        if (!this._allowHostTraffic(
            this._hostMessageGuard,
            instanceId,
            type || 'unknown',
            HOST_MESSAGE_WINDOW_MS,
            HOST_MESSAGE_MAX_BURST,
            'widget message burst'
        ))
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
            if (config && typeof config === 'object') {
                if (!this._allowConfigUpdate(instanceId))
                    break;

                const changed = manager.updateInstanceConfig(instanceId, config);
                if (!changed)
                    break;
            } else {
                break;
            }

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

        case 'setPinned': {
            manager.setInstancePinned(instanceId, !!payload?.pinned);
            break;
        }

        case 'beginPinnedEdit': {
            manager.beginPinnedEdit(instanceId, !!payload?.editing);
            break;
        }

        case 'beginPinnedWindowMove': {
            manager.beginPinnedWindowMove(instanceId, {
                localX: Number(payload?.x),
                localY: Number(payload?.y),
                button: Number(payload?.button),
                timestamp: Number(payload?.timestamp),
            });
            break;
        }

        case 'setDraggableRegions': {
            if (!inst.host || typeof inst.host.setDraggableRegions !== 'function')
                break;

            inst.host.setDraggableRegions(
                Array.isArray(payload?.regions) ? payload.regions : []
            );
            break;
        }

        case 'createWidget': {
            const widgetId = typeof payload?.widgetId === 'string'
                ? payload.widgetId.trim()
                : '';
            if (!widgetId || widgetId !== inst.widgetId)
                break;

            const monitorIndex = Number.isInteger(inst.monitorIndex)
                ? inst.monitorIndex
                : 0;
            const sourceFrame = manager.getInstanceFrame?.(instanceId);
            const spawnOffsetPx = 24;
            const inheritPinned =
                typeof payload?.inheritPinned === 'boolean'
                    ? payload.inheritPinned
                    : true;
            let initialPinned;
            if (typeof payload?.initialPinned === 'boolean')
                initialPinned = payload.initialPinned;
            else if (inheritPinned)
                initialPinned = !!inst.pinned;
            else
                initialPinned = false;


            await manager.createInstanceForWidget(widgetId, {
                monitorIndex,
                x: sourceFrame ? sourceFrame.x + spawnOffsetPx : undefined,
                y: sourceFrame ? sourceFrame.y + spawnOffsetPx : undefined,
                initialPinned,
                inheritConsentFromInstanceId: instanceId,
                selectAfterCreate: true,
            });
            break;
        }

        case 'removeWidget': {
            // Widgets may remove only themselves.
            if (manager.getSelectedInstanceId?.() === instanceId)
                manager.deleteSelectedInstance?.();
            else
                manager.removeInstance?.(instanceId);

            break;
        }

        case 'openExternalLink': {
            await this._openExternalLinkForWidget(inst, payload);
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

    async _openExternalLinkForWidget(inst, payload) {
        const rawUrl = typeof payload?.url === 'string' ? payload.url.trim() : '';
        if (!rawUrl)
            return;

        let parsedUri;
        try {
            parsedUri = GLib.Uri.parse(rawUrl, GLib.UriFlags.NONE);
        } catch (error) {
            console.warn('Widget openExternalLink rejected invalid URL:', rawUrl, error);
            return;
        }

        const scheme = parsedUri?.get_scheme?.()?.toLowerCase?.() ?? '';
        if (scheme !== 'http' && scheme !== 'https') {
            console.warn('Widget openExternalLink rejected scheme:', scheme || '<none>');
            return;
        }

        const escapedUrl = GLib.markup_escape_text(rawUrl, -1);
        const parentWindow =
            this._widgetManager.getSurfaceWindow(inst.monitorIndex);
        const allowed = await this._widgetManager._asyncAskYesNo(
            _('Open link in browser?'),
            `${_('The widget wants to open this link in your browser:\n\n')
            }<tt>${escapedUrl}</tt>`,
            true,
            parentWindow
        );

        if (!allowed)
            return;

        this._mainApp?.activate_action?.('lowerWidgetLayer', null);

        try {
            this._desktopIconsUtil.trySpawn(null, ['xdg-open', rawUrl], null);
        } catch (error) {
            console.error('Failed to open external link:', rawUrl, error);
        }
    }

    _filterWidgetContextMenu(contextMenu, forbiddenActions) {
        if (!contextMenu)
            return;

        const items = contextMenu.get_items();

        if (!items)
            return;

        // Iterate through the items
        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            if (!item)
                continue;

            const submenu = item.get_submenu?.() ?? null;

            if (submenu)
                this._filterWidgetContextMenu(submenu, forbiddenActions);

            const stockAction = item.get_stock_action?.();
            const label = item.get_label?.()?.toLowerCase?.() ?? '';

            // Match by either the ID (StockAction) or by text keywords
            const isForbidden = forbiddenActions.has(stockAction) ||
                label.includes('download') ||
                label.includes('new window') ||
                label.includes('reload');

            if (isForbidden)
                contextMenu.remove(item);
        }
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

    _allowConfigUpdate(instanceId) {
        const now = Date.now();
        const guard = this._configUpdateGuard.get(instanceId) ?? {
            windowStart: now,
            count: 0,
            warned: false,
        };

        if ((now - guard.windowStart) >= CONFIG_UPDATE_WINDOW_MS) {
            guard.windowStart = now;
            guard.count = 0;
            guard.warned = false;
        }

        guard.count++;
        this._configUpdateGuard.set(instanceId, guard);

        if (guard.count <= CONFIG_UPDATE_MAX_BURST)
            return true;

        if (!guard.warned) {
            console.warn(
                'WebWidgetContext: suppressing config update burst for widget instance',
                instanceId,
                `(${guard.count} updates in ${CONFIG_UPDATE_WINDOW_MS}ms)`
            );
            guard.warned = true;
        }

        return false;
    }

    _allowHostTraffic(guardMap, instanceId, kind, windowMs, maxBurst, label) {
        const now = Date.now();
        const key = `${instanceId}:${kind}`;
        const guard = guardMap.get(key) ?? {
            windowStart: now,
            count: 0,
            warned: false,
        };

        if ((now - guard.windowStart) >= windowMs) {
            guard.windowStart = now;
            guard.count = 0;
            guard.warned = false;
        }

        guard.count++;
        guardMap.set(key, guard);

        if (guard.count <= maxBurst)
            return true;

        if (!guard.warned) {
            console.warn(
                `WebWidgetContext: suppressing ${label} for widget instance`,
                instanceId,
                `type=${kind}`,
                `(${guard.count} events in ${windowMs}ms)`
            );
            guard.warned = true;
        }

        return false;
    }

    _deleteGuardEntriesForInstance(guardMap, instanceId) {
        const prefix = `${instanceId}:`;
        for (const key of guardMap.keys()) {
            if (key === instanceId || key.startsWith(prefix))
                guardMap.delete(key);
        }
    }

    _buildUriResponseHeaders(request, extraHeaders = null, localAccess = null) {
        const headers = new Soup.MessageHeaders(
            Soup.MessageHeadersType.RESPONSE
        );

        if (this._cspString)
            headers.append('Content-Security-Policy', this._cspString);

        try {
            const requestHeaders = request?.get_http_headers?.() ?? null;
            const origin = requestHeaders?.get_one?.('Origin')?.trim?.() ?? null;
            const webView = request?.get_web_view?.() ?? null;
            const isBoundLocalRequest =
                !!localAccess?.instanceId &&
                !!webView &&
                webView._dingInstanceId === localAccess.instanceId &&
                !!webView._dingWidgetRoot;

            if (origin?.startsWith?.('ding-widget://')) {
                headers.append('Access-Control-Allow-Origin', origin);
                headers.append('Vary', 'Origin');
            } else if ((origin === 'null' || !origin) && isBoundLocalRequest) {
                // WebKit may serialize custom local-scheme fetches with an
                // opaque/null origin. For our jailed widget bundle scheme, the
                // bound WebView+instance root checks are the actual security
                // boundary, so allow the local response through here.
                headers.append('Access-Control-Allow-Origin', '*');
                if (origin)
                    headers.append('Vary', 'Origin');
            }
        } catch (e) {
            console.warn(
                'WebWidgetContext: failed to inspect request origin for widget response:',
                e
            );
        }

        for (const [name, value] of extraHeaders ?? []) {
            if (name && value)
                headers.append(name, value);
        }

        return headers;
    }

    _finishUriResponse(request, bytes, mimeType, headers = null) {
        const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
        const response = new WebKit.URISchemeResponse({
            stream,
            'stream-length': bytes.get_size(),
        });

        response.set_content_type(mimeType || 'application/octet-stream');
        if (headers)
            response.set_http_headers(headers);
        request.finish_with_response(response);
    }

    _finishUriStatusResponse(request, bytes, mimeType, statusCode, headers = null) {
        const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
        const response = new WebKit.URISchemeResponse({
            stream,
            'stream-length': bytes.get_size(),
        });

        response.set_content_type(mimeType || 'application/octet-stream');
        response.set_status(statusCode, null);
        if (headers)
            response.set_http_headers(headers);
        request.finish_with_response(response);
    }

    // For rate-limited widget resource requests, return a tiny successful
    // response instead of an explicit error so a bad widget is less likely to
    // escalate into a retry/error storm that overwhelms the host.
    _finishQuietUriRequest(request, uri = '') {
        let resourcePath = uri;
        try {
            const parsed = GLib.Uri.parse(uri, GLib.UriFlags.NONE);
            resourcePath = parsed?.get_path?.() ?? uri;
        } catch (_e) {}

        let mimeType = 'application/octet-stream';
        let body = '';

        if (resourcePath.endsWith('.svg')) {
            mimeType = 'image/svg+xml';
            body = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
        } else if (resourcePath.endsWith('.css')) {
            mimeType = 'text/css';
        } else if (resourcePath.endsWith('.js')) {
            mimeType = 'application/javascript';
        } else if (resourcePath.endsWith('.html') ||
                   resourcePath.endsWith('.htm')) {
            mimeType = 'text/html';
        }

        const bytes = new GLib.Bytes(new TextEncoder().encode(body));
        const headers = this._buildUriResponseHeaders(request);
        this._finishUriResponse(request, bytes, mimeType, headers);
    }

    // For missing bundled widget assets, return an HTTP-style 404 response
    // instead of a scheme error so WebKit can treat the failure like a normal
    // missing resource rather than surfacing it as a generic access-control
    // problem for custom-scheme fetches.
    _finishMissingUriRequest(request, uri = '') {
        let resourcePath = uri || request?.get_uri?.() || '';
        try {
            const parsed = GLib.Uri.parse(resourcePath, GLib.UriFlags.NONE);
            resourcePath = parsed?.get_path?.() ?? resourcePath;
        } catch (_e) {}

        let mimeType = 'text/plain';
        let body = 'Not Found';

        if (resourcePath.endsWith('.svg')) {
            mimeType = 'image/svg+xml';
            body = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
        } else if (resourcePath.endsWith('.css')) {
            mimeType = 'text/css';
            body = '';
        } else if (resourcePath.endsWith('.js')) {
            mimeType = 'application/javascript';
            body = '';
        } else if (resourcePath.endsWith('.html') ||
                   resourcePath.endsWith('.htm')) {
            mimeType = 'text/html';
            body = '';
        }

        const bytes = new GLib.Bytes(new TextEncoder().encode(body));
        const headers = this._buildUriResponseHeaders(request);
        console.warn(
            'WebWidgetContext: served missing widget resource as 404',
            resourcePath
        );
        this._finishUriStatusResponse(request, bytes, mimeType, 404, headers);
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

    updateHtmlWidgetPinned(inst, pinned) {
        const patch = {pinned: !!pinned};
        this._debugHostState('pinned', inst, patch);
        this._pushPatchtoTarget(inst, patch);
    }

    updateHtmlWidgetHostChromeVisible(inst, hostChromeVisible) {
        const patch = {hostChromeVisible: !!hostChromeVisible};
        this._debugHostState('hostChromeVisible', inst, patch);
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

    updateHtmlWidgetEditMode(inst, widgetEditMode) {
        const patch = {widgetEditMode: !!widgetEditMode};
        this._debugHostState('widgetEditMode', inst, patch);
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

        if (!this._allowHostTraffic(
            this._hostUriGuard,
            instanceId,
            'ding-widget-uri',
            HOST_URI_WINDOW_MS,
            HOST_URI_MAX_BURST,
            'widget resource request burst'
        )) {
            this._finishQuietUriRequest(request, uri);
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
            this._finishMissingUriRequest(request, uri);
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
            this._finishMissingUriRequest(request, uri);
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
            this._finishMissingUriRequest(request, uri);
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
            const headers = this._buildUriResponseHeaders(
                request,
                null,
                {instanceId}
            );
            this._finishUriResponse(request, bytes, mimeType, headers);
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
