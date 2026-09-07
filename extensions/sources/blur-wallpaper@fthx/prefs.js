import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


export default class BlurWallpaperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Blur Wallpaper extension',
            icon_name: 'dialog-information-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup();
        page.add(group);

        const blurDesktop = new Adw.SwitchRow({
            title: 'Blur desktop',
            subtitle: 'Needs an extension restart.'
        });
        group.add(blurDesktop);
        window._settings.bind('blur-desktop', blurDesktop, 'active', Gio.SettingsBindFlags.DEFAULT);

        const blurOverview = new Adw.SwitchRow({
            title: 'Blur overview',
            subtitle: 'Needs an extension restart.'
        });
        group.add(blurOverview);
        window._settings.bind('blur-overview', blurOverview, 'active', Gio.SettingsBindFlags.DEFAULT);

        const dynamicBlur = new Adw.SwitchRow({
            title: 'Dynamic blur',
            subtitle: 'Only blur when at least one window is open.\nNeeds an extension restart.',
        });
        group.add(dynamicBlur);
        window._settings.bind('dynamic-blur', dynamicBlur, 'active', Gio.SettingsBindFlags.DEFAULT);

        const adjustmentRadius = new Gtk.Adjustment({
            lower: 0,
            upper: 100,
            step_increment: 1,
            page_increment: 5,
        });

        const blurRadius = new Adw.SpinRow({
            title: 'Blur radius (px)',
            subtitle: '0 = no blur, 100 = max blur.',
            adjustment: adjustmentRadius,
        });
        group.add(blurRadius);
        window._settings.bind('blur-radius', blurRadius, 'value', Gio.SettingsBindFlags.DEFAULT);

    }
}
