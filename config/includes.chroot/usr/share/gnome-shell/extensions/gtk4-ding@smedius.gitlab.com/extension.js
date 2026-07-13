import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {DingManager} from './dingManager.js';

export default class DingExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this.dingManager = null;
        this.DesktopIconsUsableArea = null;
    }

    enable() {
        if (!this.dingManager)
            this.dingManager = new DingManager(this);

        this.dingManager.enable();
        this.DesktopIconsUsableArea = this.dingManager.DesktopIconsUsableArea;
    }

    // This extension uses the 'unlock-dialog' session mode so it keeps the
    // desktop process alive while the screen is locked. disable() is the real
    // extension shutdown path and must explicitly tear everything down.
    disable() {
        this.dingManager?.disable();
        this.dingManager = null;
        this.DesktopIconsUsableArea = null;
    }
}
