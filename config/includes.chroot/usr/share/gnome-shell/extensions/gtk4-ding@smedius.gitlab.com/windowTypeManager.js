/* Window Type Manager
 *
 * Copyright (C) 2022 Sundeep Mediratta (smedius@gmail.com)
 * Copyright (C) 2020 Sergio Costas (rastersoft@gmail.com)
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
/* global global */
/* exported WindowTypeManager */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

export {WindowTypeManager};

const appID = 'com.desktop.ding';
const appPath = GLib.build_filenamev(['/', ...appID.split('.')]);

class ManageWindow {
    /* This class is added to each managed window, and it's used to make it
       behave like a desktop window.

       Trusted windows will set in the title the characters @!, followed by
       the coordinates where to put the window separated by a colon, and
       ended in a semicolon. After that, it can have one or more of these
       letters:

       * B : put and always keep this window at the bottom of the stack of
             windows on screen
       * T : put and always keep this window at the top of the stack of
             windows on the screen
       * D : show this window in all desktops
       * H : hide this window from the window list
       * K : make this window a dock window (takes precedence over desktop flags)
       * F : keep the window in the same position, even if it is moved by the
             user or by the system (for example when changing screen resolution)

       Using the title is generally not a problem because the desktop windows
       do not have a title. But some other windows may have and still need to
       set a title and use this class, so adding a single blank space at the
       end of the title is equivalent to @!H, and having two blank spaces at
       the end of the title is equivalent to @!HTD. This allows use of these
       flags for decorated or titled windows.
    */

    constructor(window, waylandClient, remoteActionGroup, changedStatusCB) {
        this._waylandClient = waylandClient ?? null;
        this._window = window;
        this._signalIDs = [];
        this._onIdleChangedStatusCallback = changedStatusCB;
        this._raiseDesktopAsDock = false;
        this._remoteActionGroup = remoteActionGroup ?? null;
        this.windowInstanceId = null;
        this._lastEmittedWindowPosition = null;
        this._suppressedTrackedWindowPosition = null;
        this._parsedTitleState = null;
        this._trackingWindowPosition = false;
        this._titleID = 0;
        this._checkOnAllWorkspacesID = 0;
        this._moveIntoPlaceID = 0;
        this._restackedBottomID = 0;
        this._restackedTopID = 0;

        this._titleID = this._window.connect('notify::title', () => {
            this.refreshProperties();
        });

        this._parseTitle();
        this._attachControllers();
    }

    disconnect() {
        this._disconnetSignalsAndTimeouts();

        if (this._window && this._titleID)
            this._window.disconnect(this._titleID);
        this._titleID = 0;

        if (this._keepAtTop)
            this._window.unmake_above();

        this._window = null;
        this._waylandClient = null;
    }

    _disconnetSignalsAndTimeouts() {
        for (let signalID of this._signalIDs) {
            if (signalID)
                this._window.disconnect(signalID);
        }
        this._signalIDs = [];

        if (this._checkOnAllWorkspacesID)
            GLib.source_remove(this._checkOnAllWorkspacesID);
        this._checkOnAllWorkspacesID = 0;

        if (this._moveIntoPlaceID)
            GLib.source_remove(this._moveIntoPlaceID);
        this._moveIntoPlaceID = 0;

        if (this._restackedBottomID)
            global.display.disconnect(this._restackedBottomID);
        this._restackedBottomID = 0;

        if (this._restackedTopID)
            global.display.disconnect(this._restackedTopID);
        this._restackedTopID = 0;
    }

    set_wayland_client(client) {
        this._waylandClient = client;
    }

    setRemoteActionGroup(remoteActionGroup) {
        this._remoteActionGroup = remoteActionGroup;
    }

    _parseTitle() {
        const title = this._window.get_title();
        const parsedTitle = this._buildParsedTitleState(title);
        this._applyParsedTitleState(parsedTitle);
    }

    /*
       Expected managed-window title protocol after legacy normalization:

       @!<x>,<y>;<flags>[;KEY=VALUE ...]

       Examples:
       - @!120,340;KH
       - @!120,340;TH;I=550e8400-e29b-41d4-a716-446655440000

       Grammar:
       - @! introduces a DING-managed window directive
       - <x>,<y> are integer global coordinates
       - <flags> is a compact string of zero or more of:
         B, T, D, H, F, K
       - optional metadata segments follow as ;KEY=VALUE
       - multiple metadata segments are allowed for forward compatibility
       - unknown metadata keys are ignored
       - currently supported metadata:
         I=<uuid>  instance id for pinned widget windows

       Legacy compatibility is handled before parsing:
       - null title on transient dialogs -> @!H
       - one trailing space -> @!H
       - two trailing spaces -> @!HTD
    */
    _buildParsedTitleState(title) {
        const parsed = {
            x: null,
            y: null,
            flags: new Set(),
            windowInstanceId: null,
        };

        const normalizedTitle = this._normalizeManagedWindowTitle(title);
        if (normalizedTitle === null)
            return parsed;

        const directivePosition = normalizedTitle.indexOf('@!');
        if (directivePosition === -1)
            return parsed;

        const payload = normalizedTitle.substring(directivePosition + 2).trim();
        const parts = payload.split(';');
        const coordsSegment = (parts.shift() ?? '').trim();
        const flagSegment = (parts.shift() ?? '').trim().toUpperCase();
        const metadataSegments = parts;

        this._parseManagedWindowCoords(coordsSegment, parsed);
        this._parseManagedWindowFlags(flagSegment, parsed);
        this._parseManagedWindowMetadata(metadataSegments, parsed);

        return parsed;
    }

    _normalizeManagedWindowTitle(title) {
        let normalizedTitle = title;

        if (!normalizedTitle && !!this._window.get_transient_for()) {
            // Transient dialog window
            // Does not have title, hide from windowlist
            normalizedTitle = '@!H';
        }

        if (normalizedTitle === null)
            return null;

        if ((normalizedTitle.length > 0) &&
            (normalizedTitle[normalizedTitle.length - 1] === ' ')
        ) {
            if ((normalizedTitle.length > 1) &&
                (normalizedTitle[normalizedTitle.length - 2] === ' ')
            )
                return '@!HTD';


            return '@!H';
        }

        return normalizedTitle;
    }

    _parseManagedWindowCoords(coordsSegment, parsed) {
        const coords = coordsSegment.split(',');
        const x = parseInt(coords[0]);
        const y = parseInt(coords[1]);

        if (Number.isFinite(x) && Number.isFinite(y)) {
            parsed.x = x;
            parsed.y = y;
        }
    }

    _parseManagedWindowFlags(flagSegment, parsed) {
        for (const char of flagSegment) {
            if ('BTDHFK'.includes(char))
                parsed.flags.add(char);
        }
    }

    _parseManagedWindowMetadata(metadataSegments, parsed) {
        for (const part of metadataSegments) {
            const trimmedPart = part.trim();
            if (!trimmedPart)
                continue;

            const separator = trimmedPart.indexOf('=');
            if (separator === -1)
                continue;

            const key =
                trimmedPart.substring(0, separator).trim().toUpperCase();
            const value = trimmedPart.substring(separator + 1).trim();

            if (key === 'I' && value)
                parsed.windowInstanceId = value;
        }
    }

    _applyParsedTitleState(parsed) {
        this._x = parsed.x;
        this._y = parsed.y;
        this.windowInstanceId = parsed.windowInstanceId;
        this._keepAtBottom = parsed.flags.has('B');
        this._keepAtTop = parsed.flags.has('T');
        this._showInAllDesktops = parsed.flags.has('D');
        this._hideFromWindowList = parsed.flags.has('H');
        this._fixed = parsed.flags.has('F');
        this._dockWindow = parsed.flags.has('K');
        this._desktopWindow =
            this._keepAtBottom &&
            !this._keepAtTop &&
            this._showInAllDesktops &&
            this._hideFromWindowList;
        this._parsedTitleState = parsed;
    }

    _applyParsedTitlePosition(parsed) {
        this._x = parsed.x;
        this._y = parsed.y;
        this._parsedTitleState = parsed;
    }

    _reloadWindowControllers(parsed) {
        this._disconnetSignalsAndTimeouts();
        this._applyParsedTitleState(parsed);
        this._attachControllers();
    }

    _parsedTitleStateEquals(a, b) {
        if (a.x !== b.x ||
            a.y !== b.y ||
            a.windowInstanceId !== b.windowInstanceId ||
            a.flags.size !== b.flags.size)
            return false;


        for (const flag of a.flags) {
            if (!b.flags.has(flag))
                return false;
        }

        return true;
    }

    _parsedTitleBehaviorEquals(a, b) {
        if (a.windowInstanceId !== b.windowInstanceId ||
            a.flags.size !== b.flags.size)
            return false;


        for (const flag of a.flags) {
            if (!b.flags.has(flag))
                return false;
        }

        return true;
    }

    _attachControllers() {
        const raisedDesktopAsDockActive =
            this._desktopWindow && this._raiseDesktopAsDock;
        const dockWindowActive = this._dockWindow;
        const desktopWindowActive =
            this._desktopWindow &&
            !raisedDesktopAsDockActive &&
            !dockWindowActive;

        if (this._fixed)
            this._keepFixedWindowPosition();

        if (this._hideFromWindowList)
            this._keepWindowHidden();
        else
            this._unhideWindow();

        if (this._keepAtTop && !this._desktopWindow && !this._dockWindow)
            this._keepWindowOnTop();
        else if (this._window.above)
            this._window.unmake_above();

        if (this._keepAtBottom && !this._desktopWindow && !this._dockWindow)
            this._keepWindowAtBottom();

        if (this._showInAllDesktops &&
            !this._desktopWindow &&
            !this._dockWindow
        )
            this._showWindowOnAllDesktops();
        else if (this._window.on_all_workspaces)
            this._window.unstick();

        if (raisedDesktopAsDockActive)
            this._raiseDesktopAsDockWindow();
        else if (dockWindowActive)
            this._makeWindowTypeDock();
        else if (desktopWindowActive)
            this._makeWindowTypeDesktop();
        else
            this._makeWindowTypeNormal();

        if (this.windowInstanceId)
            this._trackWindowPosition();
        else
            this._trackingWindowPosition = false;

        if (this._needsMoveToParsedPosition()) {
            if (this.windowInstanceId)
                this._moveFrameWithoutTrackingFeedback(true, this._x, this._y);
            else
                this._window.move_frame(true, this._x, this._y);
        }
    }

    _hasValidPosition() {
        return Number.isFinite(this._x) && Number.isFinite(this._y);
    }

    _needsMoveToParsedPosition() {
        if (!this._hasValidPosition())
            return false;

        const frameRect = this._window.get_frame_rect?.();
        const currentX = frameRect?.x;
        const currentY = frameRect?.y;

        return currentX !== this._x || currentY !== this._y;
    }

    _moveFrameWithoutTrackingFeedback(userOp, x, y) {
        if (!this._window)
            return;

        this._suppressedTrackedWindowPosition = {x, y};
        this._lastEmittedWindowPosition = {x, y};
        this._window.move_frame(userOp, x, y);
    }

    _keepFixedWindowPosition() {
        this._signalIDs.push(
            this._window.connect(
                'position-changed',
                () => {
                    if (this._fixed &&
                        this._hasValidPosition() &&
                        this._needsMoveToParsedPosition()
                    ) {
                        if (this.windowInstanceId) {
                            this._moveFrameWithoutTrackingFeedback(
                                true,
                                this._x,
                                this._y
                            );
                        } else {
                            this._window.move_frame(true, this._x, this._y);
                        }
                        if (this._window.fullscreen)
                            this._window.unmake_fullscreen();
                    }
                }
            )
        );

        this._signalIDs.push(
            this._window.connect_after('size-changed', () => {
                if (this._fixed && this._hasValidPosition())
                    this._moveIntoPlace(true);
            })
        );

        this._signalIDs.push(
            this._window.connect('notify::minimized', () => {
                this._window.unminimize();
            })
        );

        this._signalIDs.push(
            this._window.connect('notify::maximized-vertically',
                () => {
                    if (typeof this._window.is_maximized === 'function' &&
                        !this._window.is_maximized()
                    )
                        this._window.maximize();
                    else if (!this._window.maximized_vertically)
                        this._window.maximize();
                    this._moveIntoPlace();
                }
            )
        );

        this._signalIDs.push(
            this._window.connect('notify::maximized-horizontally',
                () => {
                    if (typeof this._window.is_maximized === 'function' &&
                        !this._window.is_maximized()
                    )
                        this._window.maximize();
                    else if (!this._window.maximized_horizontally)
                        this._window.maximize();
                    this._moveIntoPlace();
                }
            )
        );

        if (this._needsMoveToParsedPosition()) {
            if (this.windowInstanceId)
                this._moveFrameWithoutTrackingFeedback(true, this._x, this._y);
            else
                this._window.move_frame(true, this._x, this._y);
        }
    }

    _moveIntoPlace(force = false) {
        if (this._moveIntoPlaceID)
            GLib.source_remove(this._moveIntoPlaceID);

        this._moveIntoPlaceID =
            GLib.timeout_add(GLib.PRIORITY_LOW, 250, () => {
                if (force || this._needsMoveToParsedPosition()) {
                    if (this.windowInstanceId) {
                        this._moveFrameWithoutTrackingFeedback(
                            true,
                            this._x,
                            this._y
                        );
                    } else {
                        this._window.move_frame(true, this._x, this._y);
                    }
                }


                this._moveIntoPlaceID = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    _trackWindowPosition() {
        this._trackingWindowPosition = true;
        this._signalIDs.push(
            this._window.connect('position-changed', () => {
                this._emitWindowPositionUpdate();
            })
        );
    }

    _emitWindowPositionUpdate() {
        if (!this.windowInstanceId || !this._remoteActionGroup)
            return;

        const frameRect = this._window.get_frame_rect?.();
        const x = frameRect?.x;
        const y = frameRect?.y;

        if (!Number.isFinite(x) || !Number.isFinite(y))
            return;

        if (this._suppressedTrackedWindowPosition &&
            this._suppressedTrackedWindowPosition.x === x &&
            this._suppressedTrackedWindowPosition.y === y
        ) {
            this._suppressedTrackedWindowPosition = null;
            return;
        }

        if (this._lastEmittedWindowPosition &&
            this._lastEmittedWindowPosition.x === x &&
            this._lastEmittedWindowPosition.y === y)
            return;


        this._lastEmittedWindowPosition = {
            x,
            y,
        };

        this._remoteActionGroup.activate_action(
            'updatePinnedWindowPosition',
            new GLib.Variant('(sii)', [this.windowInstanceId, x, y])
        );
    }

    _keepWindowHidden() {
        if (this._waylandClient)
            this._waylandClient.hide_from_window_list(this._window);
    }

    _unhideWindow() {
        if (this._waylandClient)
            this._waylandClient.show_in_window_list(this._window);
    }

    _keepWindowAtBottom() {
        if (this._restackedBottomID)
            global.display.disconnect(this._restackedBottomID);

        this._signalIDs.push(
            this._window.connect(
                'notify::above',
                () => {
                    if (this._keepAtBottom && this._window.above)
                        this._window.unmake_above();
                }
            )
        );

        this._signalIDs.push(
            this._window.connect_after(
                'raised',
                () => {
                    if (this._keepAtBottom)
                        this._window.lower();
                }
            )
        );

        /* If a window is lowered below us with shortcuts,
        detect and fix DING window */
        this._restackedBottomID = global.display.connect('restacked',
            this._syncToBottomOfStack.bind(this)
        );

        if (this._window.above)
            this._window.unmake_above();

        this._window.lower();
    }

    _keepWindowUnFullScreen() {
        this._signalIDs.push(
            this._window.connect(
                'notify::fullscreen',
                () => {
                    if (this._window.fullscreen)
                        this._window.unmake_fullscreen();
                }
            )
        );

        if (this._window.fullscreen)
            this._window.unmake_fullscreen();
    }

    _syncToBottomOfStack() {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace.list_windows();
        const windowStack = global.display.sort_windows_by_stacking(windows);

        if (windowStack.length === 0)
            return;

        const bottomWindow = windowStack[0];

        if (bottomWindow !== this._window)
            this._moveDesktopWindowToBottom();
    }

    _moveDesktopWindowToBottom() {
        if (this._window.fullscreen)
            this._window.unmake_fullscreen();

        if (this._keepAtBottom)
            this._window.lower();
    }

    _keepWindowOnTop() {
        if (this._restackedTopID)
            global.display.disconnect(this._restackedTopID);

        this._restackedTopID = global.display.connect('restacked',
            this._syncToTopOfStack.bind(this)
        );

        if (!this._window.above)
            this._window.make_above();

        this._window.raise();
    }

    _syncToTopOfStack() {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace.list_windows();
        const windowStack = global.display.sort_windows_by_stacking(windows);

        if (windowStack.length === 0)
            return;

        const topWindow = windowStack[windowStack.length - 1];

        if (topWindow !== this._window)
            this._window.raise();
    }


    _showWindowOnAllDesktops() {
        this._signalIDs.push(this._window.connect('notify::on-all-workspaces',
            this._checkOnAllWorkspaces.bind(this)
        ));

        this._signalIDs.push(this._window.connect('workspace-changed',
            this._checkOnAllWorkspaces.bind(this)
        ));

        this._window.stick();
    }

    _checkOnAllWorkspaces() {
        if (this._checkOnAllWorkspacesID)
            GLib.source_remove(this._checkOnAllWorkspacesID);

        this._checkOnAllWorkspacesID =
            GLib.idle_add(
                GLib.PRIORITY_LOW,
                () => {
                    if (this._showInAllDesktops &&
                        !this._window.on_all_workspaces
                    ) {
                        this._window.stick();
                        this._onIdleActivateTopWindowOnActiveWorkspace();
                    }

                    this._checkOnAllWorkspacesID = null;
                    return GLib.SOURCE_REMOVE;
                }
            );
    }

    _makeWindowTypeDesktop() {
        if (this._window.get_window_type() === Meta.WindowType.DESKTOP)
            return;

        if (typeof this._window.set_type === 'function') {
            this._window.set_type(Meta.WindowType.DESKTOP);
        } else {
            console
            .error('Meta.Window.set_type() is required for desktop windows');
            return;
        }

        // Window manager bug - it treats request to resize window
        // to monitor size as a fullscreen window request as well and makes
        // the window fullscreen for some apps.
        // This makes intellihide for docks/panels hide from desktop window
        this._keepWindowUnFullScreen();

        const activateTopWindowOnWorkspace = true;
        this._onIdleChangedStatusCallback({activateTopWindowOnWorkspace});
    }

    _raiseDesktopAsDockWindow() {
        this._makeWindowTypeNormal();
        // Keep it raised without using DOCK so focus behavior stays normal.
        this._keepWindowUnFullScreen();
        this._keepWindowOnTop();
        this._showWindowOnAllDesktops();
    }

    _makeWindowTypeNormal() {
        if (this._window.get_window_type() === Meta.WindowType.NORMAL)
            return;

        if (typeof this._window.set_type === 'function') {
            this._window.set_type(Meta.WindowType.NORMAL);
        } else {
            console
            .error('Meta.Window.set_type() is required for normal windows');
        }
    }

    _onIdleActivateTopWindowOnActiveWorkspace() {
        const activateTopWindowOnWorkspace = true;
        this._onIdleChangedStatusCallback({activateTopWindowOnWorkspace});
    }

    _makeWindowTypeDock() {
        if (this._window.get_window_type() === Meta.WindowType.DOCK)
            return;

        if (typeof this._window.set_type === 'function') {
            this._window.set_type(Meta.WindowType.DOCK);
        } else {
            console
            .error('Meta.Window.set_type() is required for dock windows');
            return;
        }

        this._keepWindowUnFullScreen();
    }

    refreshProperties(forceBehaviorRefresh = false) {
        const nextParsed =
            this._buildParsedTitleState(this._window.get_title());

        if (forceBehaviorRefresh) {
            this._reloadWindowControllers(nextParsed);
            return;
        }

        const currentParsed =
            this._parsedTitleState ?? this._buildParsedTitleState(null);

        if (this._parsedTitleStateEquals(currentParsed, nextParsed))
            return;

        if (this._parsedTitleBehaviorEquals(currentParsed, nextParsed)) {
            this._applyParsedTitlePosition(nextParsed);

            if (this._trackingWindowPosition)
                return;

            if (this._needsMoveToParsedPosition()) {
                if (this.windowInstanceId)
                    this._moveFrameWithoutTrackingFeedback(true, this._x, this._y);
                else
                    this._window.move_frame(true, this._x, this._y);
            }

            return;
        }

        this._reloadWindowControllers(nextParsed);
    }

    setRaisedAsDock(raised) {
        if (!this._desktopWindow)
            return;

        const nextState = !!raised;
        if (this._raiseDesktopAsDock === nextState)
            return;

        this._raiseDesktopAsDock = nextState;
        const force = true;
        this.refreshProperties(force);
    }

    toggleRaisedAsDock() {
        this.setRaisedAsDock(!this._raiseDesktopAsDock);
    }

    get raisedAsDock() {
        return this._raiseDesktopAsDock;
    }

    get hideFromWindowList() {
        return this._hideFromWindowList;
    }

    get keepAtBottom() {
        return this._keepAtBottom;
    }

    get desktopWindow() {
        return this._desktopWindow;
    }
}

var WindowTypeManager = class {
    /*
     This class handles DING window registration and window-type management.
     Just make one instance of it, call enable(), and whenever a window
     that you want to give "superpowers" is mapped, add it with the
     "addWindowManagedCustomJS_ding" method. That's all.
     */
    constructor() {
        this._windowList = new Set();
        this._overviewHiding = true;
        this._waylandClient = null;
        this._remoteActionGroup = null;
    }

    set_wayland_client(client) {
        this._waylandClient = client;

        for (let window of this._windowList) {
            if (window.customJS_ding)
                window.customJS_ding.set_wayland_client(this._waylandClient);
        }
    }

    setRemoteActionGroup(remoteActionGroup) {
        this._remoteActionGroup = remoteActionGroup;

        for (let window of this._windowList) {
            if (window.customJS_ding) {
                window.customJS_ding.setRemoteActionGroup(
                    this._remoteActionGroup
                );
            }
        }
    }

    enable() {
        this._idMap =
            global.window_manager.connect_after(
                'map',
                (obj, windowActor) => {
                    const window = windowActor.get_meta_window();

                    if (window.get_window_type() > Meta.WindowType.MODAL_DIALOG)
                        return;

                    const appid = window.get_gtk_application_id();

                    if (appid !== appID)
                        return;

                    const windowpid = window.get_pid();
                    const mypid = this._waylandClient
                        ? parseInt(this._waylandClient.query_pid_of_program())
                        : null;

                    if (this._waylandClient &&
                        this._waylandClient.query_window_belongs_to(window)
                    ) {
                        this._addWindowManagedCustomJS_ding(
                            window,
                            windowActor
                        );

                        return;
                    }

                    if (mypid !== null && windowpid === mypid) {
                        this._addWindowManagedCustomJS_ding(
                            window,
                            windowActor
                        );
                    }
                }
            );

        /* But in Overview mode it is paramount to not change the workspace to
             emulate "stick", or the windows will appear
         */
        this._showingId = Main.overview.connect('showing', () => {
            this._overviewHiding = false;
        });

        this._hidingId = Main.overview.connect('hiding', () => {
            this._overviewHiding = true;
        });
    }

    disable() {
        if (this._activate_window_ID) {
            GLib.source_remove(this._activate_window_ID);
            this._activate_window_ID = null;
        }

        for (let window of this._windowList)
            this._clearWindow(window);

        this._windowList.clear();

        // disconnect signals
        if (this._idMap) {
            global.window_manager.disconnect(this._idMap);
            this._idMap = null;
        }

        if (this._idDestroy) {
            global.window_manager.disconnect(this._idDestroy);
            this._idDestroy = null;
        }

        if (this._showingId) {
            Main.overview.disconnect(this._showingId);
            this._showingId = null;
        }

        if (this._hidingId) {
            Main.overview.disconnect(this._hidingId);
            this._hidingId = null;
        }
    }

    _addWindowManagedCustomJS_ding(window, windowActor) {
        if (window.get_meta_window) { // it is a MetaWindowActor
            window = window.get_meta_window();
        }

        if (this._windowList.has(window))
            return;

        window.customJS_ding =
            new ManageWindow(
                window,
                this._waylandClient,
                this._remoteActionGroup,
                this.onIdleReStackActivteWindows.bind(this)
            );

        window.actor = windowActor;
        windowActor._delegate = new HandleDragActors(windowActor);
        this._windowList.add(window);

        window.customJS_ding.unmanagedID =
            window.connect(
                'unmanaging',
                win => {
                    this._clearWindow(win);
                    this._windowList.delete(window);
                }
            );
    }

    _clearWindow(window) {
        if (!window?.customJS_ding)
            return;

        if (window.customJS_ding.unmanagedID) {
            window.disconnect(window.customJS_ding.unmanagedID);
            window.customJS_ding.unmanagedID = 0;
        }

        window.customJS_ding.disconnect();
        window.customJS_ding = null;

        if (window.actor)
            window.actor._delegate = null;
        window.actor = null;
    }

    _activateTopWindowOnActiveWorkspace() {
        let windows =
            global.display
            .get_tab_list(
                Meta.TabList.NORMAL,
                global.workspace_manager.get_active_workspace()
            );

        windows = global.display.sort_windows_by_stacking(windows);

        if (windows.length) {
            const topWindow = windows[windows.length - 1];
            topWindow.focus(Clutter.CURRENT_TIME);
        }
    }

    _moveDesktopWindowToBottom() {
        for (let window of this._windowList)
            window.customJS_ding._moveDesktopWindowToBottom();
    }

    onIdleReStackActivteWindows(action = {activateTopWindowOnWorkspace: true}) {
        if (!this._activate_window_ID) {
            this._activate_window_ID =
                GLib.idle_add(
                    GLib.PRIORITY_LOW,
                    () => {
                        if (this._overviewHiding) {
                            if (action.moveDesktopWindowToBottom)
                                this._moveDesktopWindowToBottom();

                            if (action.activateTopWindowOnWorkspace)
                                this._activateTopWindowOnActiveWorkspace();
                        }

                        this._activate_window_ID = null;
                        return GLib.SOURCE_REMOVE;
                    }
                );
        }
    }

    // After shell unlock, window seems to lose stick property,
    // refresh window properties
    refreshWindows() {
        for (let window of this._windowList)
            window.customJS_ding.refreshProperties(true);
    }

    setWindowsRaisedAsDock(raised, window = null) {
        if (window?.customJS_ding) {
            window.customJS_ding.setRaisedAsDock(raised);
            return;
        }

        for (let managedWindow of this._windowList) {
            if (!managedWindow.customJS_ding)
                continue;

            managedWindow.customJS_ding.setRaisedAsDock(raised);
        }
    }

    toggleWindowsRaisedAsDock(window = null) {
        if (window?.customJS_ding) {
            window.customJS_ding.toggleRaisedAsDock();
            return;
        }

        for (let managedWindow of this._windowList) {
            if (!managedWindow.customJS_ding)
                continue;

            this.setWindowsRaisedAsDock(
                !managedWindow.customJS_ding.raisedAsDock
            );
            return;
        }
    }
};

class HandleDragActors {
    /* This class is added to each managed windowActor, and it's used to
       make it behave like a shell Actor that can accept drops from
       Gnome Shell dnd.
    */

    constructor(windowActor) {
        this.windowActor = windowActor;
        this.remoteDingActions = Gio.DBusActionGroup.get(
            Gio.DBus.session,
            appID,
            appPath
        );
    }

    _getModifierKeys() {
        let [, , state] = global.get_pointer();
        state &= Clutter.ModifierType.MODIFIER_MASK;
        this.isControl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        this.isShift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
    }

    handleDragOver(source) {
        if ((source.app ?? null) === null)
            return DND.DragMotionResult.NO_DROP;

        this._getModifierKeys();

        if (this.isShift)
            return DND.DragMotionResult.COPY_DROP;

        if (this.isControl)
            return DND.DragMotionResult.MOVE_DROP;

        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, actor, x, y) {
        if ((source.app ?? null) === null)
            return false;

        let appFavorites = AppFavorites.getAppFavorites();
        let sourceAppId = source.app.get_id();
        let sourceAppPath = source.app.appInfo.get_filename();
        let appIsFavorite = appFavorites.isFavorite(sourceAppId);

        this._getModifierKeys();

        if (appIsFavorite && !this.isShift)
            appFavorites.removeFavorite(sourceAppId);

        if (sourceAppPath && (this.isControl || this.isShift)) {
            this.remoteDingActions.activate_action('createDesktopShortcut',
                new GLib.Variant('a{sv}', {
                    uri: GLib.Variant.new_string(`file://${sourceAppPath}`),
                    X: new GLib.Variant('i', parseInt(x)),
                    Y: new GLib.Variant('i', parseInt(y)),
                })
            );
        }

        appFavorites.emit('changed');
        return true;
    }
}
