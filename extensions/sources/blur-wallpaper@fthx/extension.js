/*
    Blur Wallpaper - GNOME Shell 46+ extension
    Copyright @fthx 2026 - License GPL v3
*/


import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';


export default class BlurWallpaperExtension extends Extension {
    constructor(metadata) {
        super(metadata);
    }

    _initBlur() {
        this._blurRadius = this._settings?.get_int('blur-radius') ?? 50;
        this._blurEffect = new Shell.BlurEffect({ radius: this._blurRadius, mode: Shell.BlurMode.ACTOR });
        this._overviewBlurEffectList = [];

        if (this._settings?.get_boolean('blur-desktop'))
            Main.layoutManager._backgroundGroup.add_effect(this._blurEffect);

        if (this._settings?.get_boolean('blur-overview')) {
            this._addOverviewBlur();
            Main.overview.connectObject(
                'showing', () => this._addOverviewBlur(),
                'hidden', () => this._cleanOverviewBlurEffects(),
                this);
        }

        if (this._settings?.get_boolean('dynamic-blur')) {
            this._toggleBlur();
            global.display.connectObject('restacked', () => this._toggleBlur(), this);
        }

    }

    _refreshRadius() {
        this._blurRadius = this._settings?.get_int('blur-radius') ?? 50;
        this._blurEffect.radius = this._blurRadius;
    }

    _toggleBlur() {
        this._blurEffect.radius = this._hasWindows()
            ? this._blurRadius
            : 0;
    }

    _addOverviewBlur() {
        const workspacesViews = Main.overview._overview._controls._workspacesDisplay._workspacesViews;
        workspacesViews[0]?._workspaces.forEach(workspace => {
            const overviewBlurEffect = new Shell.BlurEffect({ radius: this._blurRadius, mode: Shell.BlurMode.ACTOR });
            workspace?._background.add_effect(overviewBlurEffect);

            this._overviewBlurEffectList.push(overviewBlurEffect);
        });
    }

    _cleanOverviewBlurEffects() {
        this._overviewBlurEffectList.forEach(effect => {
            effect.actor?.remove_effect(effect);
            effect = null;
        });
        this._overviewBlurEffectList = []
    }

    _hasWindows() {
        const activeWorkspace = global.workspace_manager.get_active_workspace();

        return !activeWorkspace || activeWorkspace
            .list_windows()
            .some(w => w.get_window_type() === Meta.WindowType.NORMAL);
    }

    enable() {
        this._settings = this.getSettings();

        if (Main.layoutManager._startingUp)
            Main.layoutManager.connectObject('startup-complete', () => this._initBlur(), this);
        else
            this._initBlur();

        this._settings?.connectObject('changed', () => this._refreshRadius(), this);
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._settings = null;

        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.display.disconnectObject(this);

        if (this._blurEffect) {
            Main.layoutManager._backgroundGroup.remove_effect(this._blurEffect);
            this._blurEffect = null;
        }
        this._cleanOverviewBlurEffects();
        this._blurRadius = null;
    }
}
