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

import {Adw, Gio, GLib, Gtk, Gdk} from '../dependencies/gi.js';
import {_} from '../dependencies/gettext.js';
import {WidgetRegistry} from '../dependencies/localFiles.js';
import {FileUtils} from '../dependencies/localFiles.js';
import {HtmlWidgetHost, HtmlWidgetHostWithBackend} from '../dependencies/localFiles.js';
import {PinnedWindowManager} from '../dependencies/localFiles.js';
import {WebWidgetContext} from '../dependencies/localFiles.js';
import {WebUtils} from '../dependencies/localFiles.js';

/**
 * WidgetManager
 *
 * - Owned by DesktopManager.
 * - Uses DesktopGrid/WidgetGrid for all geometry math.
 * - Positions widgets inside each grid's `widgetContainer` (Gtk.Fixed).
 *
 * Coordinate model:
 *   - We store per-instance:
 *       * monitorIndex
 *       * normX, normY  (0..1, normalized to grid.normalizedWidth/Height)
 *       * pinnedGlobalX, pinnedGlobalY (absolute shell coords for floating
 *         pinned windows; used to survive margin/order changes)
 *       * width, height (absolute pixels, widget-owned)
 *   - On layout changes, we rebuild a map of:
 *       monitorIndex -> { grid, widgetContainer }
 *   - To place an instance:
 *       localX = normX * grid.normalizedWidth
 *       localY = normY * grid.normalizedHeight
 *       widgetContainer.put(actor, localX, localY)
 */
export {WidgetManager};

function cloneWidgetConfig(config) {
    if (config === null || config === undefined)
        return {};

    try {
        return JSON.parse(JSON.stringify(config));
    } catch (e) {
        console.error('WidgetManager: failed to clone widget config:', e);
        return {};
    }
}

function configJson(config) {
    try {
        return JSON.stringify(config ?? {});
    } catch (e) {
        return null;
    }
}

const WIDGETS_STATE_SCHEMA_VERSION = 4;
const ENTIRE_STRING_LENGTH = -1;
const appID = 'com.desktop.ding';
const appPath = GLib.build_filenamev(['/', ...appID.split('.')]);

const WidgetManager = class {
    constructor(desktopManager) {
        this._desktopManager = desktopManager;
        this.Enums = desktopManager.Enums;
        this._preferences = desktopManager.Prefs;
        this._desktopIconsUtil = desktopManager.DesktopIconsUtil;
        this._widgetRegistry = new WidgetRegistry(this._desktopIconsUtil);
        this._pinnedWindowManager = new PinnedWindowManager({
            widgetManager: this,
            mainApp: desktopManager.mainApp,
        });
        this._iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        this._iconTheme.add_resource_path(`${appPath}/icons`);

        // monitorIndex -> { grid, widgetContainer }
        this._surfaces = new Map();

        // instanceId -> {
        //   instanceId,
        //   widgetId,
        //   kind,
        //   monitorIndex,
        //   normX,
        //   normY,
        //   width,
        //   height,
        //   actor,
        //   config,
        // }
        this._instances = new Map();
        this._chrome = null;
        this._selectedInstanceId = null;
        this._webWidgetContext = null;
        this._textEntryAccelsSuppressedForWidgets = false;
        this._selectionChromeSuppressed = false;
        this._pendingPinnedWindowReloadId = 0;
        this._dbusScreenSaverActiveChangedId = 0;
        this._downloadCancellable = new Gio.Cancellable();

        // When true, suppress emitting stateChanged events
        this._suppressStateEvents = false;
        this._loadStatePromise = null;
        this._pendingLoadState = null;

        this._connectWakeReloadListener();
        this._addActions();

        // loadState is handled during startup and by Preferences; avoid
        // overlapping loads during construction.
    }

    clearFromGrids(layoutChange = {}) {
        const preservePinnedWindows =
            !!layoutChange?.gridschanged &&
            !layoutChange?.monitorschanged;

        for (const inst of this._instances.values()) {
            if (preservePinnedWindows &&
                inst?.pinned &&
                this._pinnedWindowManager.hasInstance(inst.instanceId))
                continue;

            const parent = inst.actor?.get_parent?.();
            if (parent?.remove)
                parent.remove(inst.actor);
        }

        if (!preservePinnedWindows)
            this._pinnedWindowManager.destroyAllWindows();

        for (const surface of this._surfaces.values())
            this._teardownSurface(surface);

        this._surfaces.clear();
    }

    stopWidgetDisplay() {
        this._downloadCancellable?.cancel();
        this._cancelPendingPinnedWindowReload();

        for (const surface of this._surfaces.values())
            surface.grid.lowerWidgetContainer();

        this.clearFromGrids();

        for (const inst of this._instances.values()) {
            if (inst.host && typeof inst.host.destroy === 'function')
                inst.host.destroy();

            inst.host = null;
            inst.actor = null;
        }

        this._stopWebkitIfUnneeded();

        this._stateChanged();
    }

    async startWidgetDisplay(desktops, params) {
        await this.loadState(
            this._preferences.widgetState
        );

        await this.applyLayoutChange(desktops, params);
    }

    /**
     * Called by DesktopManager from applyDesktopLayoutChange().
     *
     * @param {Array<object>} desktops - the same array WindowManager uses,
     *   containing DesktopGrid/WidgetGrid instances for each monitor.
     *
     * @param {object} changeInfo - layout change info:
     *   {
     *     redisplay: boolean,
     *     monitorschanged: boolean,
     *     gridschanged: boolean,
     *   }
     */
    async applyLayoutChange(desktops, changeInfo) {
        if (!changeInfo?.redisplay)
            return;

        this._rebuildSurfacesFrom(desktops);
        this._detachInstancesWithoutSurface();
        await this._reattachAllInstances(changeInfo);
        this._stopWebkitIfUnneeded();
    }

    handleWidgetContainerLayerChange(monitorIndex, onTop) {
        const surface = this._surfaces.get(monitorIndex);
        if (!surface)
            return;

        this._clearWidgetEditModeForMonitor(monitorIndex);
        this._attachPinnedInstancesToCorrectLayer(monitorIndex, onTop);

        this._updateAddWidgetButtonVisibility(surface, onTop);
        this._updateGridToggleButtonVisibility(surface, onTop);
        this._raiseAddButton(surface);
        this._raiseGridToggleButton(surface);
        this._updateWidgetLayerChange(monitorIndex, onTop);

        if (!onTop) {
            if (surface.gridToggleButton)
                surface.gridToggleButton.set_active(false);

            surface.grid.widgetGridEnabled = false;
            surface.grid.updateOverlay();
        }

        this._syncTextEntryAccelState();
    }

    restoreWidgetLayerFocus(monitorIndex = null) {
        if (monitorIndex !== null) {
            const surface = this._surfaces.get(monitorIndex);
            surface?.grid?.restoreWidgetLayerFocus?.();
            return;
        }

        for (const surface of this._surfaces.values()) {
            if (!surface?.grid?.isWidgetContainerOnTop?.())
                continue;

            surface.grid.restoreWidgetLayerFocus?.();
            return;
        }
    }

    schedulePinnedWindowWakeReload(reason = 'window-remap') {
        if (this._pendingPinnedWindowReloadId)
            return;

        this._pendingPinnedWindowReloadId = GLib.idle_add(
            GLib.PRIORITY_DEFAULT_IDLE,
            () => {
                this._pendingPinnedWindowReloadId = 0;
                this._reloadPinnedHtmlWidgetsInWindows(reason)
                    .catch(e => logError(e));
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _connectWakeReloadListener() {
        this._dbusScreenSaverActiveChangedId =
            this._desktopManager.DBusUtils.connect(
                'screen-saver-active-changed',
                (_dbusUtils, active) => {
                    if (active)
                        return;

                    this.schedulePinnedWindowWakeReload('screen-unlock');
                }
            );
    }

    // =====================================================================
    // Public instance API
    // =====================================================================

    /**
     * High-level helper: create a new instance for a widget from the registry.
     *
     * @param {string} widgetId - ID from WidgetRegistry (usually folder name).
     * @param {object} opts
     *   {
     *     monitorIndex?: number,  // optional, defaults to first available
     *     x?: number,             // local coords in widgetContainer space
     *     y?: number,
     *     width?: number,         // override defaultWidth/defaultHeight
     *     height?: number,
     *     initialPinned?: boolean,           // optional initial pinned mode
     *     inheritConsentFromInstanceId?: string, // optional source instance
     *     selectAfterCreate?: boolean,           // optional auto-select/focus
     *   }
     *
     * Returns the created instance object or null.
     */
    async createInstanceForWidget(widgetId, opts = {}) {
        if (!this._preferences.showDesktopWidgets)
            return null;

        if (!widgetId) {
            console.error('createInstanceForWidget: missing widgetId');
            return null;
        }

        if (!this._widgetRegistry) {
            console.error('createInstanceForWidget: widgetRegistry missing');
            return null;
        }

        // 1. Load descriptor (or create a fallback one)
        let descriptor = null;
        try {
            descriptor = await this._widgetRegistry.getDescriptor(widgetId);
        } catch (e) {
            console.error(`Descriptor load failed for ${widgetId}:`, e);
        }

        let kind = 'html';
        if (!descriptor) {
            console.warn(
                `createInstanceForWidget: no descriptor for ${widgetId},` +
                ' using fallback html kind'
            );
        } else {
            kind = descriptor.kind || 'html';
        }

        // 2. Choose monitor index: caller hint or first available surface
        let monitorIndex = opts.monitorIndex;
        if (monitorIndex === undefined || monitorIndex === null) {
            const iter = this._surfaces.keys().next();
            monitorIndex = !iter.done ? iter.value : 0;
        }

        const surface = this._surfaces.get(monitorIndex);
        if (!surface) {
            console.error(
                `createInstanceForWidget: invalid monitorIndex ${monitorIndex}`
            );
            return null;
        }

        const {grid} = surface;

        // 3. Size from opts or registry defaults
        const width = opts.width ??
            descriptor?.defaultWidth ??
            200;

        const height = opts.height ??
            descriptor?.defaultHeight ??
            150;

        // 4. Compute placement
        let x = opts.x;
        let y = opts.y;

        if (x === undefined || y === undefined) {
            const wNorm = grid.normalizedWidth;
            const hNorm = grid.normalizedHeight;

            x = Math.max(0, (wNorm - width) / 2);
            y = Math.max(0, (hNorm - height) / 3);
        }

        // 5. Create the actual instance (generates UUID, attaches actor)
        const instance = this._createInstance(
            widgetId,
            monitorIndex,
            x,
            y,
            width,
            height,
            cloneWidgetConfig(descriptor?.defaultConfig ?? {}),
            kind,
            descriptor
        );

        if (!instance)
            return null;

        const inheritFromId = opts.inheritConsentFromInstanceId;
        if (typeof inheritFromId === 'string' && inheritFromId.length > 0) {
            const source = this._instances.get(inheritFromId);
            if (source && source.widgetId === widgetId) {
                if (source.webConsent === true)
                    instance.webConsent = true;
                if (instance.hasBackend && source.backendConsent === true)
                    instance.backendConsent = true;
            }
        }

        const created = await this._ensureInstanceActor(instance);

        if (!created)
            return null;

        if (opts.initialPinned === true)
            instance.pinned = true;

        this._attachInstanceToCorrectLayer(instance);

        const shouldAutoSelect =
            opts.selectAfterCreate === true &&
            (surface.grid?.isWidgetContainerOnTop?.() || !instance.pinned);

        if (shouldAutoSelect)
            this.selectInstance(instance.instanceId);

        // Persist creation
        this._stateChanged();

        return instance;
    }

    removeInstance(instanceId) {
        this._removeActor(instanceId);
        this._stateChanged();
        this._stopWebkitIfUnneeded();
    }

    deleteSelectedInstance() {
        if (!this._selectedInstanceId)
            return false;

        const toRemove = this._selectedInstanceId;

        // Clear selection first so CSS + chrome are detached.
        this.selectInstance(null);
        this.removeInstance(toRemove);

        return true;
    }

    setInstanceFrame(instanceId, x, y, width = null, height = null) {
        const inst = this._instances.get(instanceId);
        if (!inst)
            return;

        const surface = this._surfaces.get(inst.monitorIndex);
        if (!surface)
            return;

        const {grid} = surface;

        const [normX, normY] = grid.getNormalizedCoordinates(x, y);

        const EPSILON = 1e-4;
        const normXChanged = Math.abs(inst.normX - normX) > EPSILON;
        const normYChanged = Math.abs(inst.normY - normY) > EPSILON;
        let sizeChanged = false;

        if (width !== null && width !== inst.width) {
            inst.width = width;
            sizeChanged = true;
        }

        if (height !== null && height !== inst.height) {
            inst.height = height;
            sizeChanged = true;
        }

        // Don't reposition if nothing changed, to avoid unnecessary state
        // updates that write the json file with new postion triggering UI
        // to refresh.
        if (!normXChanged && !normYChanged && !sizeChanged)
            return;

        inst.normX = normX;
        inst.normY = normY;
        if (inst.pinned) {
            const [globalX, globalY] =
                surface.grid.coordinatesLocalToGlobal(
                    Math.round(x),
                    Math.round(y)
                );
            inst.pinnedGlobalX = globalX;
            inst.pinnedGlobalY = globalY;
        }

        this._positionInstanceActor(inst);
    }

    updatePinnedWindowPosition(instanceId, globalX, globalY) {
        const inst = this._instances.get(instanceId);
        if (!inst || !inst.pinned)
            return;

        const roundedGlobalX = Math.round(globalX);
        const roundedGlobalY = Math.round(globalY);

        if (inst.pinnedGlobalX === roundedGlobalX &&
            inst.pinnedGlobalY === roundedGlobalY)
            return;

        inst.pinnedGlobalX = roundedGlobalX;
        inst.pinnedGlobalY = roundedGlobalY;

        let targetSurface = this._surfaces.get(inst.monitorIndex) ?? null;

        if (!targetSurface?.grid?.coordinatesBelongToThisGridWindow?.(
            roundedGlobalX,
            roundedGlobalY
        )) {
            for (const surface of this._surfaces.values()) {
                if (!surface?.grid?.coordinatesBelongToThisGridWindow?.(
                    roundedGlobalX,
                    roundedGlobalY
                ))
                    continue;


                targetSurface = surface;
                break;
            }
        }

        if (!targetSurface?.grid) {
            this._stateChanged();
            return;
        }

        const [localX, localY] =
            targetSurface.grid._coordinatesGlobalToLocal(
                roundedGlobalX,
                roundedGlobalY
            );
        const roundedLocalX = Math.round(localX);
        const roundedLocalY = Math.round(localY);
        const currentFrame = this.getInstanceFrame(instanceId);
        const targetMonitorIndex = targetSurface.monitorIndex;

        if (currentFrame &&
            inst.monitorIndex === targetMonitorIndex &&
            currentFrame.x === roundedLocalX &&
            currentFrame.y === roundedLocalY) {
            this._stateChanged();
            return;
        }


        inst.monitorIndex = targetMonitorIndex;
        this.setInstanceFrame(instanceId, roundedLocalX, roundedLocalY);

        if (inst.pinned)
            this._pinnedWindowManager.refreshInstance(inst);

        this._stateChanged();
    }

    /*
     * Compute the current absolute frame for an instance based on
     * stored normX/normY + width/height and the grid's normalized size.
     *
     * Returns coordinates in the local coordinate space of the
     * widgetContainer.
     *
     */
    getInstanceFrame(instanceId) {
        const inst = this._instances.get(instanceId);
        if (!inst)
            return null;

        const surface = this._surfaces.get(inst.monitorIndex);
        if (!surface) {
            return {
                x: 0,
                y: 0,
                width: inst.width,
                height: inst.height,
            };
        }

        const {grid} = surface;

        let [x, y] = grid.setNormalizedCoordinates(inst.normX, inst.normY);

        const wNorm = grid.normalizedWidth;
        const hNorm = grid.normalizedHeight;

        const w = inst.width;
        const h = inst.height;

        // Clamp to stay inside the grid's usable area
        let clamped = false;
        if (wNorm > 0 && w <= wNorm) {
            if (x + w > wNorm) {
                x = wNorm - w;
                clamped = true;
            }
            if (x < 0) {
                x = 0;
                clamped = true;
            }
        }

        if (hNorm > 0 && h <= hNorm) {
            if (y + h > hNorm) {
                y = hNorm - h;
                clamped = true;
            }
            if (y < 0) {
                y = 0;
                clamped = true;
            }
        }

        return {x, y, width: w, height: h, clamped};
    }

    getInstanceGlobalFrame(instanceId) {
        const inst = this._instances.get(instanceId);
        if (!inst)
            return null;

        const frame = this.getInstanceFrame(instanceId);
        if (!frame)
            return null;

        const surface = this._surfaces.get(inst.monitorIndex);

        if (inst.pinned &&
            surface?.grid?.coordinatesBelongToThisGridWindow?.(
                inst.pinnedGlobalX,
                inst.pinnedGlobalY
            ) &&
            Number.isFinite(inst.pinnedGlobalX) &&
            Number.isFinite(inst.pinnedGlobalY)
        ) {
            return {
                x: inst.pinnedGlobalX,
                y: inst.pinnedGlobalY,
                width: frame.width,
                height: frame.height,
                clamped: frame.clamped,
            };
        }

        if (!surface) {
            return {
                x: frame.x,
                y: frame.y,
                width: frame.width,
                height: frame.height,
                clamped: frame.clamped,
            };
        }

        const [x, y] = surface.grid.coordinatesLocalToGlobal(frame.x, frame.y);
        return {
            x,
            y,
            width: frame.width,
            height: frame.height,
            clamped: frame.clamped,
        };
    }

    get instances() {
        return this._instances;
    }

    getInstance(instanceId) {
        return this._instances.get(instanceId) || null;
    }

    getSurfaceWindow(monitorIndex) {
        const surface = this._surfaces.get(monitorIndex);
        if (!surface || !surface.grid)
            return null;

        return surface.grid.getWindow();
    }

    getMonitorIndexForWindow(window) {
        if (!window)
            return null;

        for (const surface of this._surfaces.values()) {
            if (surface.grid.getWindow() === window)
                return surface.monitorIndex;
        }

        const instanceId =
            this._pinnedWindowManager.getInstanceIdForWindow(window);
        if (!instanceId)
            return null;

        const inst = this.getInstance(instanceId);
        return inst?.monitorIndex ?? null;
    }

    resolveSurfaceWindow(window) {
        if (!window)
            return null;

        for (const surface of this._surfaces.values()) {
            if (surface.grid.getWindow() === window)
                return window;
        }

        const instanceId =
            this._pinnedWindowManager.getInstanceIdForWindow(window);
        if (!instanceId)
            return window;

        const inst = this.getInstance(instanceId);
        const monitorIndex = inst?.monitorIndex ?? null;
        if (monitorIndex === null)
            return window;

        const surfaceWindow = this.getSurfaceWindow(monitorIndex);
        return surfaceWindow ?? window;
    }

    resolveSurfaceWindowFromActiveWindow(window = null) {
        const activeWindow =
            window ?? this._desktopManager.mainApp.get_active_window();
        return this.resolveSurfaceWindow(activeWindow);
    }

    getSelectedInstanceId() {
        return this._selectedInstanceId;
    }

    clearSelectedInstance() {
        const oldInst = this._instances.get(this._selectedInstanceId);
        this._updateActorSelectedClass(oldInst, false);

        this._selectedInstanceId = null;
        this._selectionChromeSuppressed = false;
        this._clearInvalidWidgetEditModes();
        this._detachChrome();
        this._updateWidgetsSelectionState();
    }

    selectInstance(instanceId) {
        if (this._selectedInstanceId &&
            this._selectedInstanceId !== instanceId
        ) {
            const oldInst = this._instances.get(this._selectedInstanceId);
            if (oldInst?.actor) {
                this._updateActorSelectedClass(oldInst, false);
                this._webWidgetContext?.closePreferencesIfAny();
            }
        }

        this._selectedInstanceId = instanceId || null;

        if (!instanceId) {
            this._selectionChromeSuppressed = false;
            this._clearInvalidWidgetEditModes();
            this._detachChrome();
            this._updateWidgetsSelectionState();
            this._webWidgetContext?.closePreferencesIfAny();
            return;
        }

        const inst = this._instances.get(instanceId);
        if (!inst?.actor || inst._isAddButton || inst._isGridToggleButton) {
            this._selectedInstanceId = null;
            this._clearInvalidWidgetEditModes();
            this._detachChrome();
            this._updateWidgetsSelectionState();
            this._webWidgetContext?.closePreferencesForInstance();
            return;
        }

        this._updateActorSelectedClass(inst, true);

        this._raiseInstance(inst);

        if (typeof inst.actor.grab_focus === 'function')
            inst.actor.grab_focus();

        this._ensureChrome();
        this._attachChromeToInstance(inst);
        this._clearInvalidWidgetEditModes();
        this._updateWidgetsSelectionState();
    }

    hideSelectionChromeDuringDrag() {
        this._selectionChromeSuppressed = true;

        if (this._chrome)
            this._hideAllChromeButtons();

        if (this._selectedInstanceId) {
            const inst = this._instances.get(this._selectedInstanceId);
            this._updateActorSelectedClass(inst, false);
        }
    }

    updateSelectionChromePositionFor(instanceId) {
        if (!instanceId || instanceId !== this._selectedInstanceId)
            return;

        this._selectionChromeSuppressed = false;

        const inst = this._instances.get(instanceId);
        if (!inst)
            return;

        this._updateActorSelectedClass(inst, true);

        this._ensureChrome();
        this._attachChromeToInstance(inst);
    }

    _updateActorSelectedClass(inst, selected) {
        if (!inst?.actor)
            return;

        const ctx = inst.actor.get_style_context();
        if (!selected) {
            ctx.remove_class('ding-widget-selected');
            return;
        }

        const surface = this._surfaces.get(inst.monitorIndex);
        const widgetContainer = surface?.widgetContainer ?? null;
        const parent = inst.actor.get_parent?.() ?? null;
        if (widgetContainer && parent !== widgetContainer) {
            ctx.remove_class('ding-widget-selected');
            return;
        }

        ctx.add_class('ding-widget-selected');
    }

    async listAvailableWidgets() {
        if (!this._widgetRegistry)
            return [];

        const widgets = await this._widgetRegistry.listWidgets().catch(e => {
            console.error('WidgetManager: listAvailableWidgets failed:', e);
            return [];
        });

        return widgets;
    }

    onThemeChanged() {
        const theme = this._preferences.darkmode ? 'dark' : 'light';

        for (const inst of this._instances.values())
            this._updateTheme(inst, theme);
    }

    onAnimationChanged() {
        const reducedMotion = !this._preferences.globalAnimations;

        for (const inst of this._instances.values())
            this._updateAnimation(inst, reducedMotion);
    }

    // =====================================================================
    // Widget state persistence API
    // =====================================================================

    /*
     * Load widget instances from a JSON-compatible object.
     *
     * Schema:
     * {
     *   version: 2,
     *   instances: [
     *     {
     *      instanceId, widgetId, kind,
     *      monitorIndex, normX, normY,
     *      width, height,
     *      config: { ... }   // author-defined fields
     *      prefsUri: string|null,
     *      hasPreferences: boolean,
     *      pinnable: boolean,
     *      chrome: {
     *        showCloseButton: boolean,
     *        showPrefsButton: boolean,
     *        showMoveButton: boolean,
     *        showPinButton: boolean,
     *      },
     *      hasBackend: boolean,
     *      webConsent: boolean|null,
     *      backendConsent: boolean|null,
     *     },
     *     ...
     *   ]
     * }
     *
     *
     * @param {object} state - JSON-compatible object as described above.
     *
     * @returns {void}
     *
     * It is called by Preferences when it reads the saved state from disk.
     * as well as by DesktopManager when it starts as well from this
     * constructor.
     *
     * It is also called by Preferences when the user changes widget state.
     *
     * As the state read from disk is asynchronous, this method may be called
     * before the widget registry is loaded, with null, so we need to handle
     * that case gracefully.
     *
     * Method is idempotent; it will not remove instances that are not in the
     * input state, and it will not add instances that are already present.
     *
     * It also has to deal with null, undefined, or missing fields gracefully.
     */
    // eslint-disable-next-line consistent-return
    async loadState(state) {
        if (this._loadStatePromise) {
            this._pendingLoadState = state;
            return this._loadStatePromise;
        }

        this._loadStatePromise = this._loadStateInner(state);

        try {
            await this._loadStatePromise;
        } finally {
            this._loadStatePromise = null;
            if (this._pendingLoadState) {
                const pending = this._pendingLoadState;
                this._pendingLoadState = null;
                await this.loadState(pending);
            }
        }
    }

    async _loadStateInner(state) {
        if (!state || typeof state !== 'object')
            return;

        const schemaVersion =
            Number.isFinite(state.version) ? state.version : 1;

        if (schemaVersion < WIDGETS_STATE_SCHEMA_VERSION) {
            console.warn(
                `WidgetManager loadState: state version ${schemaVersion} ` +
                `(current ${WIDGETS_STATE_SCHEMA_VERSION}); migrating`
            );
            state = await this._migrateToCurrentVersion(state);
        }


        if (!Array.isArray(state.instances))
            return;

        const prevSelection = this._selectedInstanceId;

        // Avoid emitting stateChanged while rebuilding from persisted state.
        // Only suppress around positioning, so we don't block saves for long
        // async operations (e.g., consent prompts).
        const previousSuppressionState = this._suppressStateEvents;

        try {
            const seen = new Set();

            for (const instData of state.instances) {
                if (!instData.instanceId || !instData.widgetId)
                    continue;

                try {
                    let descriptor = null;
                    try {
                        // eslint-disable-next-line no-await-in-loop
                        descriptor = await this._widgetRegistry.getDescriptor(
                            instData.widgetId
                        );
                    } catch (e) {}

                    const resolvedChrome = this._normalizeChromePolicy(
                        instData.chrome,
                        descriptor?.chrome
                    );
                    const resolvedPrefsUri =
                        instData.prefsUri ?? descriptor?.prefs ?? null;
                    const resolvedHasPreferences =
                        instData.hasPreferences ?? !!resolvedPrefsUri;
                    const resolvedPinnable =
                        instData.pinnable ?? descriptor?.pinnable === true;
                    const resolvedHasBackend =
                        instData.hasBackend ??
                        descriptor?.hasBackend ??
                        !!descriptor?.backend;
                    const resolvedConfig = cloneWidgetConfig({
                        ...descriptor?.defaultConfig ?? {},
                        ...instData.config ?? {},
                    });

                    let instance = this._instances.get(instData.instanceId);

                    if (instance) {
                        instance.widgetId = instData.widgetId;
                        instance.monitorIndex = instData.monitorIndex ?? 0;
                        instance.kind = instData.kind ?? 'html';
                        instance.normX = instData.normX ?? 0;
                        instance.normY = instData.normY ?? 0;
                        instance.width = instData.width ?? 200;
                        instance.height = instData.height ?? 150;
                        instance.pinnedGlobalX =
                            Number.isFinite(instData.pinnedGlobalX)
                                ? instData.pinnedGlobalX
                                : null;
                        instance.pinnedGlobalY =
                            Number.isFinite(instData.pinnedGlobalY)
                                ? instData.pinnedGlobalY
                                : null;
                        instance.config = resolvedConfig;
                        instance.prefsUri = resolvedPrefsUri;
                        instance.hasPreferences = resolvedHasPreferences;
                        instance.pinnable = resolvedPinnable;
                        instance.chrome = resolvedChrome;
                        instance.hasBackend = resolvedHasBackend;
                        instance.webConsent = instData.webConsent ?? null;
                        instance.backendConsent =
                            instData.backendConsent ?? null;
                        instance.pinned = !!instData.pinned;
                    } else {
                        instance = {
                            instanceId: instData.instanceId,
                            widgetId: instData.widgetId,
                            monitorIndex: instData.monitorIndex ?? 0,
                            kind: instData.kind ?? 'html',
                            normX: instData.normX ?? 0,
                            normY: instData.normY ?? 0,
                            width: instData.width ?? 200,
                            height: instData.height ?? 150,
                            pinnedGlobalX:
                                Number.isFinite(instData.pinnedGlobalX)
                                    ? instData.pinnedGlobalX
                                    : null,
                            pinnedGlobalY:
                                Number.isFinite(instData.pinnedGlobalY)
                                    ? instData.pinnedGlobalY
                                    : null,
                            actor: null,
                            config: resolvedConfig,
                            prefsUri: resolvedPrefsUri,
                            hasPreferences: resolvedHasPreferences,
                            pinnable: resolvedPinnable,
                            chrome: resolvedChrome,
                            hasBackend: resolvedHasBackend,
                            webConsent: instData.webConsent ?? null,
                            backendConsent: instData.backendConsent ?? null,
                            pinned: !!instData.pinned,
                            widgetEditMode: false,
                        };

                        this._instances.set(instance.instanceId, instance);
                    }

                    seen.add(instance.instanceId);

                    const surface = this._surfaces.get(instance.monitorIndex);
                    if (surface) {
                        const created =
                        // eslint-disable-next-line no-await-in-loop
                            await this._ensureInstanceActor(instance);

                        if (!created)
                            continue;

                        const prev = this._suppressStateEvents;
                        this._suppressStateEvents = true;
                        this._attachInstanceToCorrectLayer(instance);
                        this._suppressStateEvents = prev;
                    }
                } catch (e) {
                    console.error(
                        'WidgetManager loadState failed for instance:',
                        {
                            instanceId: instData.instanceId,
                            widgetId: instData.widgetId,
                            monitorIndex: instData.monitorIndex,
                            kind: instData.kind,
                        },
                        e
                    );
                }
            }

            for (const instanceId of [...this._instances.keys()]) {
                const instance = this._instances.get(instanceId);
                if (instance?._isAddButton || instance?._isGridToggleButton)
                    continue;

                if (seen.has(instanceId))
                    continue;

                this._removeActor(instanceId);
            }

            if (prevSelection && this._instances.has(prevSelection))
                this.selectInstance(prevSelection);
            else
                this.selectInstance(null);
        } catch (e) {
            console.error('WidgetManager loadState failed:', e);
        } finally {
            this._suppressStateEvents = previousSuppressionState;
        }
    }

    updateInstanceConfig(instanceId, newConfig) {
        const inst = this._instances.get(instanceId);
        if (!inst)
            return false;

        const clonedConfig = cloneWidgetConfig(newConfig);
        const currentJson = configJson(inst.config);
        const nextJson = configJson(clonedConfig);
        if (currentJson !== null && nextJson !== null && currentJson === nextJson)
            return false;

        inst.config = clonedConfig;
        this._stateChanged();
        return true;
    }

    setWidgetEditMode(instanceId, editing) {
        const inst = this._instances.get(instanceId);
        if (!inst || inst._isAddButton || inst._isGridToggleButton)
            return;

        const nextEditing = !!editing;
        if (!nextEditing) {
            this._setWidgetEditMode(inst, false);
            return;
        }

        if (inst.pinned && this._shouldAttachToDockLayer(inst)) {
            this._setWidgetEditMode(inst, true);
            this._pinnedWindowManager.pinInstance(inst)?.present?.();
            return;
        }

        const surface = this._surfaces.get(inst.monitorIndex);
        const widgetLayerOnTop = !!surface?.grid?.isWidgetContainerOnTop?.();
        const isSelected = this._selectedInstanceId === instanceId;
        const parent = inst.actor?.get_parent?.();
        const inContainer = !!surface?.widgetContainer &&
            parent === surface.widgetContainer;

        if (!widgetLayerOnTop || !isSelected || !inContainer)
            return;

        this._setWidgetEditMode(inst, true);
    }

    setInstancePinned(instanceId, pinned) {
        const inst = this._instances.get(instanceId);
        if (!inst || inst._isAddButton || inst._isGridToggleButton)
            return;

        const nextPinned = !!pinned;
        if (nextPinned && !inst.pinnable)
            return;

        if (inst.pinned === nextPinned)
            return;

        if (!nextPinned && inst.widgetEditMode)
            this._setWidgetEditMode(inst, false);

        if (!nextPinned) {
            this._pinnedWindowManager.unpinInstance(inst);
        } else if (!Number.isFinite(inst.pinnedGlobalX) ||
            !Number.isFinite(inst.pinnedGlobalY)) {
            const frame = this.getInstanceGlobalFrame(instanceId);
            if (frame) {
                inst.pinnedGlobalX = frame.x;
                inst.pinnedGlobalY = frame.y;
            }
        }

        inst.pinned = nextPinned;
        if (inst.kind === 'html' && inst.actor && inst.host)
            this._webWidgetContext.updateHtmlWidgetPinned(inst, nextPinned);

        this._attachInstanceToCorrectLayer(inst);

        const surface = this._surfaces.get(inst.monitorIndex);
        if (!nextPinned &&
            this._selectedInstanceId === instanceId &&
            !surface?.grid?.isWidgetContainerOnTop?.())
            this.clearSelectedInstance();


        this._stateChanged();
    }

    beginPinnedEdit(instanceId, editing = true) {
        const inst = this._instances.get(instanceId);
        if (!inst || !inst.pinnable)
            return;

        this.setWidgetEditMode(instanceId, !!editing);
    }

    onPinnedWindowCloseRequest(instanceId) {
        const inst = this._instances.get(instanceId);
        if (!inst?.pinned || !inst.widgetEditMode)
            return;

        this.beginPinnedEdit(instanceId, false);
    }

    beginPinnedWindowMove(instanceId, params = {}) {
        const inst = this._instances.get(instanceId);
        if (!inst || !inst.pinned || !inst.pinnable)
            return;

        this._pinnedWindowManager.beginPinnedWindowMove(instanceId, params);
    }

    getHostActionSpecsForInstance(instanceId, options = {}) {
        const inst = this._instances.get(instanceId);
        if (!inst)
            return [];

        const chromePolicy = this._normalizeChromePolicy(inst.chrome);

        return this._getChromeButtonSpecs()
            .filter(spec => spec.visible?.(inst, chromePolicy, options) ?? true)
            .map(spec => ({
                id: spec.id,
                cssName: spec.cssName,
                iconName: spec.iconName,
                tooltip: spec.getTooltip?.(inst, options) ?? spec.tooltip ?? '',
                classes: spec.getClasses?.(inst) ?? [],
            }));
    }

    activateHostAction(instanceId, actionId) {
        const inst = this._instances.get(instanceId);
        if (!inst)
            return false;

        this.selectInstance(instanceId);

        switch (actionId) {
        case 'prefs':
            this._openPreferencesForSelectedInstance();
            return true;
        case 'pin':
            this.setInstancePinned(instanceId, !inst.pinned);
            return true;
        case 'move':
            this.beginPinnedWindowMove(instanceId);
            return true;
        case 'close':
            this.deleteSelectedInstance();
            return true;
        default:
            return false;
        }
    }

    hasContentManagedChrome(instanceId) {
        const inst = this._instances.get(instanceId);
        if (!inst)
            return false;

        const chrome = inst.chrome && typeof inst.chrome === 'object'
            ? inst.chrome
            : {};

        return chrome.showCloseButton === false ||
            chrome.showPrefsButton === false ||
            chrome.showMoveButton === false ||
            chrome.showPinButton === false;
    }

    hasContentManagedPinnedMove(instanceId) {
        const inst = this._instances.get(instanceId);
        if (!inst)
            return false;

        const chrome = inst.chrome && typeof inst.chrome === 'object'
            ? inst.chrome
            : {};

        // showMoveButton=false means the widget owns pinned move UI. In that
        // mode the host suppresses overlay drag and expects widget content to
        // call beginPinnedWindowMove() from its own control or drag surface.
        return chrome.showMoveButton === false;
    }

    /**
     * Notify Preferences that widget state has changed.
     * Triggers async write to $XDG_DATA_HOME/<app-id>/widgets.json
     */
    _stateChanged() {
        if (this._suppressStateEvents || !this._preferences)
            return;

        const stateObj = this.exportState();
        this._preferences.widgetState = stateObj;
    }

    /**
     * Compute a per-instance Z index from the current GTK child order of each
     * widgetContainer. Lower index = deeper, higher index = closer to front.
     *
     * This does not mutate any internal state; it only observes the widget
     * hierarchy. Add buttons and non-widget actors are skipped.
     *
     * @returns {Map<string, number>} instanceId -> zIndex
     */
    _computeZIndexByInstanceId() {
        const zIndexByInstanceId = new Map();

        for (const surface of this._surfaces.values()) {
            const widgetContainer = surface.widgetContainer;
            if (!widgetContainer ||
                typeof widgetContainer.get_first_child !== 'function')
                continue;

            let child = widgetContainer.get_first_child();
            let i = 0;

            while (child) {
                const instanceId = child.widgetInstanceId;
                if (instanceId) {
                    const inst = this._instances.get(instanceId);
                    if (inst && !inst._isAddButton && !inst._isGridToggleButton) {
                        if (!zIndexByInstanceId.has(instanceId))
                            zIndexByInstanceId.set(instanceId, i);
                    }
                }

                if (!child.get_next_sibling)
                    break;

                child = child.get_next_sibling();
                i++;
            }
        }

        return zIndexByInstanceId;
    }

    /**
     * Return a list of content widget instances sorted for export:
     *   1) By monitorIndex (to keep per-monitor grouping stable).
     *   2) By stacking index within that monitor, derived from GTK.
     *
     * This does not change the instances or maps; it only sorts a local array.
     *
     * @param {Map<string, number>} zIndexByInstanceId
     * @returns {Array<object>} sorted instance objects
     */
    _sortedInstancesForExport(zIndexByInstanceId) {
        const instances = [];

        for (const inst of this._instances.values()) {
            if (inst._isAddButton || inst._isGridToggleButton)
                continue;

            instances.push(inst);
        }

        instances.sort((a, b) => {
            // First group by monitorIndex
            const ma = a.monitorIndex ?? 0;
            const mb = b.monitorIndex ?? 0;

            if (ma !== mb)
                return ma - mb;

            // Then by z-index within that monitor, derived from GTK
            const za = zIndexByInstanceId.has(a.instanceId)
                ? zIndexByInstanceId.get(a.instanceId)
                : -1;
            const zb = zIndexByInstanceId.has(b.instanceId)
                ? zIndexByInstanceId.get(b.instanceId)
                : -1;

            return za - zb;
        });

        return instances;
    }

    /**
     * Export the full current widget state as a JSON-compatible object.
     *
     * The saved schema is identical to loadState():
     * {
     *   version: 4,
     *   instances: [
     *     { instanceId, widgetId, kind, monitorIndex,
     *       normX, normY, width, height,
     *       pinnedGlobalX, pinnedGlobalY, config }
     *   ]
     * }
     * */
    exportState() {
        const zIndexByInstanceId = this._computeZIndexByInstanceId();
        const sortedInstances =
            this._sortedInstancesForExport(zIndexByInstanceId);

        const out = {
            version: WIDGETS_STATE_SCHEMA_VERSION,
            instances: [],
        };

        for (const inst of sortedInstances) {
            out.instances.push({
                instanceId: inst.instanceId,
                widgetId: inst.widgetId,
                monitorIndex: inst.monitorIndex,
                kind: inst.kind,
                normX: inst.normX,
                normY: inst.normY,
                width: inst.width,
                height: inst.height,
                pinnedGlobalX: Number.isFinite(inst.pinnedGlobalX)
                    ? inst.pinnedGlobalX
                    : null,
                pinnedGlobalY: Number.isFinite(inst.pinnedGlobalY)
                    ? inst.pinnedGlobalY
                    : null,
                config: inst.config ?? {},
                prefsUri: inst.prefsUri ?? null,
                hasPreferences: !!inst.hasPreferences,
                pinnable: !!inst.pinnable,
                chrome: this._normalizeChromePolicy(inst.chrome),
                hasBackend: !!inst.hasBackend,
                webConsent: inst.webConsent ?? null,
                backendConsent: inst.backendConsent ?? null,
                pinned: !!inst.pinned,
            });
        }

        return out;
    }

    async _migrateToCurrentVersion(state) {
        if (!state || typeof state !== 'object')
            return {version: WIDGETS_STATE_SCHEMA_VERSION, instances: []};

        const schemaVersion =
        Number.isFinite(state.version) ? state.version : 1;

        if (!Array.isArray(state.instances))
            state.instances = [];

        let migrated = false;

        if (schemaVersion < 2) {
        // v1 -> v2: instances gain hasBackend.
        // Compute it once from the widget manifest (descriptor) and persist.
        // Schema v2+: backend capability is stored per instance (hasBackend)
        // and is resolved once at creation or migration time.

            for (const instData of state.instances) {
                if (!instData || typeof instData !== 'object')
                    continue;

                let hasBackend = false;

                try {
                    // eslint-disable-next-line no-await-in-loop
                    const desc = await this._widgetRegistry.getDescriptor(
                        instData.widgetId
                    );

                    hasBackend = !!desc?.hasBackend;
                } catch (e) {
                // If registry lookup fails, default false (safe).
                    hasBackend = false;
                }

                instData.hasBackend = hasBackend;
                migrated = true;
            }

            state.version = 2;
            migrated = true;
        }

        if (schemaVersion < 3) {
            for (const instData of state.instances) {
                if (!instData || typeof instData !== 'object')
                    continue;

                instData.pinned = !!instData.pinned;
            }

            state.version = 3;
            migrated = true;
        }

        if (schemaVersion < 4) {
            for (const instData of state.instances) {
                if (!instData || typeof instData !== 'object')
                    continue;

                instData.pinnedGlobalX =
                    Number.isFinite(instData.pinnedGlobalX)
                        ? instData.pinnedGlobalX
                        : null;
                instData.pinnedGlobalY =
                    Number.isFinite(instData.pinnedGlobalY)
                        ? instData.pinnedGlobalY
                        : null;
            }

            state.version = 4;
            migrated = true;
        }

        if (migrated && this._preferences) {
        // Persist the migrated file state as-is (do NOT call exportState() here).
            this._preferences.widgetState = state;
        }

        return state;
    }


    // =====================================================================
    // Internal helpers
    // =====================================================================
    _createInstance(widgetId, monitorIndex, x, y, width, height,
        config = {}, kind, descriptor = null) {
        const surface = this._surfaces.get(monitorIndex);
        if (!surface) {
            console.error(
                `WidgetManager.createInstance:
                    unknown monitorIndex ${monitorIndex}`
            );
            return null;
        }

        const {grid} = surface;

        // Convert local coords to normalized using existing grid plumbing.
        // This uses normalizedWidth/Height internally.
        const [normX, normY] = grid.getNormalizedCoordinates(x, y);

        const instanceId = GLib.uuid_string_random();

        const instance = {
            instanceId,
            widgetId,
            monitorIndex,
            normX,
            normY,
            width,
            height,
            pinnedGlobalX: null,
            pinnedGlobalY: null,
            actor: null,
            config,
            kind,
            hasBackend: descriptor?.hasBackend ?? !!descriptor?.backend,
            prefsUri: descriptor?.prefs ?? null,
            hasPreferences: !!descriptor?.prefs,
            pinnable: descriptor?.pinnable === true,
            chrome: this._normalizeChromePolicy(null, descriptor?.chrome),
            pinned: false,
            widgetEditMode: false,
        };

        this._instances.set(instanceId, instance);
        return instance;
    }

    _rebuildSurfacesFrom(desktops) {
        const existingAddButtons = new Map();
        const existingGridToggleButtons = new Map();
        for (const inst of this._instances.values()) {
            if (inst._isAddButton)
                existingAddButtons.set(inst.monitorIndex, inst);
            else if (inst._isGridToggleButton)
                existingGridToggleButtons.set(inst.monitorIndex, inst);
        }

        for (const surface of this._surfaces.values())
            this._teardownSurface(surface);

        this._surfaces.clear();

        for (const grid of desktops) {
            if (!grid)
                continue;

            const monitorIndex = grid.monitorIndex;
            if (monitorIndex === undefined || monitorIndex === null)
                continue;

            const widgetContainer = grid.widgetContainer;
            if (!widgetContainer) {
                console.error(
                    `WidgetManager: grid for monitorIndex ${monitorIndex
                    } is missing widgetContainer`
                );
                continue;
            }

            const surface = {
                grid,
                widgetContainer,
                monitorIndex,
                addButton: null,
                gridToggleButton: null,
            };

            this._surfaces.set(monitorIndex, surface);

            const existingAddInst = existingAddButtons.get(monitorIndex);
            this._ensureAddWidgetButton(surface, existingAddInst);
            const existingGridToggleInst =
                existingGridToggleButtons.get(monitorIndex);
            this._ensureGridToggleButton(surface, existingGridToggleInst);
        }
    }

    _teardownSurface(surface) {
        if (!surface)
            return;

        if (surface.addButton) {
            const parent = surface.addButton.get_parent?.();
            if (parent?.remove)
                parent.remove(surface.addButton);

            surface.addButton = null;
        }

        const addButtonInstanceId =
            this._getAddButtonInstanceId(surface.monitorIndex);
        const addInst = addButtonInstanceId
            ? this._instances.get(addButtonInstanceId)
            : null;
        if (addInst?._isAddButton)
            addInst.actor = null;
        else if (addButtonInstanceId)
            this._instances.delete(addButtonInstanceId);

        if (surface.gridToggleButton) {
            const parent = surface.gridToggleButton.get_parent?.();
            if (parent?.remove)
                parent.remove(surface.gridToggleButton);

            surface.gridToggleButton = null;
        }

        const gridToggleButtonInstanceId =
            this._getGridToggleButtonInstanceId(surface.monitorIndex);
        const gridToggleInst = gridToggleButtonInstanceId
            ? this._instances.get(gridToggleButtonInstanceId)
            : null;
        if (gridToggleInst?._isGridToggleButton)
            gridToggleInst.actor = null;
        else if (gridToggleButtonInstanceId)
            this._instances.delete(gridToggleButtonInstanceId);
    }

    _getAddButtonInstanceId(monitorIndex) {
        if (monitorIndex === undefined || monitorIndex === null)
            return null;
        return `__ding-add-button-${monitorIndex}`;
    }

    _getGridToggleButtonInstanceId(monitorIndex) {
        if (monitorIndex === undefined || monitorIndex === null)
            return null;
        return `__ding-widget-grid-toggle-button-${monitorIndex}`;
    }

    _ensureAddWidgetButton(surface, existingInst = null) {
        if (!surface?.widgetContainer)
            return;

        const instanceId = this._getAddButtonInstanceId(surface.monitorIndex);

        if (surface.addButton) {
            this._raiseAddButton(surface);
            return;
        }

        const button = new Gtk.Button();
        button.set_name('ding-widget-add-button');
        button.set_can_focus(false);
        button.set_focus_on_click(false);
        button.set_tooltip_text(_('Add Widget'));
        button.connect('clicked', () => {
            this.clearSelectedInstance();
            this.openAddWidgetDialog(
                null,
                surface.monitorIndex
            ).catch(logError);
        });

        const icon = Gtk.Image.new_from_icon_name('ding-list-add-symbolic');
        button.set_child(icon);

        button.widgetInstanceId = instanceId;

        surface.widgetContainer.put(button, 0, 0);
        surface.addButton = button;

        const inst = existingInst ?? {
            instanceId,
            widgetId: '__ding-add-button',
            monitorIndex: surface.monitorIndex,
            kind: 'chrome',
            normX: 0,
            normY: 0,
            width: 48,
            height: 48,
            actor: button,
            config: {},
            _isAddButton: true,
        };

        inst.actor = button;
        inst.monitorIndex = surface.monitorIndex;
        this._instances.set(instanceId, inst);

        if (!existingInst) {
            const [defaultX, defaultY] =
                this._getDefaultAddButtonPosition(surface, inst);

            this.setInstanceFrame(instanceId, defaultX, defaultY, inst.width,
                inst.height
            );
        } else {
            this._positionInstanceActor(inst);
        }
        this._updateAddWidgetButtonVisibility(surface);
        this._raiseAddButton(surface);
    }

    _ensureGridToggleButton(surface, existingInst = null) {
        if (!surface?.widgetContainer)
            return;

        const instanceId = this._getGridToggleButtonInstanceId(surface.monitorIndex);

        if (surface.gridToggleButton) {
            this._raiseGridToggleButton(surface);
            return;
        }

        const gridToggleButton = new Gtk.ToggleButton();
        gridToggleButton.set_name('ding-widget-grid-toggle-button');
        gridToggleButton.set_can_focus(false);
        gridToggleButton.set_focus_on_click(false);
        gridToggleButton.set_tooltip_text(_('Toggle Widget Grid'));

        const gridIcon = Gtk.Image.new_from_icon_name('ding-view-grid-symbolic');
        gridToggleButton.set_child(gridIcon);
        gridToggleButton.set_active(false);

        gridToggleButton.widgetInstanceId = instanceId;

        gridToggleButton.connect('toggled', btn => {
            this.clearSelectedInstance();
            surface.grid.widgetGridEnabled = btn.get_active();
            surface.grid.updateOverlay();
        });

        surface.widgetContainer.put(gridToggleButton, 0, 0);
        surface.gridToggleButton = gridToggleButton;

        const inst = existingInst ?? {
            instanceId,
            widgetId: '__ding-widget-grid-toggle-button',
            monitorIndex: surface.monitorIndex,
            kind: 'chrome',
            normX: 0,
            normY: 0,
            width: 48,
            height: 48,
            actor: gridToggleButton,
            config: {},
            _isGridToggleButton: true,
        };
        inst.actor = gridToggleButton;
        inst.monitorIndex = surface.monitorIndex;
        this._instances.set(instanceId, inst);

        if (!existingInst) {
            const [defaultX, defaultY] =
                this._getDefaultGridToggleButtonPosition(surface, inst);

            this.setInstanceFrame(instanceId, defaultX, defaultY, inst.width,
                inst.height
            );
        } else {
            this._positionInstanceActor(inst);
        }

        this._updateGridToggleButtonVisibility(surface);
        this._raiseGridToggleButton(surface);
    }

    _updateAddWidgetButtonVisibility(surface, forcedState = null) {
        if (!surface?.addButton)
            return;

        const shouldShow = typeof forcedState === 'boolean'
            ? forcedState
            : Boolean(surface.grid?.isWidgetContainerOnTop?.());

        surface.addButton.set_visible(shouldShow);
        surface.addButton.set_sensitive(shouldShow);
    }

    _updateGridToggleButtonVisibility(surface, forcedState = null) {
        if (!surface?.gridToggleButton)
            return;

        const shouldShow = typeof forcedState === 'boolean'
            ? forcedState
            : Boolean(surface.grid?.isWidgetContainerOnTop?.());

        surface.gridToggleButton.set_visible(shouldShow);
        surface.gridToggleButton.set_sensitive(shouldShow);
    }

    _raiseAddButton(surface) {
        if (!surface?.addButton || !surface.widgetContainer)
            return;

        const parent = surface.addButton.get_parent?.();
        if (!parent || parent !== surface.widgetContainer)
            return;

        try {
            surface.addButton.insert_before(parent, null);
        } catch (e) {
            console.error('WidgetManager: failed to raise add button:', e);
        }
    }

    _raiseGridToggleButton(surface) {
        if (!surface?.gridToggleButton || !surface.widgetContainer)
            return;

        const parent = surface.gridToggleButton.get_parent?.();
        if (!parent || parent !== surface.widgetContainer)
            return;

        try {
            surface.gridToggleButton.insert_before(parent, null);
        } catch (e) {
            console
            .error('WidgetManager: failed to raise grid toggle button:', e);
        }
    }

    _getDefaultAddButtonPosition(surface, inst) {
        const grid = surface.grid;
        if (!grid)
            return [0, 0];

        const width = grid.normalizedWidth;
        const height = grid.normalizedHeight;
        const buttonWidth = inst?.width ?? 48;
        const buttonHeight = inst?.height ?? 48;
        const margin = 32;

        const direction =
            surface.widgetContainer.get_direction?.() ?? Gtk.TextDirection.NONE;
        const isRTL = direction === Gtk.TextDirection.RTL;

        const maxX = Math.max(0, width - buttonWidth);
        const desiredX = isRTL
            ? width - buttonWidth - margin
            : margin;
        const x = Math.max(0, Math.min(desiredX, maxX));

        const maxY = Math.max(0, height - buttonHeight);
        const desiredY = height - buttonHeight - margin;
        const y = Math.max(0, Math.min(desiredY, maxY));

        return [x, y];
    }

    _getDefaultGridToggleButtonPosition(surface, inst) {
        const grid = surface.grid;
        if (!grid)
            return [0, 0];

        const addButtonInstanceId =
            this._getAddButtonInstanceId(surface.monitorIndex);

        const addButtonInst = addButtonInstanceId
            ? this._instances.get(addButtonInstanceId)
            : null;

        if (!addButtonInst)
            return [0, 0];


        const width = grid.normalizedWidth;
        const buttonWidth = inst?.width ?? 48;
        const buttonHeight = inst?.height ?? 48;
        const spacing = 16;

        const addButtonX = addButtonInst.normX * grid.normalizedWidth;
        const addButtonY = addButtonInst.normY * grid.normalizedHeight;

        const x = Math.max(0, Math.min(addButtonX, width - buttonWidth));
        const desiredY = addButtonY - buttonHeight - spacing;
        const y = Math.max(0, desiredY);

        return [x, y];
    }

    _detachInstancesWithoutSurface() {
        for (const inst of this._instances.values()) {
            if (inst?._isAddButton || inst?._isGridToggleButton)
                continue;

            const surface = this._surfaces.get(inst.monitorIndex);
            if (surface)
                continue;

            const parent = inst.actor?.get_parent?.();
            if (parent?.remove)
                parent.remove(inst.actor);

            this._pinnedWindowManager.destroyInstanceWindow(inst.instanceId);

            if (inst.host && typeof inst.host.destroy === 'function')
                inst.host.destroy();

            inst.actor = null;
            inst.host = null;
        }
    }

    async _reattachAllInstances(layoutChange = {}) {
        if (!this._preferences.showDesktopWidgets)
            return;

        const preservePinnedWindows =
            !!layoutChange?.gridschanged &&
            !layoutChange?.monitorschanged;

        for (const inst of this._instances.values()) {
            const surface = this._surfaces.get(inst.monitorIndex);

            if (!surface)
                continue;

            const preservePinnedWindow =
                preservePinnedWindows &&
                inst?.pinned &&
                this._pinnedWindowManager.hasInstance(inst.instanceId);

            // eslint-disable-next-line no-await-in-loop
            const created = await this._ensureInstanceActor(inst);

            if (!created)
                continue;

            if (preservePinnedWindow)
                this._pinnedWindowManager.refreshInstance(inst);
            else
                this._attachInstanceToCorrectLayer(inst);

            // Use optional chaining because requestRender()
            // currently exists only on HTML hosts.
            inst.host?.requestRender?.().catch(e => logError(e));
        }
    }

    _attachPinnedInstancesToCorrectLayer(monitorIndex, suspendFirst = false) {
        for (const inst of this._instances.values()) {
            if (inst?._isAddButton || inst?._isGridToggleButton)
                continue;

            if (inst.monitorIndex !== monitorIndex || !inst.pinned)
                continue;

            if (suspendFirst)
                this._pinnedWindowManager.destroyInstanceWindow(inst.instanceId);

            this._attachInstanceToCorrectLayer(inst);
        }
    }

    _cancelPendingPinnedWindowReload() {
        if (!this._pendingPinnedWindowReloadId)
            return;

        GLib.source_remove(this._pendingPinnedWindowReloadId);
        this._pendingPinnedWindowReloadId = 0;
    }

    async _reloadPinnedHtmlWidgetsInWindows(reason = 'window-remap') {
        if (!this._preferences.showDesktopWidgets)
            return;

        for (const inst of this._instances.values()) {
            if (!inst.pinned || inst.kind !== 'html' || !inst.host || !inst.actor)
                continue;

            const surface = this._surfaces.get(inst.monitorIndex);
            const widgetContainer = surface?.widgetContainer ?? null;
            const parent = inst.actor.get_parent() ?? null;
            if (!parent || parent === widgetContainer)
                continue;

            try {
                // eslint-disable-next-line no-await-in-loop
                await inst.host.reload();
            } catch (e) {
                console.error(
                    'WidgetManager: failed to reload pinned HTML widget after',
                    reason,
                    inst.instanceId,
                    e
                );
            }
        }
    }

    async _ensureInstanceActor(inst) {
        if (!this._preferences.showDesktopWidgets)
            return false;

        if (inst.actor)
            return true;

        const created = await this._createActorForInstance(inst);

        if (!created)
            return false;

        inst.actor.widgetInstanceId = inst.instanceId;
        return true;
    }

    async _createActorForInstance(inst) {
        const frame = this.getInstanceFrame(inst.instanceId);
        if (!frame)
            return false;

        // this can be re-entrant for html widgets due to consent checks
        if (inst.actor)
            return true;

        let actor = null;

        if (inst.kind === 'html') {
            const proceed = await this._checkConsentForInstance(inst);

            if (!proceed)
                return false;

            // this can be re-entrant for html widgets due to consent checks
            if (inst.actor)
                return true;

            const webCtx = this._ensureWebWidgetContext();
            const HostClass =
                inst.hasBackend ? HtmlWidgetHostWithBackend : HtmlWidgetHost;

            const host = new HostClass({
                instanceId: inst.instanceId,
                widgetId: inst.widgetId,
                frameRect: frame,
                mainApp: this._desktopManager.mainApp,
                widgetRegistry: this._widgetRegistry,
                webContext: webCtx,
            });

            inst.host = host;
            actor = host.actor;
        } else if (inst.kind === 'gtk') {
            actor = this._createGtkActorForInstance(inst, frame);
        } else {
            console.error(
                `WidgetManager: unknown widget kind for ${inst.widgetId}`
            );
        }

        if (!actor)
            return false;

        actor.set_name('ding-widget');
        actor.set_overflow(Gtk.Overflow.HIDDEN);
        actor.set_focusable(true);

        actor.instanceId = inst.instanceId;
        inst.actor = actor;
        return true;
    }

    async _checkConsentForInstance(inst) {
        if (inst._consentInProgress)
            return false;

        inst._consentInProgress = true;

        try {
            let updateState = false;
            let removeInstance = false;

            if (inst.webConsent !== true) {
                updateState = true;

                const ok = await this._askWebConsent(inst);

                if (!ok)
                    removeInstance = true;
                else
                    inst.webConsent = true;
            }

            if (inst.hasBackend &&
                inst.backendConsent !== true &&
                !removeInstance
            ) {
                updateState = true;

                const ok = await this._askBackendConsent(inst);

                if (!ok)
                    removeInstance = true;
                else
                    inst.backendConsent = true;
            }

            if (removeInstance)
                this._removeActor(inst.instanceId);

            // IMPORTANT: during loadState writes are suppressed, so if we changed
            // consent OR removed an instance, force a state write once.
            const stateDirty = updateState || removeInstance;

            if (stateDirty) {
                const previousSuppressionState = this._suppressStateEvents;
                this._suppressStateEvents = false;
                this._stateChanged();
                this._suppressStateEvents = previousSuppressionState;
            }

            return !removeInstance;
        } catch (e) {
            console.error('WidgetManager: _checkConsentForInstance failed:', e);
            return false;
        } finally {
            inst._consentInProgress = false;
        }
    }

    _removeActor(instanceId) {
        const inst = this._instances.get(instanceId);
        if (!inst)
            return;

        const parent = inst.actor?.get_parent?.();
        if (parent?.remove)
            parent.remove(inst.actor);

        this._pinnedWindowManager.destroyInstanceWindow(instanceId);

        if (inst.host && typeof inst.host.destroy === 'function')
            inst.host.destroy();

        if (this._webWidgetContext)
            this._webWidgetContext.forgetInstance(instanceId);

        if (typeof inst.actor?.destroy === 'function')
            inst.actor.destroy();

        this._instances.delete(instanceId);
        inst.actor = null;
    }

    _positionInstanceActor(inst) {
        if (!inst.actor)
            return;

        const surface = this._surfaces.get(inst.monitorIndex);
        if (!surface)
            return;

        const frame = this.getInstanceFrame(inst.instanceId);
        if (!frame)
            return;

        const {widgetContainer} = surface;
        const {x, y} = frame;
        const parent = inst.actor.get_parent();
        const isMove = parent === widgetContainer;

        if (frame.clamped || isMove) {
            const [normX, normY] = surface.grid.getNormalizedCoordinates(x, y);
            const EPSILON = 1e-4;

            if (Math.abs(inst.normX - normX) > EPSILON ||
                Math.abs(inst.normY - normY) > EPSILON) {
                inst.normX = normX;
                inst.normY = normY;
            }

            this._stateChanged();
        }

        if (isMove)
            widgetContainer.move(inst.actor, x, y);
        else if (!parent)
            widgetContainer.put(inst.actor, x, y);
    }

    _shouldAttachToDockLayer(inst) {
        if (!inst?.pinned)
            return false;

        const surface = this._surfaces.get(inst.monitorIndex);
        if (!surface)
            return false;

        const widgetLayerOnTop = surface.grid.isWidgetContainerOnTop();
        const result = !widgetLayerOnTop;
        return result;
    }

    _attachInstanceToCorrectLayer(inst) {
        if (!inst?.actor)
            return;

        // If the instance is selected and we're suppressing selection chrome,
        // don't do reattachment at all, the widget is being dragged.
        if (this._selectionChromeSuppressed &&
            inst.instanceId === this._selectedInstanceId)
            return;

        if (this._shouldAttachToDockLayer(inst)) {
            this._detachChromeIfSelectedInstance(inst.instanceId);
            this._pinnedWindowManager.pinInstance(inst);
            return;
        }

        this._pinnedWindowManager.destroyInstanceWindow(inst.instanceId);
        this._positionInstanceActor(inst);

        if (inst.instanceId === this._selectedInstanceId)
            this._attachChromeToInstance(inst);
    }

    _detachChromeIfSelectedInstance(instanceId) {
        if (this._selectedInstanceId !== instanceId)
            return;

        this._detachChrome();
    }

    _ensureChrome() {
        if (this._chrome)
            return;

        this._chrome = new Map();

        for (const spec of this._getChromeButtonSpecs()) {
            const button = new Gtk.Button();
            button.set_name(spec.cssName);
            button.set_can_focus(false);
            button.set_focus_on_click(false);
            button.set_child(Gtk.Image.new_from_icon_name(spec.iconName));

            if (spec.tooltip)
                button.set_tooltip_text(spec.tooltip);

            if (spec.id !== 'move')
                button.connect('clicked', spec.onClick.bind(this));
            this._chrome.set(spec.id, {button, spec});
        }
    }

    _attachChromeToInstance(inst) {
        if (!this._chrome)
            return;

        // Never attach to an instance that's being dragged.
        if (this._selectionChromeSuppressed &&
            inst?.instanceId === this._selectedInstanceId) {
            this._hideAllChromeButtons();
            return;
        }

        const surface = this._surfaces.get(inst.monitorIndex);
        if (!surface)
            return;

        const widgetLayerOnTop = surface.grid.isWidgetContainerOnTop();
        if (!widgetLayerOnTop) {
            this._hideAllChromeButtons();
            return;
        }

        const {widgetContainer} = surface;
        const frame = this.getInstanceFrame(inst.instanceId);
        if (!frame)
            return;

        let allocWidth = frame.width;
        const alloc = inst.actor?.get_allocation?.();
        if (alloc?.width > 0)
            allocWidth = alloc.width;

        const size = 28;
        const gap = 6;
        const margin = 8;

        const chromePolicy = this._normalizeChromePolicy(inst.chrome);
        const visibleButtons = this._getVisibleChromeButtons(
            inst,
            chromePolicy,
            {pinnedPopup: false}
        );
        const buttonCount = visibleButtons.length;

        if (buttonCount <= 0) {
            this._hideAllChromeButtons();
            return;
        }

        const totalWidth = buttonCount * size + (buttonCount - 1) * gap;

        const centerX = frame.x + allocWidth / 2;
        const buttonsX = centerX - totalWidth / 2;

        let yPos;
        const yPosUp = frame.y - size - margin;
        const yPosDown = frame.y + frame.height + margin;
        if (yPosUp < margin)
            yPos = yPosDown;
        else
            yPos = yPosUp;

        this._syncChromeButtonParents(widgetContainer);
        this._updateChromeButtonsForInstance(inst);

        for (const [index, chromeButton] of visibleButtons.entries()) {
            const buttonX = buttonsX + index * (size + gap);
            const parent = chromeButton.button.get_parent();

            if (!parent)
                widgetContainer.put(chromeButton.button, buttonX, yPos);
            else
                widgetContainer.move(chromeButton.button, buttonX, yPos);

            chromeButton.button.show();
        }

        this._hideInactiveChromeButtons(visibleButtons);

        this._raiseChromeButtons(surface);
    }

    _resolveChromeProperty(instanceValue, descriptorValue, defaultValue) {
        if (descriptorValue === false)
            return false;

        if (typeof instanceValue === 'boolean')
            return instanceValue;

        if (typeof descriptorValue === 'boolean')
            return descriptorValue;

        return defaultValue;
    }

    _normalizeChromePolicy(instanceChrome, descriptorChrome = null) {
        const instanceInput =
            instanceChrome && typeof instanceChrome === 'object'
                ? instanceChrome
                : {};
        const descriptorInput =
            descriptorChrome && typeof descriptorChrome === 'object'
                ? descriptorChrome
                : {};

        return {
            showCloseButton: this._resolveChromeProperty(
                instanceInput.showCloseButton,
                descriptorInput.showCloseButton,
                true
            ),
            showPrefsButton: this._resolveChromeProperty(
                instanceInput.showPrefsButton,
                descriptorInput.showPrefsButton,
                true
            ),
            showMoveButton: this._resolveChromeProperty(
                instanceInput.showMoveButton,
                descriptorInput.showMoveButton,
                true
            ),
            showPinButton: this._resolveChromeProperty(
                instanceInput.showPinButton,
                descriptorInput.showPinButton,
                false
            ),
        };
    }

    _getChromeButtonSpecs() {
        // Keep host chrome button names in the ding-widget-*-button form.
        // If a new host chrome button is added here, update
        // DesktopGrid._isWidgetChromeActor() so input handling continues to
        // distinguish host chrome from draggable widget actors.
        return [
            {
                id: 'prefs',
                cssName: 'ding-widget-prefs-button',
                iconName: 'ding-emblem-system-symbolic',
                tooltip: _('Widget preferences'),
                visible: (inst, chromePolicy) =>
                    !!inst.hasPreferences && !!chromePolicy.showPrefsButton,
                onClick: this._openPreferencesForSelectedInstance,
            },
            {
                id: 'pin',
                cssName: 'ding-widget-pin-button',
                iconName: 'ding-view-pin-symbolic',
                visible: (inst, chromePolicy) =>
                    !!inst.pinnable && !!chromePolicy.showPinButton,
                getTooltip: inst =>
                    inst.pinned ? _('Unpin widget') : _('Pin widget'),
                getClasses: inst => inst.pinned ? ['pinned'] : [],
                update: (button, inst) => {
                    if (inst.pinned)
                        button.add_css_class('pinned');
                    else
                        button.remove_css_class('pinned');

                    button.set_tooltip_text(
                        inst.pinned ? _('Unpin widget') : _('Pin widget')
                    );
                },
                onClick: this._togglePinnedForSelectedInstance,
            },
            {
                id: 'move',
                cssName: 'ding-widget-move-button',
                iconName: 'ding-move-symbolic',
                tooltip: _('Reposition widget'),
                visible: (inst, chromePolicy, options = {}) => {
                    if (!chromePolicy.showMoveButton)
                        return false;

                    if (options.pinnedPopup === true)
                        return !!inst.pinnable && !!inst.pinned;

                    return true;
                },
                onClick: this._beginPinnedWindowMoveForSelectedInstance,
            },
            {
                id: 'close',
                cssName: 'ding-widget-close-button',
                iconName: 'ding-window-close-symbolic',
                visible: (_inst, chromePolicy) => !!chromePolicy.showCloseButton,
                onClick: this.deleteSelectedInstance,
            },
        ];
    }

    _getChromeEntries() {
        if (!this._chrome)
            return [];

        return [...this._chrome.values()];
    }

    _getVisibleChromeButtons(inst, chromePolicy, options = {}) {
        return this._getChromeEntries().filter(
            ({spec}) => spec.visible?.(inst, chromePolicy, options) ?? true
        );
    }

    _syncChromeButtonParents(widgetContainer) {
        for (const {button} of this._getChromeEntries()) {
            const parent = button.get_parent();
            if (parent && parent !== widgetContainer)
                parent.remove(button);
        }
    }

    _updateChromeButtonsForInstance(inst) {
        for (const {button, spec} of this._getChromeEntries())
            spec.update?.(button, inst);
    }

    _hideInactiveChromeButtons(activeButtons = []) {
        const active = new Set(activeButtons.map(({button}) => button));

        for (const {button} of this._getChromeEntries()) {
            if (!active.has(button))
                button.hide();
        }
    }

    _hideAllChromeButtons() {
        for (const {button} of this._getChromeEntries())
            button.hide();
    }

    _detachChrome() {
        if (!this._chrome)
            return;

        for (const {button} of this._getChromeEntries()) {
            const parent = button.get_parent();
            if (parent)
                parent.remove(button);
        }
    }

    _raiseChromeButtons(surface) {
        if (!this._chrome || !surface?.widgetContainer)
            return;

        for (const {button} of this._getChromeEntries()) {
            const parent = button.get_parent?.();
            if (!parent || parent !== surface.widgetContainer)
                continue;

            try {
                button.insert_before(parent, null);
            } catch (e) {
                console.error('WidgetManager: failed to raise chrome button:', e);
            }
        }
    }

    _togglePinnedForSelectedInstance() {
        const selectedId = this._selectedInstanceId;
        const inst = selectedId
            ? this._instances.get(selectedId)
            : null;

        if (!inst)
            return;

        this.setInstancePinned(selectedId, !inst.pinned);
    }

    _openPreferencesForSelectedInstance() {
        const selectedId = this._selectedInstanceId;
        const inst = selectedId
            ? this._instances.get(selectedId)
            : null;

        if (!inst || !inst.hasPreferences) {
            console.warn('No widget selected or widget has no preferences UI.');
            return;
        }

        // Delegate everything to WebWidgetContext
        const webCtx = this._ensureWebWidgetContext();
        webCtx.openPreferencesForInstance(selectedId, inst.prefsUri);
    }

    _beginPinnedWindowMoveForSelectedInstance() {
        const selectedId = this._selectedInstanceId;
        if (!selectedId)
            return;

        this.beginPinnedWindowMove(selectedId);
    }

    _raiseInstance(inst) {
        if (!inst || !inst.actor)
            return;

        const surface = this._surfaces.get(inst.monitorIndex);
        if (!surface || !surface.widgetContainer)
            return;

        const parent = inst.actor.get_parent?.();
        if (!parent || parent !== surface.widgetContainer)
            return;

        try {
            inst.actor.insert_before(parent, null);
        } catch (e) {
            console.error('WidgetManager: failed to raise instance:', e);
        }

        this._raiseAddButton(surface);
        this._raiseGridToggleButton(surface);
    }

    _getWidgetKind(_widgetId) {
        // Stub for future GTK widgets. For now, everything is HTML.
        //
        return 'html';
    }

    _updateWidgetLayerChange(monitorIndex, onTop) {
        for (const inst of this._instances.values()) {
            if (inst.monitorIndex !== monitorIndex ||
                !inst.actor)
                continue;

            this._sendLayerStateToInstance(inst, onTop);
        }
    }

    _sendLayerStateToInstance(inst, onTop) {
        // ToDo: GTK Widget layer change;
        if (inst.kind === 'html' && inst.host)
            this._webWidgetContext.updateHtmlWidgetLayer(inst, onTop);
    }

    _updateWidgetsSelectionState() {
        for (const inst of this._instances.values()) {
            const selected = inst.instanceId === this._selectedInstanceId;
            // To Do: GTK Widget seleted state
            if (inst.kind === 'html' && inst.actor && inst.host) {
                inst.host.setKeyboardFocusable(selected);
                this._webWidgetContext.updateHtmlWidgetSelected(inst, selected);
            }
        }
    }

    _setWidgetEditMode(inst, editing) {
        if (!inst)
            return;

        const nextEditing = !!editing;
        if (!!inst.widgetEditMode === nextEditing)
            return;

        inst.widgetEditMode = nextEditing;
        this._updateWidgetsWidgetEditModeState();
        this._syncTextEntryAccelState();
    }

    _canKeepWidgetEditMode(inst) {
        if (!inst?.widgetEditMode)
            return false;

        const surface = this._surfaces.get(inst.monitorIndex);
        const widgetContainer = surface?.widgetContainer ?? null;
        const parent = inst.actor?.get_parent?.() ?? null;

        if (inst.pinned && parent && parent !== widgetContainer)
            return true;

        const widgetLayerOnTop = !!surface?.grid?.isWidgetContainerOnTop?.();
        return widgetLayerOnTop &&
            this._selectedInstanceId === inst.instanceId;
    }

    _clearInvalidWidgetEditModes() {
        let changed = false;

        for (const inst of this._instances.values()) {
            if (!inst?.widgetEditMode)
                continue;

            if (this._canKeepWidgetEditMode(inst))
                continue;

            inst.widgetEditMode = false;
            changed = true;
        }

        if (changed)
            this._updateWidgetsWidgetEditModeState();
    }

    _clearWidgetEditModeForMonitor(monitorIndex) {
        let changed = false;

        for (const inst of this._instances.values()) {
            if (inst.monitorIndex !== monitorIndex || !inst.widgetEditMode)
                continue;

            if (this._canKeepWidgetEditMode(inst))
                continue;

            inst.widgetEditMode = false;
            changed = true;
        }

        if (changed)
            this._updateWidgetsWidgetEditModeState();
    }

    _updateWidgetsWidgetEditModeState() {
        for (const inst of this._instances.values()) {
            if (inst.kind === 'html' && inst.actor && inst.host) {
                this._webWidgetContext.updateHtmlWidgetEditMode(
                    inst,
                    !!inst.widgetEditMode
                );
            }

            this._pinnedWindowManager.refreshInstance(inst);
        }
    }

    _syncTextEntryAccelState() {
        const layerRaised = [...this._surfaces.values()].some(
            surface => !!surface?.grid?.isWidgetContainerOnTop?.()
        );
        const floatingWidgetEditing = [...this._instances.values()].some(inst => {
            if (!inst?.widgetEditMode || !inst.pinned || !inst.actor)
                return false;

            const surface = this._surfaces.get(inst.monitorIndex);
            const widgetContainer = surface?.widgetContainer ?? null;
            return inst.actor.get_parent?.() !== widgetContainer;
        });

        const shouldSuppress = layerRaised || floatingWidgetEditing;
        if (shouldSuppress === this._textEntryAccelsSuppressedForWidgets)
            return;

        this._textEntryAccelsSuppressedForWidgets = shouldSuppress;
        this._desktopManager.mainApp?.activate_action?.(
            shouldSuppress ? 'textEntryAccelsTurnOff' : 'textEntryAccelsTurnOn',
            null
        );
    }

    _updateTheme(inst, theme) {
        // To Do: GTK Widget layer change
        if (inst.kind === 'html' && inst.actor && inst.host)
            this._webWidgetContext.updateHtmlWidgetTheme(inst, theme);
    }

    _updateAnimation(inst, reducedMotion) {
        // To Do : Gtk Widget layer change
        if (inst.kind === 'html' && inst.actor && inst.host)
            this._webWidgetContext.updateHtmlWidgetAnimation(inst, reducedMotion);
    }

    _getLocale() {
        try {
            const langs = GLib.get_language_names?.();
            if (langs && langs.length)
                return langs[0];
        } catch (e) {
            // ignore
        }

        return 'en_US';
    }

    _getDirectionForActor(actor) {
        let direction = 'ltr';

        try {
            if (actor && typeof actor.get_direction === 'function') {
                const dir = actor.get_direction();
                if (dir === Gtk.TextDirection.RTL)
                    direction = 'rtl';
            }
        } catch (e) {
            // ignore
        }

        return direction;
    }

    computeHostStateForInstance(inst) {
        const actor = inst.actor;
        const selected = inst.instanceId === this._selectedInstanceId;
        const pinned = !!inst.pinned;
        const widgetEditMode = !!inst.widgetEditMode;
        const pinnable = !!inst.pinnable;
        const hostChromeVisible = !!inst.hostChromeVisible;

        const surface = this._surfaces.get(inst.monitorIndex);
        const grid = surface?.grid;

        const editMode = !!grid?.isWidgetContainerOnTop?.();
        const theme = this._preferences.darkmode ? 'dark' : 'light';
        const reducedMotion = !this._preferences.globalAnimations;
        const locale = this._getLocale();
        const direction = this._getDirectionForActor(actor);

        return {
            editMode,
            widgetEditMode,
            selected,
            pinned,
            hostChromeVisible,
            pinnable,
            theme,
            reducedMotion,
            direction,
            locale,
        };
    }

    updatePinnedHostChromeVisible(instanceId, hostChromeVisible) {
        const inst = this._instances.get(instanceId);
        if (!inst)
            return;

        const nextVisible = !!hostChromeVisible;
        if (!!inst.hostChromeVisible === nextVisible)
            return;

        inst.hostChromeVisible = nextVisible;
        if (inst.kind === 'html' && inst.actor && inst.host)
            this._webWidgetContext.updateHtmlWidgetHostChromeVisible(inst, nextVisible);
    }

    /* ====================================================================
     * --- IGNORE ---
     * GTK widget support stub (future)
     * --- IGNORE ---
     * ===================================================================== */

    _createGtkActorForInstance(inst, _frame) {
        // GTK stub for later: we could create a native Gtk.Widget here, e.g.:
        console.warn(
            `WidgetManager: GTK widget kind requested for ${inst.widgetId}, ` +
            'but GTK widget support is not implemented yet'
        );
        return null;
    }

    /* ====================================================================
     * WebKit WebContext HTML widget support
     * ===================================================================== */
    _ensureWebWidgetContext() {
        if (!this._webWidgetContext) {
            this._webWidgetContext =
                new WebWidgetContext(this._desktopManager, this);
        }

        return this._webWidgetContext;
    }


    _stopWebkitIfUnneeded() {
        if (!this._webWidgetContext)
            return;

        // We prune aggressively, there may be no host, add button has
        // no isAlive(). Look only for html hosts
        const hasHtmlWidget =
            Array.from(this._instances.values())
                .some(inst => inst.host?.isAlive?.());

        if (hasHtmlWidget)
            return;

        this._webWidgetContext.destroy();
        this._webWidgetContext = null;
    }

    /* =====================================================================
     * Widget Picker UI
     * ===================================================================== */

    async openAddWidgetDialog(parentWindow = null, monitorIndex = null) {
        if (!this._widgetRegistry) {
            console.error('openAddWidgetDialog: widgetRegistry missing');
            return null;
        }

        this._widgetRegistry.reload();

        let widgets;
        try {
            widgets = await this._widgetRegistry.listWidgets();
        } catch (e) {
            console.error('openAddWidgetDialog: listWidgets failed:', e);
            return null;
        }

        // Sort by display name
        widgets.sort((a, b) => {
            const nameA = (a.name || a.id || '').toLowerCase();
            const nameB = (b.name || b.id || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });

        if (Number.isInteger(monitorIndex))
            parentWindow = this.getSurfaceWindow(monitorIndex) ?? parentWindow;

        const cancellable = this._getDownloadCancellable();

        const {window, list, addButton, cancelButton, downloadButton} =
            this._createWidgetPickerWindow(parentWindow, widgets, cancellable);

        const resultPromise = new Promise(resolve => {
            let creationInProgress = false;
            let reopeningAfterDownload = false;

            cancelButton.connect('clicked', () => {
                window.close();
            });

            downloadButton.connect('clicked', async () => {
                try {
                    const didInstall = await this.downloadLatestWidgets(
                        parentWindow,
                        cancellable
                    );

                    if (didInstall) {
                        reopeningAfterDownload = true;
                        resolve(null);
                        window.close();
                        this.openAddWidgetDialog(parentWindow, monitorIndex)
                            .catch(logError);
                    }
                } catch (e) {
                    logError(e);
                }
            });

            addButton.connect('clicked', async () => {
                if (creationInProgress)
                    return;

                const row = list.get_selected_row();
                if (!row || !row._widgetId) {
                    window.close();
                    resolve(null);
                    return;
                }

                creationInProgress = true;
                window.close();

                let created = null;
                try {
                    created = await this.createInstanceForWidget(row._widgetId, {
                        monitorIndex,
                    });
                } catch (e) {
                    console.error(
                        'openAddWidgetDialog: createInstanceForWidget failed:',
                        e
                    );
                }

                resolve(created);
            });

            // Double-clicking a row also activates "Add"
            list.connect('row-activated', () => {
                addButton.activate();
            });

            // If user closes via window close button / Esc
            window.connect('close-request', () => {
                cancellable.cancel();

                if (reopeningAfterDownload)
                    return false;

                if (!creationInProgress)
                    resolve(null);

                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this.restoreWidgetLayerFocus(monitorIndex);
                    return GLib.SOURCE_REMOVE;
                });
                return false; // allow close
            });

            const shortcutController = new Gtk.ShortcutController({
                propagation_phase: Gtk.PropagationPhase.CAPTURE,
            });

            shortcutController.add_shortcut(new Gtk.Shortcut({
                trigger: Gtk.ShortcutTrigger.parse_string('Escape'),
                action: Gtk.CallbackAction.new(() => {
                    window.close();
                    return true;
                }),
            }));
            window.add_controller(shortcutController);
        });

        window.present();
        const createdInstance = await resultPromise;
        return createdInstance;
    }

    _createWidgetPickerWindow(parentWindow, widgets) {
        const builder =
            Gtk.Builder
            .new_from_resource('/com/desktop/ding/ui/ding-widget-chooser.ui');

        /** @type {Adw.Window} */
        const window = builder.get_object('widget_picker_window');
        /** @type {Gtk.ListBox} */
        const list = builder.get_object('widget_list');
        /** @type {Gtk.Button} */
        const addButton = builder.get_object('add_button');
        /** @type {Gtk.Button} */
        const cancelButton = builder.get_object('cancel_button');
        /** @type {Gtk.Button} */
        const downloadButton = builder.get_object('download_button');

        if (parentWindow)
            window.set_transient_for(parentWindow);

        // Populate rows from registry
        for (const [index, desc] of widgets.entries()) {
            const row = this._createWidgetRow(desc, index);
            list.append(row);
        }

        // Select first by default
        const firstRow = list.get_row_at_index(0);
        if (firstRow)
            list.select_row(firstRow);

        return {window, list, addButton, cancelButton, downloadButton};
    }

    _createWidgetRow(desc, index = 0) {
        const row = new Gtk.ListBoxRow();
        row._widgetId = desc.id;
        row.add_css_class('widget-picker-row');
        if (index % 2 === 1)
            row.add_css_class('widget-picker-row-alt');

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
        });

        const titleLabel = new Gtk.Label({
            label: `<b>${GLib.markup_escape_text(
                desc.name,
                ENTIRE_STRING_LENGTH
            )}</b>`,
            use_markup: true,
            xalign: 0,
        });

        const descriptionText = desc.description;
        const descriptionLabel = new Gtk.Label({
            label: descriptionText,
            xalign: 0,
            hexpand: true,
            halign: Gtk.Align.FILL,
            wrap: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            max_width_chars: 58,
        });
        descriptionLabel.add_css_class('dim-label');

        const subtitleParts = [];

        if (desc.kind) {
            if (desc.kind === 'html')
                subtitleParts.push(_('HTML widget'));
            else if (desc.kind === 'gtk')
                subtitleParts.push(_('GTK widget'));
            else
                subtitleParts.push(desc.kind);
        }

        subtitleParts.push(
            desc.isUser ? _('User Installed') : _('System Installed')
        );

        const subtitle = subtitleParts.join(' · ');

        const subtitleLabel = new Gtk.Label({
            label: subtitle,
            xalign: 0,
        });
        subtitleLabel.add_css_class('dim-label');

        box.append(titleLabel);
        box.append(descriptionLabel);
        if (subtitle)
            box.append(subtitleLabel);

        row.set_child(box);
        return row;
    }

    async downloadLatestWidgets(parentWindow = null, cancellable = null) {
        const confirmed = await this._asyncAskYesNo(
            _('Download Latest Widgets from Repository?'),
            _(
                'This will overwrite all widgets in your local widgets folder.'
            ),
            false,
            parentWindow,
            cancellable
        ).catch(e => {
            logError(e);
            return false;
        });

        if (!confirmed)
            return false;

        const appDataDir = this._desktopIconsUtil.getAppUserDataDir();
        const archiveUrl = this.Enums.WIDGETS_DOWNLOAD_URL;
        const tempRootDir = appDataDir.get_child(
            `widgets.download.${Date.now()}.${Math.floor(Math.random() * 1e9)}`
        );
        const extractDir = tempRootDir.get_child('extract');
        const liveDir = appDataDir.get_child('widgets');
        const backupDir = appDataDir.get_child('widgets.backup');

        try {
            await FileUtils.recursivelyMakeDir(tempRootDir, cancellable);
            await FileUtils.recursivelyMakeDir(extractDir, cancellable);

            const archiveData = await WebUtils.downloadBytes(
                archiveUrl,
                30,
                cancellable
            );
            const archiveFile = tempRootDir.get_child('widgets.tar.gz');
            await WebUtils.writeBytesToFile(
                archiveFile,
                archiveData.bytes,
                cancellable
            );
            try {
                await this._desktopManager.autoAr.extractArchiveToFolder(
                    archiveFile.get_path(),
                    extractDir,
                    cancellable
                );
            } catch (e) {
                if (e?.message !== 'AutoAr is not installed')
                    throw e;

                await WebUtils.extractTarGzArchive(
                    archiveFile,
                    extractDir,
                    cancellable
                );
            }

            const sourceWidgetsDir =
                await FileUtils.findChildDirRecursive(
                    extractDir,
                    'widgets',
                    cancellable
                );
            if (!sourceWidgetsDir)
                throw new Error('Downloaded archive did not contain a widgets folder');

            if (await FileUtils.queryExists(backupDir, cancellable)) {
                await FileUtils.recursivelyDeleteDir(
                    backupDir,
                    true,
                    cancellable
                );
            }

            if (cancellable.is_cancelled())
                return false;

            if (await FileUtils.queryExists(liveDir))
                await FileUtils.moveFile(liveDir, backupDir);

            try {
                await FileUtils.moveFile(sourceWidgetsDir, liveDir);
            } catch (moveError) {
                if (await FileUtils.queryExists(backupDir)) {
                    try {
                        await FileUtils.moveFile(backupDir, liveDir);
                    } catch (restoreError) {
                        console.error(
                            'downloadLatestWidgets: failed to restore widgets backup:',
                            restoreError
                        );
                    }
                }
                throw moveError;
            } finally {
                // `widgets.backup` is temporary rollback state and should never linger.
                if (await FileUtils.queryExists(backupDir))
                    await FileUtils.recursivelyDeleteDir(backupDir, true);
            }

            this._widgetRegistry.reload();
            this._desktopManager.dbusManager?.doNotify(
                _('Widgets updated'),
                _('The latest widgets were downloaded and installed.')
            );
            return true;
        } catch (e) {
            if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return false;
            console.error('downloadLatestWidgets: install failed:', e);
            this._desktopManager.dbusManager?.doNotify(
                _('Widgets download failed'),
                e?.message ?? String(e)
            );
            return false;
        } finally {
            try {
                if (await FileUtils.queryExists(tempRootDir))
                    await FileUtils.recursivelyDeleteDir(tempRootDir, true);
            } catch (e) {
                // ignore cleanup failures
            }
        }
    }

    _getDownloadCancellable() {
        if (!this._downloadCancellable?.is_cancelled?.())
            return this._downloadCancellable;

        this._downloadCancellable = new Gio.Cancellable();
        return this._downloadCancellable;
    }

    _addActions() {
        const addWidgetAction = Gio.SimpleAction.new('addWidget', null);
        addWidgetAction.connect('activate', () => {
            const parentWindow =
                this._desktopManager.getDialogParentWindow();
            if (!parentWindow)
                return;

            this.clearSelectedInstance();

            const monitorIndex = this.getMonitorIndexForWindow(parentWindow);

            // Ensure widget layers are visible before adding a widget.
            this._desktopManager.windowManager?.raiseWidgetLayers();

            this.openAddWidgetDialog(parentWindow, monitorIndex)
                .catch(logError);
        });
        this._desktopManager.mainApp.add_action(addWidgetAction);

        const showGridAction = Gio.SimpleAction.new('toggleWidgetGrid', null);
        showGridAction.connect('activate', () => {
            const parentWindow = this._desktopManager.getDialogParentWindow();
            if (!parentWindow)
                return;

            const parentSurfaceWindow = parentWindow;
            const monitorIndex = this.getMonitorIndexForWindow(parentSurfaceWindow);

            if (monitorIndex === null)
                return;

            let gridToggleButton = null;
            const instanceId =
                this._getGridToggleButtonInstanceId(monitorIndex);

            const inst = instanceId ? this._instances.get(instanceId) : null;
            gridToggleButton = inst && inst.actor ? inst.actor : null;

            if (!gridToggleButton)
                return;

            this.clearSelectedInstance();

            // Ensure widget layers are visible before showingt widget grid.
            this._desktopManager.windowManager?.raiseWidgetLayers();
            gridToggleButton.activate();
        });
        this._desktopManager.mainApp.add_action(showGridAction);

        const closeWidget = Gio.SimpleAction.new('closeWidget', null);
        closeWidget.connect('activate', this.deleteSelectedInstance.bind(this));
        this._desktopManager.mainApp.add_action(closeWidget);

        const updatePinnedWindowPosition = Gio.SimpleAction.new(
            'updatePinnedWindowPosition',
            new GLib.VariantType('(sii)')
        );
        updatePinnedWindowPosition.connect('activate', (_action, parameter) => {
            if (!parameter)
                return;

            const [instanceId, x, y] = parameter.deepUnpack();
            this.updatePinnedWindowPosition(instanceId, x, y);
        });
        this._desktopManager.mainApp.add_action(updatePinnedWindowPosition);
    }

    /* =====================================================================
     * Widget Consent UI
     * ===================================================================== */

    _asyncAskYesNo(
        heading,
        body,
        bodyUseMarkup = false,
        parentWindow = null,
        cancellable = null
    ) {
        if (cancellable?.is_cancelled())
            return Promise.resolve(false);

        const anchorParent =
            parentWindow ?? this._desktopManager.getDialogParentWindow();
        const yesLabel = _('Allow');
        const noLabel = _('Cancel');

        return new Promise(resolve => {
            const dlg = new Adw.AlertDialog();
            let cancelId = 0;

            dlg.set_presentation_mode(Adw.DialogPresentationMode.FLOATING);
            dlg.set_follows_content_size(false);
            dlg.set_content_width(500);

            dlg.set_heading(heading);
            dlg.set_body_use_markup(bodyUseMarkup);
            dlg.set_body(body);
            dlg.add_response('no', noLabel);
            dlg.add_response('yes', yesLabel);
            dlg.set_default_response('no');
            dlg.set_close_response('no');
            if (typeof dlg.set_prefer_wide_layout === 'function')
                dlg.set_prefer_wide_layout(true);

            dlg.set_response_appearance(
                'yes',
                Adw.ResponseAppearance.SUGGESTED
            );

            dlg.set_response_appearance(
                'no',
                Adw.ResponseAppearance.DEFAULT
            );

            const shortcutController = new Gtk.ShortcutController({
                propagation_phase: Gtk.PropagationPhase.CAPTURE,
            });
            shortcutController.add_shortcut(new Gtk.Shortcut({
                trigger: Gtk.ShortcutTrigger.parse_string('Escape'),
                action: Gtk.CallbackAction.new(() => {
                    dlg.close();
                    return true;
                }),
            }));
            dlg.add_controller(shortcutController);

            if (cancellable) {
                cancelId = cancellable.connect(() => {
                    dlg.close();
                });
            }

            dlg.connect('response', (_d, response) => {
                if (cancelId && cancellable)
                    cancellable.disconnect(cancelId);

                resolve(response === 'yes');
            });

            dlg.present(anchorParent);
        });
    }

    _describeCspProfileForHumans() {
        const profile = this.Enums?.DEFAULT_CSP_PROFILE;

        if (profile === this.Enums?.CspProfile?.STRICT) {
            return {
                name: _('Strict'),
                summary: _(
                    'The widget runs in a tightly sandboxed web environment.\n\n' +
                '• No external scripts or frames are allowed.\n' +
                '• Network access is limited to secure (HTTPS) requests.\n' +
                '• Only the widget’s own files and inline code may run.\n\n' +
                'This is the safest option and is recommended for most widgets.'
                ),
            };
        }

        if (profile === this.Enums?.CspProfile?.RELAXED) {
            return {
                name: _('Relaxed'),
                summary: _(
                    'The widget is allowed broader web capabilities.\n\n' +
                '• External scripts, styles, images, and frames from trusted websites may load.\n' +
                '• Network access over HTTPS, WebSockets, and media streams is allowed.\n\n' +
                'Use this only for widgets you trust.'
                ),
            };
        }

        if (profile === this.Enums?.CspProfile?.DEV) {
            return {
                name: _('Development'),
                summary: _(
                    'The widget runs with development-friendly web access.\n\n' +
                '• Connections to local development servers (localhost) are allowed.\n' +
                '• HTTP and WebSocket access may be permitted for testing.\n\n' +
                'This mode is intended for development and debugging only.'
                ),
            };
        }

        return {
            name: String(profile ?? _('Default')),
            summary: _(
                'The widget runs with a predefined web security policy.\n\n' +
            'Web access and capabilities are restricted according to the active policy.'
            ),
        };
    }

    async _askWebConsent(inst) {
        const widgetId = inst.widgetId;
        const heading = _('Allow web content for {widgetId}?')
            .replace('{widgetId}', widgetId);
        const cspProfile = this._describeCspProfileForHumans();
        const cspProfileName = GLib.markup_escape_text(
            cspProfile.name,
            ENTIRE_STRING_LENGTH
        );
        const cspProfileSummary = GLib.markup_escape_text(
            cspProfile.summary,
            ENTIRE_STRING_LENGTH
        );
        const body =
            // eslint-disable-next-line prefer-template
            _('The widget you are adding may load web content from the internet.\n\n') +
            _('This content is subject to the widget security policy:\n\n') +
            `<span weight="ultrabold">${cspProfileName}</span>\n` +
            `${cspProfileSummary}`;
        const parentWindow = this.getSurfaceWindow(inst.monitorIndex);


        const answer = await this._asyncAskYesNo(
            heading,
            body,
            true,
            parentWindow,
            this._getDownloadCancellable()
        );

        return answer;
    }

    async _askBackendConsent(inst) {
        const widgetId = inst.widgetId;
        let argvStr = '';

        try {
            const desc = await this._widgetRegistry.getDescriptor(inst.widgetId);
            const spec = this._widgetRegistry.normalizeBackendSpec(desc, inst);

            if (spec?.argv?.length) {
                argvStr = spec.argv.map(a =>
                    /[\s"]/g.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a
                ).join(' ');
            }
        } catch (e) {
            // If we can’t resolve spec, keep message generic.
            argvStr = '';
        }

        const body =
        _('This widget, {widgetId} runs a background process on your computer.\n\n')
            .replace('{widgetId}', widgetId) +
        _('The backend runs with your normal user permissions, just like any other application you start.\n') +
        _('It can access your files, system resources, and the network according to your user account permissions.\n\n') +
        (argvStr
            ? `<b>${GLib.markup_escape_text(
                _('Command:'),
                ENTIRE_STRING_LENGTH
            )}</b>\n` +
              `${GLib.markup_escape_text(
                  argvStr,
                  ENTIRE_STRING_LENGTH
              )}\n\n`
            : '') +
        _('Only allow this for widgets you implicitly trust.');
        const parentWindow = this.getSurfaceWindow(inst.monitorIndex);

        const answer = await this._asyncAskYesNo(
            _('Allow widget backend?'),
            body,
            true,
            parentWindow,
            this._getDownloadCancellable()
        );

        return answer;
    }
};
