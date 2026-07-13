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

import {GLib, GObject, Graphene, Gtk, Gsk} from '../dependencies/gi.js';
import {WidgetApi} from '../dependencies/localFiles.js';

export {HtmlWidgetHost};

const HtmlWidgetHost = class {
    /**
     * @param {object} params
     *   {
     *     instanceId: string,
     *     widgetId: string,
     *     frameRect: {x, y, width, height},
     *     mainApp: Adw.Application | null,
     *     widgetRegistry: WidgetRegistry | null,
     *     webContext: WebKit.WebContext,
     *     mode: 'prefs' or 'widget'
     *     prefsUri: string relative uri
     *   }
     */
    constructor(params) {
        this._instanceId = params.instanceId;
        this._widgetId = params.widgetId;
        this._frameRect = params.frameRect;
        this._mainApp = params.mainApp ?? null;
        this._widgetRegistry = params.widgetRegistry;
        this._webContext = params.webContext;
        this._mode = params.mode === 'prefs' ? 'prefs' : 'widget';
        this._prefsUri = params.prefsUri || null;

        this._pendingHostStatePatches = [];
        this._pendingPostMessages = [];
        this._draggableRegions = [];
        this._webView = null;
        this._destroyed = false;
        this._tickId = 0;
        this._mappedNotifyId = 0;
        this._parentNotifyId = 0;
        this._previousParent = null;
        this._keyboardFocusable = this._mode === 'prefs';

        this._makeGtkWidget();

        this._start();
    }

    get actor() {
        return this._frame;
    }

    _webViewReadyPromise() {
        if (!this._webViewPromise) {
            this._webViewPromise = new Promise(resolve => {
                this._webViewResolve = resolve;
            });
        }

        return this._webViewPromise;
    }


    getWebViewAsync() {
        if (this._webView)
            return this._webView;

        return this._webViewReadyPromise();
    }

    updateFrame(frameRect) {
        this._frameRect = frameRect;
        this._frame.set_size_request(
            frameRect.width,
            frameRect.height
        );
    }

    setKeyboardFocusable(focusable) {
        this._keyboardFocusable = !!focusable;
        this._applyKeyboardFocusPolicy();
    }

    isAlive() {
        return !this._destroyed;
    }

    setDraggableRegions(regions) {
        if (this._destroyed)
            return;

        if (!Array.isArray(regions)) {
            this._draggableRegions = [];
            return;
        }

        this._draggableRegions = regions
            .map(region => this._normalizeDraggableRegion(region))
            .filter(region => region !== null);
    }

    clearDraggableRegions() {
        this._draggableRegions = [];
    }

    isDraggable(x, y) {
        const px = Number(x);
        const py = Number(y);
        if (!Number.isFinite(px) || !Number.isFinite(py))
            return false;

        for (const region of this._draggableRegions) {
            if (px < region.x || py < region.y)
                continue;
            if (px >= region.x + region.width)
                continue;
            if (py >= region.y + region.height)
                continue;

            return true;
        }

        return false;
    }

    destroy() {
        this._destroyed = true;
        this.clearDraggableRegions();

        if (this._mappedNotifyId && this._webView)
            this._webView.disconnect(this._mappedNotifyId);
        this._mappedNotifyId = 0;

        if (this._parentNotifyId && this._frame)
            this._frame.disconnect(this._parentNotifyId);
        this._parentNotifyId = 0;

        if (this._tickId)
            this._webView?.remove_tick_callback(this._tickId);
        this._tickId = 0;

        this._frame.set_child(null);
        this._webView.unparent();
        this._webView.run_dispose();
        this._webView = null;
        this._frame = null;
        this._pendingHostStatePatches = [];
    }

    setHostStatePatch(patch) {
        if (!patch || typeof patch !== 'object')
            return;

        if (this._destroyed || !this._webView) {
            this._pendingHostStatePatches.push(patch);
            return;
        }
        this._sendHostStatePatch(patch);
    }

    postMessage(msg) {
        if (!msg || typeof msg !== 'object')
            return;

        if (this._destroyed || !this._webView) {
            this._pendingPostMessages.push(msg);
            return;
        }

        this._postMessage(msg);
    }

    async requestRender() {
        if (this._destroyed)
            return;

        await this.getWebViewAsync();
        this._pokeWebViewRender();
    }

    async reload() {
        if (this._destroyed)
            return;

        this.clearDraggableRegions();

        const webView = await this.getWebViewAsync();
        if (!webView)
            return;

        webView.reload();
    }

    // Reparenting an HTML widget between the desktop container and a floating
    // widget window can leave WebKit visually blank even though the WebView is
    // still mapped, sized, and otherwise healthy. A full reload reliably
    // rebuilds WebKit's render/compositing state for the new parent chain.
    async reloadForReparent() {
        await this.reload();
    }

    _makeGtkWidget() {
        this._frame = new DingRoundedClip({radius: 8});

        this._frame.set_size_request(
            this._frameRect.width,
            this._frameRect.height
        );
        this._applyWidgetKeyboardFocus(this._frame);

        this._frame.instanceId = this._instanceId;
        this._frame.widgetId = this._widgetId;
        this._parentNotifyId = this._frame.connect('notify::parent', () => {
            this._handleParentChange();
        });
    }

    async _makeWebView() {
        this._webView =
            await this._webContext.newViewForInstance(
                this._widgetId,
                this._instanceId
            );
        this._webView.set_overflow(Gtk.Overflow.HIDDEN);
        this._webView.set_name('ding-widget-webview');
        this._applyWidgetKeyboardFocus(this._webView);

        this._frame.set_child(this._webView);
    }

    async _makeUrl() {
        let rel = null;

        if (this._mode === 'prefs') {
            rel = this._prefsUri || null;
        } else {
            const entryFile =
                await this._widgetRegistry.getHtmlEntryFile(this._widgetId);

            rel = entryFile ? entryFile.get_basename() : null;
        }

        if (!rel)
            return null;

        const id = GLib.uri_escape_string(this._instanceId, null, true);
        const path = `/${GLib.uri_escape_string(rel, '/', true)}`;
        const mode = this._mode === 'prefs' ? 'prefs' : 'widget';
        const query =
            `dingMode=${mode}&dingInstanceId=${id}`;

        const guri = GLib.uri_build(
            GLib.UriFlags.NONE,
            'ding-widget',
            null,
            id,
            -1,
            path,
            query,
            null
        );

        return guri.to_string();
    }

    // ─────────────────────────
    // start orchestration
    // ─────────────────────────
    async _start() {
        const [_, url] = await Promise.all([
            this._makeWebView(),
            this._makeUrl(),
        ]).catch(e => logError(e));

        this._webViewResolve?.(this._webView);
        this._webViewPromise = null;
        this._webViewResolve = null;

        if (!this._webView)
            return;

        if (url)
            this._webView.load_uri(url);
        else
            this._loadFallback('Missing entry/prefs URL');

        this._installWebViewRenderPoke();

        this._flushPendingHostStatePatches();
        this._flushPendingMessages();
    }

    _handleParentChange() {
        if (this._destroyed || !this._frame)
            return;

        const currentParent = this._frame.get_parent?.() ?? null;
        const previousParent = this._previousParent;

        this._previousParent = currentParent;

        if (!currentParent || currentParent === previousParent)
            return;

        this.reloadForReparent().catch(e => logError(e));
    }

    _flushPendingHostStatePatches() {
        for (const patch of this._pendingHostStatePatches)
            this._sendHostStatePatch(patch);

        this._pendingHostStatePatches.length = 0;
    }

    _flushPendingMessages() {
        for (const msg of this._pendingPostMessages)
            this._postMessage(msg);

        this._pendingPostMessages.length = 0;
    }

    _normalizeDraggableRegion(region) {
        if (!region || typeof region !== 'object')
            return null;

        const x = Number(region.x);
        const y = Number(region.y);
        const width = Number(region.width);
        const height = Number(region.height);

        if (!Number.isFinite(x) || !Number.isFinite(y))
            return null;
        if (!Number.isFinite(width) || !Number.isFinite(height))
            return null;
        if (width <= 0 || height <= 0)
            return null;

        return {
            x,
            y,
            width,
            height,
        };
    }

    _sendHostStatePatch(patch) {
        let script;
        try {
            script =
            'if (window.ding && ' +
            'typeof window.ding._setHostState === "function") ' +
            `window.ding._setHostState(${
                JSON.stringify(patch)
            });`;
        } catch (e) {
            console.error('HtmlWidgetHost: failed to build host state script:', e);
            return;
        }

        this._evaluateScript(script);
    }

    _applyKeyboardFocusPolicy() {
        if (this._destroyed)
            return;

        this._applyWidgetKeyboardFocus(this._frame);
        this._applyWidgetKeyboardFocus(this._webView);
    }

    _applyWidgetKeyboardFocus(widget) {
        if (!widget || this._mode === 'prefs')
            return;

        widget.set_focusable(this._keyboardFocusable);
    }

    _pokeWebViewRender() {
        if (!this._webView || this._destroyed)
            return;

        const wv = this._webView;

        if (this._tickId) {
            wv.remove_tick_callback(this._tickId);
            this._tickId = 0;
        }

        this._tickId = wv.add_tick_callback(() => {
            const w = wv.get_allocated_width();
            const h = wv.get_allocated_height();
            if (w <= 1 || h <= 1)
                return GObject.SOURCE_CONTINUE;

            this._tickId = 0;

            // Host-side “poke”: invalidate + optional JS nudge
            wv.queue_draw();
            wv.queue_allocate();
            this._frame?.queue_draw();
            this._frame?.queue_allocate();
            this._nudgeWebViewDomRender();

            return GObject.SOURCE_REMOVE;
        });
    }

    _installWebViewRenderPoke() {
        const wv = this._webView;

        this._mappedNotifyId = wv.connect('notify::mapped', () => {
            if (wv.get_mapped())
                this._pokeWebViewRender();
        });

        if (wv.get_mapped())
            this._pokeWebViewRender();
    }

    _nudgeWebViewDomRender() {
        if (!this._webView || this._destroyed)
            return;

        this._evaluateScript(
            `try {
                const t = String(Date.now());
                const de = document.documentElement;
                const body = document.body;
                if (de) {
                    de.style.setProperty('--ding-render-poke', t);
                    de.setAttribute('data-ding-render-poke', t);
                }
                if (body) {
                    body.style.setProperty('--ding-render-poke', t);
                    body.setAttribute('data-ding-render-poke', t);
                }
                window.dispatchEvent(new Event('resize'));
                document.dispatchEvent(new Event('visibilitychange'));
                window.dispatchEvent(new Event('pageshow'));
                window.dispatchEvent(new Event('focus'));
                requestAnimationFrame(() => {});
            } catch (e) {}`
        );
    }

    _loadFallback(reason) {
        if (!this._webView)
            return;

        const safeReason = GLib.markup_escape_text(String(reason), -1);
        const html = WidgetApi.WIDGET_UNAVAILABLE_HTML.replace(
            '__REASON__',
            safeReason
        );

        this._webView.load_html(html, null);
    }

    _postMessage(msg) {
        let script;

        try {
            script =
            'if (typeof window.postMessage === "function") ' +
            `window.postMessage(${JSON.stringify(msg)}, "*")`;
        } catch (e) {
            console.error(
                'HtmlWidgetHost: failed to build postMessage script:', e
            );
            return;
        }

        this._evaluateScript(script);
    }

    _evaluateScript(script) {
        if (this._destroyed || !this._webView)
            return;

        try {
            this._webView?.evaluate_javascript(
                script,
                -1,
                null,
                null,
                null,
                (wv, res) => {
                    try {
                        if (!this._webView)
                            return;

                        wv?.evaluate_javascript_finish(res);
                    } catch (e) {
                        console.error(
                            'HtmlWidgetHost: failed to postMessage JS:', e
                        );
                    }
                }
            );
        } catch (e) {
            console.error(
                'HtmlWidgetHost: failed to postMessage to widget:', e
            );
        }
    }
};

/**
 * DingRoundedClip
 *
 * A tiny single-child container that clips its child to a rounded rect
 * using GTK4 snapshot APIs (push_rounded_clip).
 *
 * Intended to be used as the "frame" root for WebKitWebView so that GTK CSS
 * border-radius matches the child's visible corners without visual
 * artifacts as CSS is not clipping the webview's contents with a box or frame.
 */
export const DingRoundedClip = GObject.registerClass({
    GTypeName: 'DingRoundedClip',
    Properties: {
        radius: GObject.ParamSpec.double(
            'radius',
            'Radius',
            'Corner radius in pixels',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            0.0,
            4096.0,
            12.0
        ),
    },
}, class DingRoundedClip extends Gtk.Widget {
    _init(params = {}) {
        super._init(params);

        this._child = null;
        this._radius = 12.0;
    }

    // ─────────────────────────
    // properties
    // ─────────────────────────
    get radius() {
        return this._radius;
    }

    set radius(v) {
        const r = Math.max(0.0, Number(v) || 0.0);
        if (r === this._radius)
            return;

        this._radius = r;
        this.notify('radius');
        this.queue_draw();
    }

    // ─────────────────────────
    // child management
    // ─────────────────────────
    set_child(child) {
        if (child === this._child)
            return;

        if (this._child) {
            this._child.unparent();
            this._child = null;
        }

        this._child = child ?? null;

        if (this._child)
            this._child.set_parent(this);

        this.queue_resize();
    }

    get_child() {
        return this._child;
    }

    // ─────────────────────────
    // layout
    // ─────────────────────────
    vfunc_measure(orientation, forSize) {
        if (!this._child)
            return [0, 0, -1, -1];

        return this._child.measure(orientation, forSize);
    }

    vfunc_size_allocate(width, height, baseline) {
        if (!this._child)
            return;

        this._child.allocate(width, height, baseline, null);
    }

    // ─────────────────────────
    // rendering
    //
    // Snapshot is called by GTK4 to render the widget inside the clipped area.
    // ─────────────────────────
    vfunc_snapshot(snapshot) {
        if (!this._child)
            return;

        const width = this.get_width();
        const height = this.get_height();
        if (width <= 0 || height <= 0)
            return;

        const childWidth = this._child.get_width?.() ?? 0;
        const childHeight = this._child.get_height?.() ?? 0;
        if (childWidth <= 0 || childHeight <= 0)
            return;

        const rect = new Graphene.Rect();
        rect.init(0, 0, width, height);

        const r = this._radius;

        const size = new Graphene.Size();
        size.init(r, r);

        const rr = new Gsk.RoundedRect();
        rr.init(rect, size, size, size, size);

        snapshot.push_rounded_clip(rr);

        this.snapshot_child(this._child, snapshot);

        snapshot.pop();
    }
});
