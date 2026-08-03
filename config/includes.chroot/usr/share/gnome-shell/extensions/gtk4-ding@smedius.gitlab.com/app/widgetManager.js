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

import {Adw, Gio, GLib, Gtk} from '../dependencies/gi.js';
import {_} from '../dependencies/gettext.js';
import {WidgetRegistry} from '../dependencies/localFiles.js';
import {HtmlWidgetHost, HtmlWidgetHostWithBackend} from '../dependencies/localFiles.js';
import {WebWidgetContext} from '../dependencies/localFiles.js';

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
 *       * width, height (absolute pixels, widget-owned)
 *   - On layout changes, we rebuild a map of:
 *       monitorIndex -> { grid, widgetContainer }
 *   - To place an instance:
 *       localX = normX * grid.normalizedWidth
 *       localY = normY * grid.normalizedHeight
 *       widgetContainer.put(actor, localX, localY)
 */
export {WidgetManager};

const WIDGETS_STATE_SCHEMA_VERSION = 2;

const WidgetManager = class {
    constructor(desktopManager) {
        this._desktopManager = desktopManager;
        this.Enums = desktopManager.Enums;
        this._preferences = desktopManager.Prefs;
        this._desktopIconsUtil = desktopManager.DesktopIconsUtil;
        this._widgetRegistry = new WidgetRegistry(this._desktopIconsUtil);

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
        this._selectedWidget = null;
        this._chrome = null;
        this.closeButton = null;
        this.prefsButton = null;
        this._selectedInstanceId = null;
        this._webWidgetContext = null;

        // When true, suppress emitting stateChanged events
        this._suppressStateEvents = false;
        this._loadStatePromise = null;
        this._pendingLoadState = null;

        this._addActions();

        // loadState is handled during startup and by Preferences; avoid
        // overlapping loads during construction.
    }

    clearFromGrids() {
        for (const inst of this._instances.values()) {
            const parent = inst.actor?.get_parent?.();
            if (parent?.remove)
                parent.remove(inst.actor);
        }

        for (const surface of this._surfaces.values())
            this._teardownSurface(surface);

        this._surfaces.clear();
    }

    stopWidgetDisplay() {
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
        await this._reattachAllInstances();
        this._stopWebkitIfUnneeded();
    }

    handleWidgetContainerLayerChange(monitorIndex, onTop) {
        const surface = this._surfaces.get(monitorIndex);
        if (!surface)
            return;

        this._updateAddWidgetButtonVisibility(surface, onTop);
        this._updateGridToggleButtonVisibility(surface, onTop);
        this._raiseAddButton(surface);
        this._raiseGridToggleButton(surface);
        this._updateWidgetLayerChange(monitorIndex, onTop);

        if (!onTop) {
            if (surface.gridToggleButton) {
                surface.gridToggleButton.set_active(false);
            }
            
            surface.grid.widgetGridEnabled = false;
            surface.grid.updateOverlay();
        }
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
            descriptor?.defaultConfig ?? {},
            kind,
            descriptor
        );

        if (!instance)
            return null;

        const created = await this._ensureInstanceActor(instance);

        if (!created)
            return null;

        this._positionInstanceActor(instance);

        // Persist creation
        this._stateChanged();

        return instance;
    }

    removeInstance(instanceId) {
        this._removeActor(instanceId);
        this._stateChanged();
    }

    deleteSelectedInstance() {
        if (!this._selectedInstanceId)
            return false;

        const toRemove = this._selectedInstanceId;

        // Clear selection first so CSS + chrome are detached.
        this.selectInstance(null);
        this.removeInstance(toRemove);

        this._stopWebkitIfUnneeded();

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

        this._positionInstanceActor(inst);
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

    get instances() {
        return this._instances;
    }

    getInstance(instanceId) {
        return this._instances.get(instanceId) || null;
    }

    getSelectedInstanceId() {
        return this._selectedInstanceId;
    }

    clearSelectedInstance() {
        const oldInst = this._instances.get(this._selectedInstanceId);

        if (oldInst?.actor) {
            const ctx = oldInst.actor.get_style_context();
            ctx.remove_class('ding-widget-selected');
        }

        this._selectedInstanceId = null;
        this._detachChrome();
        this._updateWidgetsSelectionState();
    }

    selectInstance(instanceId) {
        if (this._selectedInstanceId &&
            this._selectedInstanceId !== instanceId
        ) {
            const oldInst = this._instances.get(this._selectedInstanceId);
            if (oldInst?.actor) {
                const ctx = oldInst.actor.get_style_context();
                ctx.remove_class('ding-widget-selected');
                this._webWidgetContext?.closePreferencesIfAny();
            }
        }

        this._selectedInstanceId = instanceId || null;

        if (!instanceId) {
            this._detachChrome();
            this._updateWidgetsSelectionState();
            this._webWidgetContext?.closePreferencesIfAny();
            return;
        }

        const inst = this._instances.get(instanceId);
        if (!inst?.actor || inst._isAddButton || inst._isGridToggleButton) {
            this._selectedInstanceId = null;
            this._detachChrome();
            this._updateWidgetsSelectionState();
            this._webWidgetContext?.closePreferencesForInstance();
            return;
        }

        const ctx = inst.actor.get_style_context();
        ctx.add_class('ding-widget-selected');

        this._raiseInstance(inst);

        if (typeof inst.actor.grab_focus === 'function')
            inst.actor.grab_focus();

        this._ensureChrome();
        this._attachChromeToInstance(inst);
        this._updateWidgetsSelectionState();
    }

    hideSelectionChromeDuringDrag() {
        if (this._chrome) {
            for (const btn of this._chrome)
                btn.hide();
        }

        if (this._selectedInstanceId) {
            const inst = this._instances.get(this._selectedInstanceId);
            if (inst?.actor) {
                const ctx = inst.actor.get_style_context();
                ctx.remove_class('ding-widget-selected');
            }
        }
    }

    updateSelectionChromePositionFor(instanceId) {
        if (!instanceId || instanceId !== this._selectedInstanceId)
            return;

        const inst = this._instances.get(instanceId);
        if (!inst)
            return;

        const ctx = inst.actor.get_style_context();
        ctx.add_class('ding-widget-selected');

        this._ensureChrome();
        this._attachChromeToInstance(inst);
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
                    let instance = this._instances.get(instData.instanceId);

                    if (instance) {
                        instance.widgetId = instData.widgetId;
                        instance.monitorIndex = instData.monitorIndex ?? 0;
                        instance.kind = instData.kind ?? 'html';
                        instance.normX = instData.normX ?? 0;
                        instance.normY = instData.normY ?? 0;
                        instance.width = instData.width ?? 200;
                        instance.height = instData.height ?? 150;
                        instance.config = instData.config ?? {};
                        instance.prefsUri = instData.prefsUri ?? null;
                        instance.hasPreferences =
                            instData.hasPreferences ?? !!instance.prefsUri;
                        instance.hasBackend = instData.hasBackend;
                        instance.webConsent = instData.webConsent ?? null;
                        instance.backendConsent =
                            instData.backendConsent ?? null;
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
                            actor: null,
                            config: instData.config ?? {},
                            prefsUri: instData.prefsUri ?? null,
                            hasPreferences:
                                instData.hasPreferences ?? !!instData.prefsUri,
                            hasBackend: instData.hasBackend ?? false,
                            webConsent: instData.webConsent ?? null,
                            backendConsent: instData.backendConsent ?? null,
                        };

                        this._instances.set(instance.instanceId, instance);
                    }

                    seen.add(instance.instanceId);

                    const surface = this._surfaces.get(instance.monitorIndex);
                    if (surface) {
                        // eslint-disable-next-line no-await-in-loop
                        const created =
                            await this._ensureInstanceActor(instance);

                        if (!created)
                            continue;

                        const prev = this._suppressStateEvents;
                        this._suppressStateEvents = true;
                        this._positionInstanceActor(instance);
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
            return;

        inst.config = newConfig;
        this._stateChanged();
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
     *   version: 1,
     *   instances: [
     *     { instanceId, widgetId, kind, monitorIndex,
     *       normX, normY, width, height, config }
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
                config: inst.config ?? {},
                prefsUri: inst.prefsUri ?? null,
                hasPreferences: !!inst.hasPreferences,
                hasBackend: !!inst.hasBackend,
                webConsent: inst.webConsent ?? null,
                backendConsent: inst.backendConsent ?? null,
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
            actor: null,
            config,
            kind,
            hasBackend: descriptor?.hasBackend ?? !!descriptor?.backend ?? false,
            prefsUri: descriptor?.prefs ?? null,
            hasPreferences: !!descriptor?.prefs,
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
        button.connect(
            'clicked',
            () => this.openAddWidgetDialog(
                null,
                surface.monitorIndex
            ).catch(logError)
        );

        const icon = Gtk.Image.new_from_icon_name('list-add-symbolic');
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
        
        const gridIcon = Gtk.Image.new_from_icon_name('view-grid-symbolic');
        gridToggleButton.set_child(gridIcon);
        gridToggleButton.set_active(false);

        gridToggleButton.widgetInstanceId = instanceId;

        gridToggleButton.connect('toggled', (btn) => {
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

        if (!addButtonInst) {
            return [0, 0];
        }

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

            if (inst.host && typeof inst.host.destroy === 'function')
                inst.host.destroy();

            inst.actor = null;
            inst.host = null;
        }
    }

    async _reattachAllInstances() {
        if (!this._preferences.showDesktopWidgets)
            return;

        for (const inst of this._instances.values()) {
            const surface = this._surfaces.get(inst.monitorIndex);

            if (!surface)
                continue;

            // eslint-disable-next-line no-await-in-loop
            const created = await this._ensureInstanceActor(inst);

            if (!created)
                continue;

            this._positionInstanceActor(inst);

            // Use optional chaining because requestRender()
            // currently exists only on HTML hosts.
            inst.host?.requestRender?.().catch(e => logError(e));
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

        if (inst.host && typeof inst.host.destroy === 'function')
            inst.host.destroy();

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
        const isMove = !!inst.actor.get_parent();

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
        else
            widgetContainer.put(inst.actor, x, y);
    }

    _ensureChrome() {
        if (this._chrome)
            return;

        this.closeButton = new Gtk.Button();
        this.closeButton.set_name('ding-widget-close-button');
        this.closeButton.set_can_focus(false);
        this.closeButton.set_focus_on_click(false);

        const img = Gtk.Image.new_from_icon_name('window-close-symbolic');
        this.closeButton.set_child(img);

        this.closeButton.connect('clicked',
            this.deleteSelectedInstance.bind(this)
        );

        this.prefsButton = new Gtk.Button();
        this.prefsButton.set_name('ding-widget-prefs-button');
        this.prefsButton.set_can_focus(false);
        this.prefsButton.set_focus_on_click(false);
        this.prefsButton.set_tooltip_text(_('Widget preferences'));

        const prefsImg = Gtk.Image.new_from_icon_name('emblem-system-symbolic');
        this.prefsButton.set_child(prefsImg);

        this.prefsButton.connect('clicked',
            this._openPreferencesForSelectedInstance.bind(this)
        );

        this._chrome = new Set();
        this._chrome.add(this.closeButton);
        this._chrome.add(this.prefsButton);
    }

    _attachChromeToInstance(inst) {
        if (!this._chrome)
            return;

        const surface = this._surfaces.get(inst.monitorIndex);
        if (!surface)
            return;

        const {widgetContainer} = surface;
        const frame = this.getInstanceFrame(inst.instanceId);
        if (!frame)
            return;

        let allocWidth = frame.width;
        const alloc = inst.actor?.get_allocation?.();
        if (alloc)
            allocWidth = alloc.width;

        const size = 28;
        const gap = 6;
        const margin = 8;

        const showPrefs = inst.hasPreferences;
        const buttonCount = showPrefs ? 2 : 1;
        const totalWidth = buttonCount * size + (buttonCount - 1) * gap;

        const centerX = frame.x + allocWidth / 2;
        const buttonsX = centerX - totalWidth / 2;

        let yPos;
        const yPosUp = frame.y - size - margin;
        const yPosDown = frame.y + frame.height + margin;
        if (yPosUp < margin) {
            yPos = yPosDown;
        } else {
            yPos = yPosUp;
        }

        const prefsOldParent = this.prefsButton.get_parent();
        if (prefsOldParent && prefsOldParent !== widgetContainer)
            prefsOldParent.remove(this.prefsButton);
        const closeOldParent = this.closeButton.get_parent();
        if (closeOldParent && closeOldParent !== widgetContainer)
            closeOldParent.remove(this.closeButton);

        if (showPrefs) {
            if (!this.prefsButton.get_parent())
                widgetContainer.put(this.prefsButton, buttonsX, yPos);
            else
                widgetContainer.move(this.prefsButton, buttonsX, yPos);
            this.prefsButton.show();
        } else {
            this.prefsButton.hide();
        }

        const closeX = showPrefs ? (buttonsX + size + gap) : buttonsX;
        if (!this.closeButton.get_parent())
            widgetContainer.put(this.closeButton, closeX, yPos);
        else
            widgetContainer.move(this.closeButton, closeX, yPos);
        this.closeButton.show();

        this._raiseChromeButtons(surface);
    }

    _detachChrome() {
        if (!this._chrome)
            return;

        for (const btn of this._chrome) {
            const parent = btn.get_parent();
            if (parent)
                parent.remove(btn);
        }
    }

    _raiseChromeButtons(surface) {
        if (!this._chrome || !surface?.widgetContainer)
            return;

        for (const btn of this._chrome) {
            const parent = btn.get_parent?.();
            if (!parent || parent !== surface.widgetContainer)
                continue;

            try {
                btn.insert_before(parent, null);
            } catch (e) {
                console.error('WidgetManager: failed to raise chrome button:', e);
            }
        }
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
            this._webWidgetContext?.updateHtmlWidgetLayer(inst, onTop);
    }

    _updateWidgetsSelectionState() {
        for (const inst of this._instances.values()) {
            const selected = inst.instanceId === this._selectedInstanceId;
            // To Do: GTK Widget seleted state
            if (inst.kind === 'html' && inst.actor && inst.host)
                this._webWidgetContext?.updateHtmlWidgetSelected(inst, selected);
        }
    }

    _updateTheme(inst, theme) {
        // To Do: GTK Widget layer change
        if (inst.kind === 'html' && inst.actor && inst.host)
            this._webWidgetContext?.updateHtmlWidgetTheme(inst, theme);
    }

    _updateAnimation(inst, reducedMotion) {
        // To Do : Gtk Widget layer change
        if (inst.kind === 'html' && inst.actor && inst.host)
            this._webWidgetContext?.updateHtmlWidgetAnimation(inst, reducedMotion);
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

        const surface = this._surfaces.get(inst.monitorIndex);
        const grid = surface?.grid;

        const editMode = !!grid?.isWidgetContainerOnTop?.();
        const theme = this._preferences.darkmode ? 'dark' : 'light';
        const reducedMotion = !this._preferences.globalAnimations;
        const locale = this._getLocale();
        const direction = this._getDirectionForActor(actor);

        return {
            editMode,
            selected,
            theme,
            reducedMotion,
            direction,
            locale,
        };
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

        if (!parentWindow)
            parentWindow = this._desktopManager.mainApp.get_active_window();

        const {window, list, addButton, cancelButton} =
            this._createWidgetPickerWindow(parentWindow, widgets);

        const resultPromise = new Promise(resolve => {
            cancelButton.connect('clicked', () => {
                window.close();
                resolve(null);
            });

            addButton.connect('clicked', async () => {
                const row = list.get_selected_row();
                if (!row || !row._widgetId) {
                    window.close();
                    resolve(null);
                    return;
                }

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

                window.close();
                resolve(created);
            });

            // Double-clicking a row also activates "Add"
            list.connect('row-activated', () => {
                addButton.activate();
            });

            // If user closes via window close button / Esc
            window.connect('close-request', () => {
                resolve(null);
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

        if (parentWindow)
            window.set_transient_for(parentWindow);

        // Populate rows from registry
        for (const desc of widgets) {
            const row = this._createWidgetRow(desc);
            list.append(row);
        }

        // Select first by default
        const firstRow = list.get_row_at_index(0);
        if (firstRow)
            list.select_row(firstRow);

        return {window, list, addButton, cancelButton};
    }

    _createWidgetRow(desc) {
        const row = new Gtk.ListBoxRow();
        row._widgetId = desc.id;

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
        });

        const titleLabel = new Gtk.Label({
            label: desc.name || desc.id,
            xalign: 0,
        });

        const subtitleParts = [];

        if (desc.kind) {
            if (desc.kind === 'html')
                subtitleParts.push(_('HTML widget'));
            else if (desc.kind === 'gtk')
                subtitleParts.push(_('GTK widget'));
            else
                subtitleParts.push(desc.kind);
        }

        if (desc.category)
            subtitleParts.push(desc.category);

        if (desc.isUser)
            subtitleParts.push(_('User'));

        const subtitle = subtitleParts.join(' · ');

        const subtitleLabel = new Gtk.Label({
            label: subtitle,
            xalign: 0,
        });
        subtitleLabel.add_css_class('dim-label');

        box.append(titleLabel);
        if (subtitle)
            box.append(subtitleLabel);

        row.set_child(box);
        return row;
    }

    _addActions() {
        const addWidgetAction = Gio.SimpleAction.new('addWidget', null);
        addWidgetAction.connect('activate', () => {
            const parentWindow =
                this._desktopManager.mainApp.get_active_window();

            let monitorIndex = null;

            if (parentWindow) {
                const surface = parentWindow.get_surface();
                const display = surface?.get_display?.();
                const monitor = display?.get_monitor_at_surface?.(surface);
                const monitors = display?.get_monitors?.();
                const count = monitors?.get_n_items?.() ?? 0;

                for (let i = 0; i < count; i++) {
                    if (monitors.get_item?.(i) === monitor) {
                        monitorIndex = i;
                        break;
                    }
                }
            }

            if (monitorIndex === null)
                return;

            // Ensure widget layers are visible before adding a widget.
            this._desktopManager.windowManager?.raiseWidgetLayers();

            this.openAddWidgetDialog(parentWindow, monitorIndex)
                .catch(logError);
        });
        this._desktopManager.mainApp.add_action(addWidgetAction);

        const showGridAction = Gio.SimpleAction.new('toggleWidgetGrid', null);
        showGridAction.connect('activate', () => {
            const parentWindow =
                this._desktopManager.mainApp.get_active_window();

            let monitorIndex = null;

            if (parentWindow) {
                const surface = parentWindow.get_surface();
                const display = surface?.get_display?.();
                const monitor = display?.get_monitor_at_surface?.(surface);
                const monitors = display?.get_monitors?.();
                const count = monitors?.get_n_items?.() ?? 0;

                for (let i = 0; i < count; i++) {
                    if (monitors.get_item?.(i) === monitor) {
                        monitorIndex = i;
                        break;
                    }
                }
            }

            if (monitorIndex === null)
                return;

            let gridToggleButton = null;
            const instanceId =
                this._getGridToggleButtonInstanceId(monitorIndex);

            const inst = instanceId ? this._instances.get(instanceId) : null;
            gridToggleButton = inst?.actor ?? null;

            if (!gridToggleButton)
                return;

            // Ensure widget layers are visible before showingt widget grid.
            this._desktopManager.windowManager?.raiseWidgetLayers();
            gridToggleButton?.activate();
        });
        this._desktopManager.mainApp.add_action(showGridAction);

        const closeWidget = Gio.SimpleAction.new('closeWidget', null);
        closeWidget.connect('activate', this.deleteSelectedInstance.bind(this));
        this._desktopManager.mainApp.add_action(closeWidget);
    }

    /* =====================================================================
     * Widget Consent UI
     * ===================================================================== */

    _asyncAskYesNo(heading, body) {
        const parentWindow = this._desktopManager.mainApp.get_active_window();
        const yesLabel = _('Allow');
        const noLabel = _('Cancel');

        return new Promise(resolve => {
            const dlg = new Adw.AlertDialog();
            dlg.set_heading(heading);
            dlg.set_body(body);
            dlg.add_response('no', noLabel);
            dlg.add_response('yes', yesLabel);
            dlg.set_default_response('no');
            dlg.set_close_response('no');
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

            dlg.connect('response', (_d, response) => {
                resolve(response === 'yes');
            });

            dlg.present(parentWindow ?? null);
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
        const body =
            // eslint-disable-next-line prefer-template
            _('The widget you are adding may load web content from the internet.\n\n') +
            _('This content is subject to the widget security policy:\n\n') +
            `${cspProfile.name}\n` +
            `${cspProfile.summary}`;


        const answer = await this._asyncAskYesNo(heading, body);

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
        (argvStr ? `${_('Command:\n') + argvStr}\n\n` : '') +
        _('Only allow this for widgets you implicitly trust.');

        const answer = await this._asyncAskYesNo(
            _('Allow widget backend?'),
            body);

        return answer;
    }
};
