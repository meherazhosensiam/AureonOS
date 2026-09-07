// -*- mode: js2; indent-tabs-mode: nil; js2-basic-offset: 4 -*-
// Start apps on custom workspaces
/* exported init enable disable */

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';


import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

let _appData;
let _allDesktops = false;
let _showMinimized = true;
const WindowSwitcherPopup = GObject.registerClass(
class WindowSwitcherPopup extends AltTab.WindowSwitcherPopup {
    _init() {
        super._init();
    }

    _getRuleWindowList () {
        const windows =  []
        for (const app of _appData) {
            if (app) {
                windows.push(...app.get_windows());
            }
        }
        return windows;
    }

    _windowTry(ruleWindows, window) {
        return this.is_other_switcher !== ruleWindows.includes(window);
    }

    _getWindowList() {
        let workspace = global.workspace_manager.get_active_workspace();
        let windows = [];
        let active_window = null;
        let need_add_active = false;
        if (_allDesktops) {
            workspace = null;
        }
        const ruleWindows = this._getRuleWindowList();
        const windowList = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);
        for (let window of windowList) {
            if (window.has_focus()) {
                active_window = window;
                need_add_active = !(this._windowTry(ruleWindows, window));
            }
            if (this._windowTry(ruleWindows, window) && !(window.minimized && !_showMinimized)) {
                windows.push(window);
            }
        }
        if (need_add_active && active_window) {
            windows.splice(0, 0, active_window);
        }
        return windows;
    }
    _keyPressHandler(keysym, action) {
        switch (action) {
            case Meta.KeyBindingAction.SWITCH_APPLICATIONS:
            case Meta.KeyBindingAction.SWITCH_GROUP:
                action = Meta.KeyBindingAction.SWITCH_WINDOWS;
                break;
            case Meta.KeyBindingAction.SWITCH_APPLICATIONS_BACKWARD:
            case Meta.KeyBindingAction.SWITCH_GROUP_BACKWARD:
                action = Meta.KeyBindingAction.SWITCH_WINDOWS_BACKWARD;
                break;
        }
        return super._keyPressHandler.call(this, keysym, action);
    }
})

const OtherWindowSwitcherPopup = GObject.registerClass(
    class OtherWindowSwitcherPopup extends WindowSwitcherPopup {
    _init() {
        this.is_other_switcher = true;
        super._init();

    }
});

const MainWindowSwitcherPopup = GObject.registerClass(
    class MainWindowSwitcherPopup extends WindowSwitcherPopup {

    _init() {
        this.is_other_switcher = false;
        super._init();
    }
});


function setKeybinding(name, func) {
    Main.wm.setCustomKeybindingHandler(name, Shell.ActionMode.NORMAL, func);
}

const keybindings = [
    'switch-windows',
    'switch-windows-backward',
    'switch-applications',
    'switch-applications-backward',
    'switch-group',
    'switch-group-backward',
];

export default class WindowSwitcher extends Extension {

    _updateAppConfigs() {
        this._appIds = [];

        this._settings.get_strv('application-list').forEach(appId => {
            this._appIds.push(appId);
        });
        _showMinimized = this._settings.get_boolean('show-minimized');

        _allDesktops = this._settings.get_boolean('all-desktops');

        this._updateAppData();
    }

    _updateAppData() {
        _appData = this._appIds.map(id => this._appSystem.lookup_app(id));
    }

    _startSwitcher(display, window, oldBinding, binding) {
        let constructor = null;
        switch ((binding || oldBinding).get_name()) {
        case 'switch-applications':
        case 'switch-applications-backward':
        case 'switch-group':
        case 'switch-group-backward':
            constructor = MainWindowSwitcherPopup;
            break;
        case 'switch-windows':
        case 'switch-windows-backward':
            constructor = OtherWindowSwitcherPopup;
            break;
        case 'cycle-windows':
        case 'cycle-windows-backward':
            constructor = AltTab.WindowCyclerPopup;
            break;
        case 'cycle-group':
        case 'cycle-group-backward':
            constructor = AltTab.GroupCyclerPopup;
            break;
        case 'switch-monitor':
            constructor = SwitchMonitor.SwitchMonitorPopup;
            break;
        }

        if (!constructor)
            return;

        /* prevent a corner case where both popups show up at once */
        if (this._workspaceSwitcherPopup != null)
            this._workspaceSwitcherPopup.destroy();

        let tabPopup = new constructor();

        if (!tabPopup.show((binding || oldBinding).is_reversed(), (binding || oldBinding).get_name(), (binding || oldBinding).get_mask()))
            tabPopup.destroy();
    }

    enable () {
        this._settings = this.getSettings();
        this._appSystem = Shell.AppSystem.get_default();
        this._appIds = [];
        this._updateAppData();
        this._appsInstalledChangedId =
            this._appSystem.connect('installed-changed',
                this._updateAppData.bind(this));

        this._appsChangedId =
            this._settings.connect('changed',
                this._updateAppConfigs.bind(this));
        this._updateAppConfigs();

        keybindings.forEach((keybinding) => setKeybinding(keybinding, this._startSwitcher.bind(Main.wm)));

    }

    disable () {
        const startSwitcher = Main.wm._startWindowSwitcher || Main.wm._startSwitcher;

        keybindings.forEach((keybinding) => setKeybinding(keybinding, startSwitcher.bind(Main.wm)));

        if (this._appsInstalledChangedId) {
            this._appSystem.disconnect(this._appsInstalledChangedId);
            this._appsInstalledChangedId = null;
        }

        if (this._appsChangedId) {
            this._appSystem.disconnect(this._appsChangedId);
            this._appsChangedId = null;
        }

        if (this._settings) {
            this._settings = null;
        }
        if (this._appSystem) {
            this._appSystem = null;
        }
        if (this._appSwitcherSettings) {
            this._appSwitcherSettings = null;
        }

        this._appIds = null;
        _appData = null;
        _allDesktops = false;
    }

}