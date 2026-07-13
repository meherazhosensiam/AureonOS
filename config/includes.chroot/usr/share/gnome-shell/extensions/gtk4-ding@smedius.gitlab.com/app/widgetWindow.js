/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Gtk4 Port Copyright (C) 2026 Sundeep Mediratta (smedius@gmail.com)
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

import {Gdk, Graphene, Gtk} from '../dependencies/gi.js';
import {_} from '../dependencies/gettext.js';

export {WidgetWindow};

const WidgetWindow = class {
    /**
     * Runtime adapter for one pinned widget window.
     *
     * The WidgetManager remains the canonical owner of widget geometry/state.
     * WidgetWindow only owns the Gtk.Window runtime host and reports runtime
     * events back to WidgetManager through explicit callbacks.
     *
     * Contract:
     * - This class is runtime-only. It does not own persistent widget state.
     * - It should be created only after WidgetManager has created inst.actor.
     * - The authoritative position/size remain in WidgetManager.
     * - The shell-side window type/stacking behavior is derived from the title
     *   string emitted here and enforced by windowTypeManager.
     *
     * @param {object} params
     * @param {object} params.widgetManager
     *   Canonical owner of the widget instance. Must provide:
     *   - getInstance(instanceId)
     *   - getInstanceFrame(instanceId)
     *   - beginPinnedEdit(instanceId)
     *   - beginPinnedWindowMove(instanceId, params)
     *   - setInstancePinned(instanceId, pinned)
     *   - optional pinned-window lifecycle callbacks
     * @param {object} params.mainApp
     *   Gtk.Application used to create a DING-owned Gtk.ApplicationWindow.
     * @param {string} params.instanceId
     *   The instance being hosted. Its actor must already exist before this
     *   runtime host is constructed and used.
     */
    constructor(params = {}) {
        this._widgetManager = params.widgetManager ?? null;
        this._mainApp = params.mainApp ?? null;
        this._instanceId = params.instanceId ?? null;

        this._window = null;
        this._overlay = null;
        this._actor = null;
        this._destroyed = false;
        this._isMapped = false;
        this._closeRequestId = 0;
        this._windowMapId = 0;
        this._windowUnmapId = 0;
        this._actorMapId = 0;
        this._dragGesture = null;
        this._hoverController = null;
        this._controlsBar = null;
        this._controlsBox = null;
        this._overlayButtons = new Map();

        this._createWindow();
    }

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------

    attachActor(actor) {
        if (!this._window || !this._overlay || !actor)
            return;

        const oldParent = actor.get_parent();
        if (oldParent && oldParent !== this._overlay)
            oldParent.remove(actor);

        this._disconnectActorSignals();
        this._overlay.set_child(actor);
        this._actor = actor;
        this._syncSize();
        this._connectActorSignals();
    }

    detachActor() {
        if (!this._overlay)
            return;

        const actor = this._overlay.get_child() ?? this._actor;
        if (actor)
            this._overlay.set_child(null);

        this._disconnectActorSignals();
        this._actor = null;
    }

    present() {
        if (!this._window || this._destroyed)
            return;

        this._window.present();
    }

    hide() {
        if (!this._window || this._destroyed)
            return;

        this._window.hide();
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        this.detachActor();
        this._disconnectSignals();

        if (this._window) {
            this._window.destroy();
            this._window = null;
        }

        this._destroyControlsStrip();
        this._overlay = null;
    }

    updateFromInstance(inst, frame) {
        if (!this._window || !inst)
            return;

        this.setPinnedTitle(this.buildPinnedTitle(frame, !!inst.widgetEditMode));
        this._rebuildControlsStrip();

        if (inst.widgetEditMode)
            this.present();
    }

    setPinnedTitle(title) {
        if (!this._window || typeof title !== 'string')
            return;

        this._window.set_title(title);
    }

    buildPinnedTitle(frame = null, widgetEditMode = false) {
        const resolvedFrame =
            frame ??
            this._widgetManager.getInstanceGlobalFrame(this._instanceId) ??
            null;
        const instanceId = this._instanceId ?? '';

        const x = Number.isFinite(resolvedFrame && resolvedFrame.x)
            ? Math.round(resolvedFrame.x)
            : 0;
        const y = Number.isFinite(resolvedFrame && resolvedFrame.y)
            ? Math.round(resolvedFrame.y)
            : 0;

        if (widgetEditMode)
            return `@!${x},${y};TH;I=${instanceId}`;

        return `@!${x},${y};KH;I=${instanceId}`;
    }

    beginPinnedEdit(_options = {}) {
        if (this._destroyed)
            return;

        this._widgetManager.beginPinnedEdit(this._instanceId);
    }

    beginPinnedWindowMove(params = {}) {
        if (!this._window || this._destroyed)
            return;

        this._beginWindowMoveFromPoint(params);
    }

    syncFromManager() {
        if (this._destroyed || !this._widgetManager)
            return;

        const inst = this._widgetManager.getInstance(this._instanceId);
        if (!inst)
            return;

        const frame =
            this._widgetManager.getInstanceGlobalFrame(this._instanceId) ?? null;

        this.updateFromInstance(inst, frame);
    }

    // -----------------------------------------------------------------
    // Private API
    // -----------------------------------------------------------------

    _createWindow() {
        this._window = new Gtk.ApplicationWindow({
            application: this._mainApp,
            decorated: false,
            deletable: false,
            resizable: false,
            modal: false,
            focusable: true,
            title: this.buildPinnedTitle(),
        });

        this._window.set_name('ding-widget-window');
        this._window.add_css_class('background');
        this._window.add_css_class('ding-widget-window');

        this._overlay = new Gtk.Overlay();
        this._overlay.set_name('ding-widget-window-content');
        this._installControlsStrip();
        this._installHoverController();
        this._installMoveGesture();

        this._window.set_child(this._overlay);
        this._connectSignals();
    }

    _installControlsStrip() {
        if (!this._overlay)
            return;

        if (this._controlsBar)
            return;

        this._controlsBar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.FILL,
            valign: Gtk.Align.START,
            hexpand: true,
            visible: true,
        });
        this._controlsBar.set_name('ding-pinned-overlay-controls');
        this._controlsBar.add_css_class('inactive');
        this._controlsBar.append(new Gtk.Box({
            hexpand: true,
            visible: true,
        }));
        this._controlsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            visible: true,
        });
        this._controlsBar.append(this._controlsBox);
        this._controlsBar.append(new Gtk.Box({
            hexpand: true,
            visible: true,
        }));
        this._overlay.add_overlay(this._controlsBar);
        this._rebuildControlsStrip();
    }

    _createOverlayButton(spec) {
        const button = new Gtk.Button({
            focus_on_click: false,
            can_focus: false,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        button.set_name(spec.cssName);
        button.set_child(Gtk.Image.new_from_icon_name(spec.iconName));
        if (spec.tooltip)
            button.set_tooltip_text(spec.tooltip);

        for (const cssClass of spec.classes ?? [])
            button.add_css_class(cssClass);

        if (spec.id === 'move') {
            const clickGesture = new Gtk.GestureClick({button: 1});
            clickGesture.connect('pressed', (gesture, _nPress, x, y) => {
                this._beginMoveFromOverlayButton(button, gesture, x, y);
            });
            button.add_controller(clickGesture);
        } else {
            button.connect('clicked', () => {
                this._widgetManager.activateHostAction(this._instanceId, spec.id);
            });
        }

        return button;
    }

    _beginMoveFromOverlayButton(button, gesture, x, y) {
        if (!this._overlay || !button)
            return;

        // The controls strip can be rebuilt while a press sequence is in flight.
        // Only act on the current live move button that belongs to this overlay.
        if (this._overlayButtons.get('move') !== button)
            return;

        const overlayRoot = this._overlay.get_root?.() ?? null;
        const buttonRoot = button.get_root?.() ?? null;
        if (!overlayRoot || buttonRoot !== overlayRoot || !button.get_parent?.())
            return;

        const [found, targetPoint] = button.compute_point(
            this._overlay,
            new Graphene.Point({x, y})
        );
        if (!found)
            return;

        this._beginWindowMoveFromPoint({
            localX: targetPoint.x,
            localY: targetPoint.y,
            button: gesture.get_current_button(),
            timestamp: gesture.get_current_event_time(),
            device: gesture.get_current_event_device(),
        });
    }

    _installHoverController() {
        if (!this._overlay)
            return;

        this._hoverController = new Gtk.EventControllerMotion();
        this._hoverController.connect('enter', () => {
            this._overlay.add_css_class('pointer-inside');
            this._showControlsStrip();
        });
        this._hoverController.connect('leave', () => {
            this._overlay.remove_css_class('pointer-inside');
            this._hideControlsStrip();
        });
        this._overlay.add_controller(this._hoverController);
    }

    _rebuildControlsStrip() {
        if (!this._controlsBox)
            return 0;

        let child = this._controlsBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._controlsBox.remove(child);
            child = next;
        }

        this._overlayButtons.clear();

        const specs = this._widgetManager.getHostActionSpecsForInstance(
            this._instanceId,
            {pinnedPopup: true}
        );

        for (const spec of specs) {
            const button = this._createOverlayButton(spec);
            this._overlayButtons.set(spec.id, button);
            this._controlsBox.append(button);
        }

        return specs.length;
    }

    _showControlsStrip() {
        if (!this._controlsBar)
            return;

        const buttonCount = this._rebuildControlsStrip();
        this._setControlsStripActive(buttonCount > 0);
    }

    _hideControlsStrip() {
        if (!this._controlsBar)
            return;

        this._setControlsStripActive(false);
    }

    _destroyControlsStrip() {
        if (!this._controlsBar)
            return;

        this._controlsBar.unparent();
        this._controlsBar = null;
        this._controlsBox = null;
        this._overlayButtons.clear();
    }

    _setControlsStripActive(active) {
        if (!this._controlsBar)
            return;

        if (active) {
            this._controlsBar.remove_css_class('inactive');
            this._controlsBar.add_css_class('active');
        } else {
            this._controlsBar.remove_css_class('active');
            this._controlsBar.add_css_class('inactive');
        }

        this._controlsBar.set_sensitive(active);
        this._widgetManager.updatePinnedHostChromeVisible(this._instanceId, active);
    }

    _installMoveGesture() {
        if (!this._overlay)
            return;

        this._dragGesture = new Gtk.GestureDrag({button: 1});
        this._dragGesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        this._dragGesture.connect(
            'drag-begin',
            this._onOverlayDragBegin.bind(this)
        );
        this._overlay.add_controller(this._dragGesture);
    }

    _connectSignals() {
        if (!this._window)
            return;

        this._closeRequestId = this._window.connect(
            'close-request',
            this._onCloseRequest.bind(this)
        );
        this._windowMapId = this._window.connect(
            'map',
            this._onMap.bind(this)
        );
        this._windowUnmapId = this._window.connect(
            'unmap',
            this._onUnmap.bind(this)
        );
    }

    _disconnectSignals() {
        if (this._closeRequestId && this._window)
            this._window.disconnect(this._closeRequestId);
        this._closeRequestId = 0;

        if (this._windowMapId && this._window)
            this._window.disconnect(this._windowMapId);
        this._windowMapId = 0;

        if (this._windowUnmapId && this._window)
            this._window.disconnect(this._windowUnmapId);
        this._windowUnmapId = 0;
    }

    _connectActorSignals() {
        if (!this._actor)
            return;

        this._actorMapId = this._actor.connect(
            'map',
            this._onActorMap.bind(this)
        );
    }

    _disconnectActorSignals() {
        if (this._actorMapId && this._actor)
            this._actor.disconnect(this._actorMapId);
        this._actorMapId = 0;
    }

    _syncSize() {
        if (!this._window)
            return;

        let width = 0;
        let height = 0;

        if (this._actor) {
            const alloc = this._actor.get_allocation();
            width = alloc && alloc.width ? alloc.width : this._actor.get_width();
            height = alloc && alloc.height ? alloc.height : this._actor.get_height();
        }

        if (width <= 0 || height <= 0) {
            const inst = this._widgetManager.getInstance(this._instanceId);
            width = inst && inst.width ? inst.width : width;
            height = inst && inst.height ? inst.height : height;
        }

        if (width > 0 && height > 0) {
            this._window.set_default_size(width, height);
            this._window.set_size_request(width, height);
        }
    }

    _onCloseRequest() {
        // Pinned widgets do not destroy themselves via the window close path.
        // WidgetManager decides whether close means "unpin" or "remove".
        this._widgetManager.onPinnedWindowCloseRequest(this._instanceId);
        return true;
    }

    _onMap() {
        this._isMapped = true;
        this.syncFromManager();
    }

    _onUnmap() {
        this._isMapped = false;
    }

    _onActorMap() {
        this._syncSize();
    }

    _onOverlayDragBegin(gesture, startX, startY) {
        if (!this._window || this._destroyed)
            return;

        const picked = this._overlay.pick(startX, startY, Gtk.PickFlags.DEFAULT);

        if (this._isOverlayButtonActor(picked) ||
            !this._isOverlayStripActor(picked)) {
            gesture.set_state(Gtk.EventSequenceState.DENIED);
            return;
        }

        // The strip itself is the drag handle for pinned windows.
        // The move button only changes the visible affordance; it does not
        // control whether the strip can start a window move.
        this._beginWindowMoveFromPoint({
            localX: startX,
            localY: startY,
            button: gesture.get_current_button(),
            timestamp: gesture.get_current_event_time(),
            device: gesture.get_current_event_device(),
        });
    }

    _beginWindowMoveFromPoint(params = {}) {
        const native = this._overlay.get_native();
        const surface = native.get_surface();
        const toplevel = surface;
        const display = Gdk.Display.get_default();
        const seat = display.get_default_seat();
        const device = params.device ?? seat.get_pointer();
        const button = Number.isFinite(params.button) ? params.button : 1;
        const timestamp = Number.isFinite(params.timestamp) ? params.timestamp : 0;
        const localX = Number.isFinite(params.localX) ? params.localX : 0;
        const localY = Number.isFinite(params.localY) ? params.localY : 0;

        if (!toplevel.begin_move || !device)
            return false;

        const [transformX, transformY] = native.get_surface_transform();

        toplevel.begin_move(
            device,
            button,
            localX + transformX,
            localY + transformY,
            timestamp
        );
        return true;
    }

    _isOverlayButtonActor(actor) {
        const overlayButtons = new Set(this._overlayButtons.values());
        let current = actor;
        while (current) {
            if (overlayButtons.has(current))
                return true;

            current = current.get_parent();
        }

        return false;
    }

    _isOverlayStripActor(actor) {
        let current = actor;
        while (current) {
            if (current === this._controlsBar)
                return true;

            current = current.get_parent();
        }

        return false;
    }
};
