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

import {WidgetWindow} from '../dependencies/localFiles.js';

export {PinnedWindowManager};

const PinnedWindowManager = class {
    /**
     * Runtime owner for pinned widget host windows.
     *
     * WidgetManager keeps canonical widget state. This class owns only the
     * runtime host objects that expose those instances as pinned windows.
     *
     * @param {object} params
     * @param {object} params.widgetManager
     * @param {object} params.mainApp
     */
    constructor(params = {}) {
        this._widgetManager = params.widgetManager ?? null;
        this._mainApp = params.mainApp ?? null;
        this._windows = new Map();
    }

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------

    hasInstance(instanceId) {
        return this._windows.has(instanceId);
    }

    getWindow(instanceId) {
        return this._windows.get(instanceId) ?? null;
    }

    getInstanceIdForWindow(widgetWindow) {
        if (!widgetWindow)
            return null;

        for (const [instanceId, window] of this._windows.entries()) {
            if (window === widgetWindow)
                return instanceId;
        }

        return null;
    }

    pinInstance(inst) {
        if (!inst || !inst.instanceId || !inst.actor)
            return null;

        const widgetWindow = this._ensureWindow(inst);
        if (!widgetWindow)
            return null;

        widgetWindow.attachActor(inst.actor);
        widgetWindow.syncFromManager();
        widgetWindow.present();
        return widgetWindow;
    }

    unpinInstance(inst) {
        if (!inst || !inst.instanceId)
            return;

        this.destroyInstanceWindow(inst.instanceId);
    }

    refreshInstance(inst) {
        if (!inst || !inst.instanceId)
            return;

        const widgetWindow = this._windows.get(inst.instanceId);
        if (widgetWindow)
            widgetWindow.syncFromManager();
    }

    refreshAll() {
        for (const widgetWindow of this._windows.values())
            widgetWindow.syncFromManager();
    }

    beginPinnedWindowMove(instanceId, params = {}) {
        const widgetWindow = this._windows.get(instanceId);
        if (!widgetWindow)
            return;

        widgetWindow.beginPinnedWindowMove(params);
    }

    destroyInstanceWindow(instanceId) {
        const widgetWindow = this._windows.get(instanceId);
        if (!widgetWindow)
            return;

        this._windows.delete(instanceId);
        widgetWindow.destroy();
    }

    destroyAllWindows() {
        for (const instanceId of [...this._windows.keys()])
            this.destroyInstanceWindow(instanceId);
    }

    _ensureWindow(inst) {
        if (!inst || !inst.instanceId)
            return null;

        let widgetWindow = this._windows.get(inst.instanceId);
        if (widgetWindow)
            return widgetWindow;

        widgetWindow = new WidgetWindow({
            widgetManager: this._widgetManager,
            mainApp: this._mainApp,
            instanceId: inst.instanceId,
        });

        this._windows.set(inst.instanceId, widgetWindow);
        return widgetWindow;
    }
};
