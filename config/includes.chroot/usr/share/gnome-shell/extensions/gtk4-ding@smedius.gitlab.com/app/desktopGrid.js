/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Gtk4 Port Copyright (C) 2022 - 2025 Sundeep Mediratta (smedius@gmail.com)
 * Copyright (C) 2019 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
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
import {GObject, Gtk, Gdk, GLib, Gio, Graphene, Gsk, Adw} from '../dependencies/gi.js';
import {_} from '../dependencies/gettext.js';

export {DesktopGrid};

// eslint-disable-next-line no-unused-vars
const DisplayGrid = class {
    constructor(params) {
        const {
            desktopManager,
            desktopName,
            desktopDescription,
            asDesktop,
            hidden = false,
            desktopIndex = 0,
        } = params;
        this._destroying = false;
        this._desktopManager = desktopManager;
        this._mainapp = desktopManager.mainApp;
        this._dragManager = desktopManager.dragManager;
        this.Prefs = this._desktopManager.Prefs;
        this.DesktopIconsUtil = this._desktopManager.DesktopIconsUtil;
        this.DBusUtils = this._desktopManager.DBusUtils;
        this.Enums = this._desktopManager.Enums;
        this.elementSpacing = this.Enums.GRID_ELEMENT_SPACING;
        this.gridPadding = this.Enums.GRID_PADDING;
        this._desktopName = desktopName;
        this._desktopIndex = desktopIndex;
        this._asDesktop = asDesktop;
        this._desktopDescription = desktopDescription;
        this._hidden = hidden;
        this.directoryOpenTimer = null;
        this.windowGlobalRectangle = new Gdk.Rectangle();
        this._updateWindowGeometry();
        this._updateUnscaledHeightWidthMargins();
        this._createGrids();

        this._window =
            new Gtk.ApplicationWindow(
                {
                    application: desktopManager.mainApp,
                    'title': desktopName,
                }
            );

        this._window.update_property(
            [Gtk.AccessibleProperty.LABEL],
            [_('Desktop Icons')]
        );

        if (this._asDesktop) {
            this._window.set_decorated(false);
            this._window.set_deletable(false);
            this._window.set_resizable(false);

            // Transparent Background only if this is working as a desktop
            this._window.set_name('desktopwindow');

            this._window
                .set_default_size(this._windowWidth, this._windowHeight);

            this._window
                .set_size_request(this._windowWidth, this._windowHeight);

            this._mappedPromise =
                new Promise(resolve => (this._resolveMapped = resolve));

            // Wayland compositor may hang on some high-resolution displays
            // unless windows are maximized before first map.
            this._window.maximize();

            this._window.connect('map', () => {
                if (!this._resolveMapped)
                    return;
                this._resolveMapped(true);
                this._resolveMapped = null;
                // Maximize however creates an error where the window can
                // be moved by the user by dragging down on top panel.
                // So we unmaximize all windows after they are mapped
                // as maximization is not needed anymore.
                this._window.unmaximize();
            });
        } else {
            // Opaque black test window
            this._window.set_name('testwindow');
        }

        // Remove any other css classes, even if applied by other apps later
        this._window.set_css_classes(['background']);
        this._window.connect('notify::css_classes', () => {
            this._window.set_css_classes(['background']);
        });

        this._window.connect(
            'close-request',
            () => {
                if (this._destroying)
                    return false;

                if (this._asDesktop) {
                    // Do not destroy window when closing if the instance
                    // is working as desktop
                    return true;
                } else {
                    // Exit if this instance is working as an
                    // stand-alone window
                    this._desktopManager.terminateProgram();
                    return false;
                }
            }
        );

        // New: one fixed root that contains both layers
        this._rootFixed = new Gtk.Fixed();
        this._rootFixed.set_size_request(this._windowWidth, this._windowHeight);

        this._container = new Gtk.Fixed();
        this._containerContext = this._container.get_style_context();
        this._container.set_size_request(this._windowWidth, this._windowHeight);
        this._containerContext.add_class('unhighlightdroptarget');

        // icon grid goes in rootFixed
        this._rootFixed.put(this._container, 0, 0);

        this._overlay = new Gtk.Overlay();
        this._overlay.set_hexpand(true);
        this._overlay.set_vexpand(true);
        this._overlay.set_child(this._rootFixed);

        this._window.set_child(this._overlay);

        this.gridGlobalRectangle = new Gdk.Rectangle();
        this._selectedList = null;
        this._setGridStatus();

        this._updateGridRectangle();
    }

    ensureMapped() {
        // show/present only here after the window is fully set up to
        // and to avoit commiting content too early so that the shell
        // errors on commiting first frame before acknowleding ack from wayland
        // compositor.
        this._window.set_visible(!this._hidden);
        this._window.present();
        return this._mappedPromise;
    }

    ensureAllocationComplete() {
        if (this._allocPromise)
            return this._allocPromise;

        const w = this._container;

        this._allocPromise = new Promise(resolve => {
            let tickId = 0;
            let stableFrames = 0;

            const cleanup = () => {
                if (tickId)
                    w.remove_tick_callback(tickId);
                this._allocPromise = null;
            };

            const isAllocated = () => {
                const aw = w.get_allocated_width();
                const ah = w.get_allocated_height();
                return aw > 0 && ah > 0;
            };

            if (isAllocated()) {
                this._overlay.queue_draw();
                resolve();
                cleanup();
                return;
            }

            tickId = w.add_tick_callback(() => {
                if (isAllocated())
                    stableFrames++;
                else
                    stableFrames = 0;

                if (stableFrames >= 2) {
                    cleanup();
                    this._overlay.queue_draw();
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });
        });

        return this._allocPromise;
    }

    setErrorState() {
        this._window.set_name('errorstate');
    }

    unsetErrorState() {
        if (this._asDesktop)
            this._window.set_name('desktopwindow');
        else
            this._window.set_name('testwindow');
    }

    hide() {
        this._window.hide();
        this._hidden = true;
    }

    show() {
        this._window.present();
        this._hidden = false;
    }

    getWindow() {
        return this._window;
    }

    queue_draw() {
        this._container.queue_draw();
        this._overlay.queue_draw();
        this._window.queue_draw();
    }

    // Establish and update window geometry, establish and update
    // grid for the desktop icons

    updateGridDescription(desktopDescription) {
        this._desktopDescription = desktopDescription;
    }

    _updateWindowGeometry() {
        this._zoom = this._desktopDescription.zoom;
        this._x = this._desktopDescription.x;
        this._y = this._desktopDescription.y;
        this._monitor = this._desktopDescription.monitorIndex;

        // GNOME Shell reports logical coordinates when the scale factor is 1.
        // In that case, DING should not divide the geometry by zoom again.
        const coordinatesAreLogical =
            this._desktopDescription.scaleFactor === 1;

        this._sizer = coordinatesAreLogical ? 1 : this._desktopDescription.zoom;

        this._windowWidth =
            Math.floor(this._desktopDescription.width / this._sizer);
        this._windowHeight =
            Math.floor(this._desktopDescription.height / this._sizer);
        this.windowGlobalRectangle.x = this._x;
        this.windowGlobalRectangle.y = this._y;
        this.windowGlobalRectangle.width = this._windowWidth;
        this.windowGlobalRectangle.height = this._windowHeight;
    }

    resizeWindow() {
        this._updateWindowGeometry();
        this._desktopName = `@!${this._x},${this._y};BDHF`;
        this._window.set_title(this._desktopName);
        this._window.set_default_size(this._windowWidth, this._windowHeight);
        this._window.set_size_request(this._windowWidth, this._windowHeight);
        this.scale = this._window.get_scale_factor();
    }

    _updateUnscaledHeightWidthMargins() {
        this._marginLeftHiddenObject = false;
        this._marginRightHiddenObject = false;
        this._marginTopHiddenObject = false;
        this._marginBottomHiddenObject = false;

        this._marginTop = this._desktopDescription.marginTop + this.gridPadding;

        if (this._marginTop > 1000) {
            this._marginTopHiddenObject = true;
            this._marginTop -= 1000;
        }

        this._marginBottom =
            this._desktopDescription.marginBottom + this.gridPadding;

        if (this._marginBottom > 1000) {
            this._marginBottomHiddenObject = true;
            this._marginBottom -= 1000;
        }

        this._marginLeft =
            this._desktopDescription.marginLeft + this.gridPadding;

        if (this._marginLeft > 1000) {
            this._marginLeftHiddenObject = true;
            this._marginLeft -= 1000;
        }

        this._marginRight =
            this._desktopDescription.marginRight + this.gridPadding;

        if (this._marginRight > 1000) {
            this._marginRightHiddenObject = true;
            this._marginRight -= 1000;
        }

        this._width =
            this._desktopDescription.width -
            this._marginLeft -
            this._marginRight;

        this._height =
            this._desktopDescription.height -
            this._marginTop -
            this._marginBottom;
    }

    _createGrids() {
        this._width = Math.floor(this._width / this._sizer);
        this._height = Math.floor(this._height / this._sizer);
        this._marginTop = Math.floor(this._marginTop / this._sizer);
        this._marginBottom = Math.floor(this._marginBottom / this._sizer);
        this._marginLeft = Math.floor(this._marginLeft / this._sizer);
        this._marginRight = Math.floor(this._marginRight / this._sizer);

        this._maxColumns =
            Math.floor(
                this._width /
                (this.Prefs.DesiredWidth + 4 * this.elementSpacing)
            );

        this._maxRows =
            Math.floor(
                this._height /
                (this.Prefs.DesiredHeight + 4 * this.elementSpacing)
            );

        this._elementWidth = Math.floor(this._width / this._maxColumns);
        this._elementHeight = Math.floor(this._height / this._maxRows);
    }

    _updateGridRectangle() {
        this.gridGlobalRectangle.x = this._x + this._marginLeft;
        this.gridGlobalRectangle.y = this._y + this._marginTop;
        this.gridGlobalRectangle.width = this._width;
        this.gridGlobalRectangle.height = this._height;
    }

    _sizeContainer(widget) {
        widget.margin_top = this._marginTop;
        widget.margin_bottom = this._marginBottom;
        const leftToRight = widget.get_direction() === Gtk.TextDirection.LTR;
        if (leftToRight) {
            widget.margin_start = this._marginLeft;
            widget.margin_end = this._marginRight;
        } else {
            widget.margin_start = this._marginRight;
            widget.margin_end = this._marginLeft;
        }
    }

    _setGridStatus() {
        this._fileItems = new Map();
        this._gridStatus = new Map();
        for (let y = 0; y < this._maxRows; y++) {
            for (let x = 0; x < this._maxColumns; x++)
                this._gridStatus.set(y * this._maxColumns + x, new Set());
        }
    }

    resizeGrid() {
        this._updateUnscaledHeightWidthMargins();
        this._createGrids();
        // Ensure event targets cover the full window even when no icons/widgets
        this._container.set_size_request(this._windowWidth, this._windowHeight);
        this._rootFixed.set_size_request(this._windowWidth, this._windowHeight);
        this._sizeContainer(this._container);

        this._updateGridRectangle();
        this._setGridStatus();
    }

    destroy() {
        this._destroying = true;
        this._window.destroy();
    }

    recomputeGridPosition(column, row) {
        if (column > this._maxColumns)
            return [this._x, this._y];

        if (row > this._maxRows)
            return [this._x, this._y];

        const [localX, localY] =
            this._getLocalCoordinatesForGrid(column, row);

        const [newGlobalX, newGlobalY] =
            this.coordinatesLocalToGlobal(localX, localY);

        return [newGlobalX, newGlobalY];
    }

    // Compute correct position for pop up menus relative to
    // margins to prevent going under/over margins

    getIntelligentPosition(gdkRectangle) {
        if (!this._marginLeftHiddenObject &&
            !this._marginRightHiddenObject &&
            !this._marginTopHiddenObject &&
            !this._marginBottomHiddenObject)
            return null;

        var clickLocation = 'center';

        if (this._marginLeft > 0 &&
            (gdkRectangle.x < (this._marginLeft * 2))
        )
            clickLocation = 'left';

        if (this._marginRight > 0 &&
            (
                gdkRectangle.x + gdkRectangle.width >
                (this._windowWidth - this._marginRight * 2.5)
            )
        )
            clickLocation = 'right';

        if (this._marginBottom > 0 &&
            (
                gdkRectangle.y + gdkRectangle.height >
                (this._windowHeight - this._marginBottom * 2)
            )
        ) {
            switch (clickLocation) {
            case 'left':
                clickLocation = 'bottomLeft';
                break;
            case 'right':
                clickLocation = 'bottomRight';
                break;
            default:
                clickLocation = 'bottom';
            }
        }

        if (this._marginTop > 0 &&
            (
                gdkRectangle.y < (this._marginTop * 2)
            )
        ) {
            switch (clickLocation) {
            case 'left':
                clickLocation = 'topLeft';
                break;
            case 'right':
                clickLocation = 'topRight';
                break;
            default:
                clickLocation = 'top';
            }
        }

        var returnvalue;

        switch (clickLocation) {
        case 'left':
            if (this._marginLeftHiddenObject)
                returnvalue = Gtk.PositionType.RIGHT;
            else
                returnvalue = null;

            break;

        case 'right':
            if (this._marginRightHiddenObject)
                returnvalue = Gtk.PositionType.LEFT;
            else
                returnvalue = null;

            break;

        case 'top':
            if (this._marginTopHiddenObject)
                returnvalue = Gtk.PositionType.BOTTOM;
            else
                returnvalue = null;

            break;

        case 'bottom':
            if (this._marginBottomHiddenObject)
                returnvalue = Gtk.PositionType.TOP;
            else
                returnvalue = null;

            break;

        case 'center':
            returnvalue = null;
            break;

        case 'bottomRight':
            if (this._marginBottomHiddenObject &&
                this._marginRightHiddenObject) {
                returnvalue = Gtk.PositionType.LEFT;
                break;
            }

            if (this._marginBottomHiddenObject) {
                returnvalue = Gtk.PositionType.TOP;
                break;
            }

            if (this._marginRightHiddenObject) {
                returnvalue = Gtk.PositionType.LEFT;
                break;
            }

            break;

        case 'bottomLeft':
            if (this._marginBottomHiddenObject &&
                this._marginLeftHiddenObject) {
                returnvalue = Gtk.PositionType.RIGHT;
                break;
            }

            if (this._marginBottomHiddenObject) {
                returnvalue = Gtk.PositionType.TOP;
                break;
            }

            if (this._marginLeftHiddenObject) {
                returnvalue = Gtk.PositionType.RIGHT;
                break;
            }

            break;

        case 'topRight':
            if (this._marginTopHiddenObject && this._marginRightHiddenObject) {
                returnvalue = Gtk.PositionType.LEFT;
                break;
            }

            if (this._marginTopHiddenObject) {
                returnvalue = Gtk.PositionType.BOTTOM;
                break;
            }

            if (this._marginRightHiddenObject) {
                returnvalue = Gtk.PositionType.LEFT;
                break;
            }

            break;

        case 'topLeft':
            if (this._marginTopHiddenObject && this._marginLeftHiddenObject) {
                returnvalue = Gtk.PositionType.RIGHT;
                break;
            }
            if (this._marginTopHiddenObject) {
                returnvalue = Gtk.PositionType.BOTTOM;
                break;
            }
            if (this._marginLeftHiddenObject) {
                returnvalue = Gtk.PositionType.RIGHT;
                break;
            }
            break;

        default:
            returnvalue = null;
        }

        return returnvalue;
    }

    // Functions for computing postion/Geometry

    _getColumnRowFromLocal(x, y) {
        // Returns the column, row of the grid that holds the local x, y
        let placeX = Math.floor(x / this._elementWidth);
        let placeY = Math.floor(y / this._elementHeight);
        placeX = this.DesktopIconsUtil.clamp(placeX, 0, this._maxColumns - 1);
        placeY = this.DesktopIconsUtil.clamp(placeY, 0, this._maxRows - 1);

        return [placeX, placeY];
    }

    _getGridLocalCoordinates(x, y) {
        // Returns the local grid coordinates of top left rectangle
        // vertex of the grid that has local x,y
        const [column, row] = this._getColumnRowFromLocal(x, y);

        return this._getLocalCoordinatesForGrid(column, row);
    }

    _getLocalCoordinatesForGrid(column, row) {
        const localX = Math.floor(this._width * column / this._maxColumns);
        const localY = Math.floor(this._height * row / this._maxRows);

        return [localX, localY];
    }

    getDistance(x) {
        // Returns the distance to the middle point of this grid from X //
        return Math.pow(x - (this._x + this._windowWidth * this._sizer / 2), 2) +
            Math.pow(x - (this._y + this._windowHeight * this._sizer / 2), 2);
    }

    _coordinatesGlobalToLocal(X, Y, widget = null) {
        const [windowX, windowY] = this._coordinatesGlobalToWindow(X, Y);
        const sourcePoint = new Graphene.Point({x: windowX, y: windowY});

        if (!widget)
            widget = this._container;

        const [found, targetPoint] =
            this._window.compute_point(widget, sourcePoint);

        if (!found)
            return [0, 0];

        return [targetPoint.x, targetPoint.y];
    }

    _coordinatesGlobalToWindow(X, Y) {
        X -= this._x;
        Y -= this._y;
        return [X, Y];
    }

    _coordinatesWidgetToWidget(x, y, widget1, widget2) {
        const sourcePoint = new Graphene.Point({x, y});
        const [found, targetPoint] =
            widget1.compute_point(widget2, sourcePoint);

        if (!found)
            return [0, 0];

        return [targetPoint.x, targetPoint.y];
    }

    coordinatesLocalToWindow(x, y, widget = null) {
        if (!widget)
            widget = this._container;

        const sourcePoint = new Graphene.Point({x, y});
        const [found, targetPoint] =
            widget.compute_point(this._window, sourcePoint);

        if (!found)
            return [0, 0];

        return [targetPoint.x, targetPoint.y];
    }

    coordinatesLocalToGlobal(x, y, widget = null) {
        const [X, Y] = this.coordinatesLocalToWindow(x, y, widget);

        return [X + this._x, Y + this._y];
    }

    coordinatesBelongToThisGrid(X, Y) {
        const checkRectangle =
            new Gdk.Rectangle(
                {
                    x: X,
                    y: Y,
                    width: 1,
                    height: 1,
                }
            );

        return this.gridGlobalRectangle.intersect(checkRectangle)[0];
    }

    coordinatesBelongToThisGridWindow(X, Y) {
        const checkRectangle =
            new Gdk.Rectangle(
                {
                    x: X,
                    y: Y,
                    width: 1,
                    height: 1,
                }
            );

        return this.windowGlobalRectangle.intersect(checkRectangle)[0];
    }

    getGlobaltoLocalRectangle(gdkRectangle) {
        const [X, Y] =
            this._coordinatesGlobalToLocal(gdkRectangle.x, gdkRectangle.y);

        return new Gdk.Rectangle(
            {
                x: X,
                y: Y,
                width: gdkRectangle.width,
                height: gdkRectangle.height,
            }
        );
    }

    getCoordinatesOfGridContaining(X, Y, globalCoordinates = false) {
        // returns the local or global coordinates if requested,
        // of the local grid rectangle top left vertex that contains x, y

        if (this.coordinatesBelongToThisGrid(X, Y)) {
            const [x, y] = this._coordinatesGlobalToLocal(X, Y);

            if (globalCoordinates) {
                const a =
                    this._elementWidth *
                    Math.floor((x / this._elementWidth) + 0.5);

                const b =
                    this._elementHeight *
                    Math.floor((y / this._elementHeight) + 0.5);

                return this.coordinatesLocalToGlobal(a, b);
            } else {
                return this._getGridLocalCoordinates(x, y);
            }
        } else {
            return null;
        }
    }

    // Functions to query and set grid use by Icons and files

    _fileAtColumnRow(column, row) {
        // only works for grid placement of icons,
        // with free placements there maybe multiple fileItems per grid

        const setOfFileItemsOnGridNumber =
            this._gridStatus.get(row * this._maxColumns + column);

        if (!this.Prefs.freePositionIcons && setOfFileItemsOnGridNumber.size) {
            for (const fileItem of setOfFileItemsOnGridNumber.keys())
                return fileItem;
        }

        return null;
    }

    _fileAt(x, y) {
        if (!this.Prefs.freePositionIcons) {
            const [column, row] = this._getColumnRowFromLocal(x, y);

            return this._fileAtColumnRow(column, row);
        }

        const widgetAtPointer =
            this._container.pick(x, y, Gtk.PickFlags.GTK_PICK_DEFAULT);

        if (widgetAtPointer === this._container)
            return null;

        let fileItemFound = null;
        for (const fileItem of this._fileItems.keys()) {
            const [widgetX, widgetY] =
                this._coordinatesWidgetToWidget(
                    x, y,
                    this._container,
                    fileItem.container
                );

            if (widgetX === 0 && widgetY === 0)
                continue;

            const localWidget =
                fileItem.container.pick(
                    widgetX,
                    widgetY,
                    Gtk.PickFlags.GTK_PICK_DEFAULT
                );

            if (localWidget === widgetAtPointer) {
                fileItemFound = fileItem;

                break;
            }
        }

        return fileItemFound;
    }

    isAvailable() {
        // Returns true if there is an available slot in the grid
        let isFree = false;
        for (const [, setOfFileItemsOnGridNumber] of this._gridStatus.entries()
        ) {
            if (!setOfFileItemsOnGridNumber.size) {
                isFree = true;

                break;
            }
        }

        return isFree;
    }

    _setUseColumnRowOverlappingThis(fileItem, column, row, X, Y) {
        this._setGridUse(column, row, fileItem);
        const Xr = X + this._elementWidth - 2;
        const Yr = Y + this._elementHeight - 2;
        const [xr, yr] = this._coordinatesGlobalToLocal(Xr, Yr);
        const [bottomRightColumn, bottomRightRow] =
            this._getColumnRowFromLocal(xr, yr);

        if (bottomRightColumn !== column &&
            bottomRightRow !== row) {
            this._setGridUse(bottomRightColumn, bottomRightRow, fileItem);
            this._setGridUse(column, bottomRightRow, fileItem);
            this._setGridUse(bottomRightColumn, row, fileItem);

            return;
        }

        if (bottomRightColumn === column && bottomRightRow !== row) {
            this._setGridUse(column, bottomRightRow, fileItem);

            return;
        }

        if (bottomRightColumn !== column && bottomRightRow === row)
            this._setGridUse(bottomRightColumn, row, fileItem);
    }

    _isEmptyAt(column, row) {
        // returns if grid at column row has a file or not
        const setOfFileItemsOnGridNumber =
            this._gridStatus.get(row * this._maxColumns + column);

        return setOfFileItemsOnGridNumber.size === 0;
    }

    _gridInUse(x, y) {
        // returns if the local grid containing local coordinates
        // x, y has a file assigned.
        const [placeX, placeY] = this._getColumnRowFromLocal(x, y);

        return !this._isEmptyAt(placeX, placeY);
    }

    _setGridUse(column, row, fileItem) {
        const setOfFileItemsOnGridNumber =
            this._gridStatus.get(row * this._maxColumns + column);
        setOfFileItemsOnGridNumber.add(fileItem);
    }

    _getEmptyPlaceClosestTo(x, y, coordinatesAction, reverseHorizontal) {
        // returns the column row of empty grid available at global X, Y
        let cornerInversion = this.Prefs.StartCorner;

        if (reverseHorizontal)
            cornerInversion[0] = !cornerInversion[0];

        const [placeX, placeY] = this._getColumnRowFromLocal(x, y);

        if (this._isEmptyAt(placeX, placeY) &&
            coordinatesAction !== this.Enums.StoredCoordinates.ASSIGN)
            return [placeX, placeY];

        let found = false;
        let resColumn = null;
        let resRow = null;
        let minDistance = Infinity;
        let column, row;

        for (let tmpColumn = 0; tmpColumn < this._maxColumns; tmpColumn++) {
            if (cornerInversion[0])
                column = this._maxColumns - tmpColumn - 1;
            else
                column = tmpColumn;

            for (let tmpRow = 0; tmpRow < this._maxRows; tmpRow++) {
                if (cornerInversion[1])
                    row = this._maxRows - tmpRow - 1;
                else
                    row = tmpRow;

                if (!this._isEmptyAt(column, row))
                    continue;

                let proposedX = column * this._elementWidth;
                let proposedY = row * this._elementHeight;
                if (coordinatesAction === this.Enums.StoredCoordinates.ASSIGN)
                    return [column, row];
                let distance =
                    this.DesktopIconsUtil.distanceBetweenPoints(
                        proposedX,
                        proposedY,
                        x, y
                    );

                if (distance < minDistance) {
                    found = true;
                    minDistance = distance;
                    resColumn = column;
                    resRow = row;
                }
            }
        }

        if (!found)
            throw new Error('No available space on the monitor');


        return [resColumn, resRow];
    }

    // Finally the actual code that places and removes icons on the desktop

    _addFileItemToGrid(fileItem, column, row, coordinatesAction) {
        if (this._destroying)
            return;

        let [localX, localY] = this._getLocalCoordinatesForGrid(column, row);

        localX += this.elementSpacing;
        localY += this.elementSpacing;

        this._container.put(fileItem.container, localX, localY);
        this._setGridUse(column, row, fileItem);

        fileItem.column = column;
        fileItem.row = row;

        this._fileItems.set(fileItem, [localX, localY]);

        const [X, Y] = this.coordinatesLocalToGlobal(localX, localY);

        fileItem.setCoordinates(
            X,
            Y,
            this._elementWidth - 2 * this.elementSpacing,
            this._elementHeight - 2 * this.elementSpacing,
            this.elementSpacing,
            this
        );

        /* If this file is new in the Desktop and hasn't yet
         * fixed coordinates, store the new position to ensure
         * that the next time it will be shown in the same position.
         * Also store the new position if it has been moved by the user,
         * and not triggered by a screen change.
         */
        if ((fileItem.savedCoordinates === null) ||
            (coordinatesAction === this.Enums.StoredCoordinates.OVERWRITE)) {
            const [normalizedX, normalizedY] =
                this.getNormalizedCoordinates(localX, localY);

            const array = [X, Y, normalizedX, normalizedY, this._monitor];

            fileItem.writeSavedCoordinates(array);
        }
    }

    removeItem(fileItem) {
        if (this._fileItems.has(fileItem))
            this._fileItems.delete(fileItem);

        this._gridStatus.forEach(
            setOfFileItemsOnGridNumber =>
                setOfFileItemsOnGridNumber.delete(fileItem)
        );

        this._container.remove(fileItem.container);
    }

    _placeIntoPosition(
        fileItem,
        X, Y,
        x, y,
        emptycolumn,
        emptyrow,
        coordinatesAction
    ) {
        // For sanpping to grid
        if (fileItem.savedCoordinates == null ||
            (fileItem.savedCoordinates[0] === 0 &&
            fileItem.savedCoordinates[1] === 0) ||
            !this.Prefs.freePositionIcons ||
            this.Prefs.keepArranged ||
            this.Prefs.keepStacked
        ) {
            this._addFileItemToGrid(
                fileItem,
                emptycolumn,
                emptyrow,
                coordinatesAction
            );

            return;
        }

        if (this._destroying)
            return;

        // For free placement

        // Make sure the icon lands inside the grid and does not protrude out
        const [currentColumn, currentRow] = this._getColumnRowFromLocal(x, y);
        let translocated = false;

        if (currentColumn === this._maxColumns - 1 &&
            x + this._elementWidth > this._width
        ) {
            x = this._width - this._elementWidth;
            translocated = true;
        }

        if (currentRow === this._maxRows - 1 &&
            y + this._elementHeight > this._height
        ) {
            y = this._height - this._elementHeight;
            translocated = true;
        }

        if (x < 0) {
            x = 0;
            translocated = true;
        }

        if (y < 0) {
            y = 0;
            translocated = true;
        }

        // recompute global coordinates from the translocatedd local coordinates
        if (translocated)
            [X, Y] = this.coordinatesLocalToGlobal(x, y);

        this._container.put(fileItem.container, x, y);
        this._fileItems.set(fileItem, [x, y]);
        fileItem.setCoordinates(X,
            Y,
            this._elementWidth - 2 * this.elementSpacing,
            this._elementHeight - 2 * this.elementSpacing,
            this.elementSpacing,
            this);

        // set column row being used for all four vertices
        this._setUseColumnRowOverlappingThis(
            fileItem,
            currentColumn,
            currentRow,
            X, Y
        );

        /* If this file is new in the Desktop and hasn't yet
         * fixed coordinates, store the new position to ensure
         * that the next time it will be shown in the same position.
         * Also store the new position if it has been moved by the user,
         * and not triggered by a screen change.
         */
        if ((fileItem.savedCoordinates === null) ||
            (coordinatesAction === this.Enums.StoredCoordinates.OVERWRITE)
        ) {
            const [normalizedX, normalizedY] =
                this.getNormalizedCoordinates(x, y);

            const array = [X, Y, normalizedX, normalizedY, this._monitor];

            fileItem.writeSavedCoordinates(array);
            fileItem.column = null;
            fileItem.row = null;
        }
    }

    addFileItemCloseTo(fileItem, X, Y, coordinatesAction) {
        const addVolumesOpposite = this.Prefs.AddVolumesOpposite;
        const [x, y] = this._coordinatesGlobalToLocal(X, Y);
        const [column, row] = this._getEmptyPlaceClosestTo(
            x,
            y,
            coordinatesAction,
            fileItem.isDrive && addVolumesOpposite
        );
        this._placeIntoPosition(
            fileItem,
            X, Y,
            x, y,
            column,
            row,
            coordinatesAction
        );
    }

    makeTopLayerOnGrid(fileItem) {
        if (!this.Prefs.freePositionIcons)
            return;

        const [x, y] = this._fileItems.get(fileItem);

        this._container.remove(fileItem.container);
        this._container.put(fileItem.container, x, y);
    }

    getNormalizedCoordinates(x, y) {
        return [x / this.normalizedWidth, y / this.normalizedHeight];
    }

    setNormalizedCoordinates(x, y) {
        const newGlobalX = x * this.normalizedWidth;
        const newGlobalY = y * this.normalizedHeight;

        return [newGlobalX, newGlobalY];
    }

    get normalizedWidth() {
        return this._width;
    }

    get normalizedHeight() {
        return this._height;
    }

    get monitorIndex() {
        return this._monitor;
    }

    get index() {
        return this._desktopIndex;
    }

    get name() {
        return this._desktopName;
    }
};

const GridOverlay = GObject.registerClass(
class GridOverlay extends Gtk.Widget {
    constructor(grid) {
        super({can_target: false});
        this._grid = grid;
    }

    vfunc_snapshot(snapshot) {
        const w = this.get_allocated_width();
        const h = this.get_allocated_height();

        if (w <= 0 || h <= 0)
            return;

        this._grid._doDrawOnGrid(snapshot);

        // Ensure this widget contributes a node so the frame overwrites stale content.
        const rect = new Graphene.Rect();
        rect.init(0, 0, 1, 1);
        snapshot.append_color(
            new Gdk.RGBA({red: 0, green: 0, blue: 0, alpha: 0.001}),
            rect
        );
    }
});

const DrawGrid =  class extends DisplayGrid {
    constructor(params) {
        super(params);

        this._drawArea = new GridOverlay(this);
        this._drawArea.set_size_request(this._windowWidth, this._windowHeight);
        this._sizeContainer(this._drawArea);
        this._overlay.add_overlay(this._drawArea);
        this._drawArea.set_can_target(false);
        this._drawArea.set_visible(true);
    }

    resizeWindow() {
        super.resizeWindow();
        this._drawArea.set_size_request(this._windowWidth, this._windowHeight);
    }

    resizeGrid() {
        super.resizeGrid();
        this._drawArea.set_size_request(this._windowWidth, this._windowHeight);
        this._sizeContainer(this._drawArea);
    }

    // Functions for drawing on the grid

    highLightGridAt(x, y) {
        const globalCoordinates = false;
        const selected = this.getCoordinatesOfGridContaining(x, y, globalCoordinates);
        this._selectedList = [selected];
        this.updateOverlay();
    }

    unHighLightGrids() {
        this._selectedList = null;
        this.updateOverlay();
    }

    updateOverlay() {
        this._drawArea.queue_draw();
    }

    _overlayHasContent() {
        const hasRubberBand =
            this._dragManager.rubberBand &&
            this._dragManager.selectionRectangle;
        const hasDropRects = (this._selectedList?.length ?? 0) > 0;
        return hasRubberBand || hasDropRects;
    }

    _doDrawOnGrid(snapshot) {
        this._doDrawRubberBand(snapshot);
        this._doDrawDropRectangles(snapshot);
    }

    _doDrawRubberBand(snapshot) {
        if (!this._dragManager.rubberBand ||
            !this._dragManager.selectionRectangle ||
            !this.gridGlobalRectangle
            .intersect(this._dragManager.selectionRectangle)[0]
        )
            return;

        const [xInit, yInit] =
            this._coordinatesGlobalToLocal(
                this._dragManager.x1,
                this._dragManager.y1
            );

        const [xFin, yFin] =
            this._coordinatesGlobalToLocal(
                this._dragManager.x2,
                this._dragManager.y2
            );

        const width = xFin - xInit;
        const height = yFin - yInit;

        const fillColor = new Gdk.RGBA({
            red: this.Prefs.selectColor.red,
            green: this.Prefs.selectColor.green,
            blue: this.Prefs.selectColor.blue,
            alpha: 0.15,
        });

        const outlineColor = new Gdk.RGBA({
            red: this.Prefs.selectColor.red,
            green: this.Prefs.selectColor.green,
            blue: this.Prefs.selectColor.blue,
            alpha: 1.0,
        });

        this._roundedRectangleDraw(
            xInit,
            yInit,
            width,
            height,
            snapshot,
            fillColor,
            outlineColor
        );
    }

    _doDrawDropRectangles(snapshot) {
        if (!this.Prefs.showDropPlace || this._selectedList === null)
            return;

        const fillColor = new Gdk.RGBA({
            red: 1.0 - this.Prefs.selectColor.red,
            green: 1.0 - this.Prefs.selectColor.green,
            blue: 1.0 - this.Prefs.selectColor.blue,
            alpha: 0.4,
        });

        const outlineColor = new Gdk.RGBA({
            red: 1.0 - this.Prefs.selectColor.red,
            green: 1.0 - this.Prefs.selectColor.green,
            blue: 1.0 - this.Prefs.selectColor.blue,
            alpha: 1.0,
        });

        for (const [x, y] of this._selectedList) {
            this._rectangleDraw(
                x, y,
                this._elementWidth,
                this._elementHeight,
                snapshot,
                fillColor,
                outlineColor
            );
        }
    }

    _rectangleDraw(x, y, width, height, snapshot, fillColor, outlineColor) {
        const rect = new Graphene.Rect();
        rect.init(x + 0.5, y + 0.5, width, height);

        snapshot.append_color(fillColor, rect);

        const rr = new Gsk.RoundedRect();
        const zero = new Graphene.Size();
        zero.init(0, 0);
        rr.init(rect, zero, zero, zero, zero);

        snapshot.append_border(
            rr,
            [0.5, 0.5, 0.5, 0.5],
            [outlineColor, outlineColor, outlineColor, outlineColor]
        );
    }

    _roundedRectangleDraw(x, y, width, height, snapshot, fillColor, outlineColor) {
        const cornerRadius = 5;

        const isSquare = width === height;
        const tooLarge = cornerRadius * 2 > Math.min(width, height);

        const useSquareCorners = cornerRadius <= 0 || isSquare || tooLarge;

        const radius =
            useSquareCorners
                ? 0
                : Math.min(cornerRadius, width / 2, height / 2);

        const rect = new Graphene.Rect();
        rect.init(x, y, width, height);

        const size = new Graphene.Size();
        size.init(radius, radius);

        const rr = new Gsk.RoundedRect();
        rr.init(rect, size, size, size, size);

        if (radius > 0) {
            snapshot.push_rounded_clip(rr);
            snapshot.append_color(fillColor, rect);
            snapshot.pop();
        } else {
            snapshot.append_color(fillColor, rect);
        }

        snapshot.append_border(
            rr,
            [1.0, 1.0, 1.0, 1.0],
            [outlineColor, outlineColor, outlineColor, outlineColor]
        );
    }
};


const ControlGrid = class extends DrawGrid {
    constructor(params) {
        super(params);
        this._addDragControllers();
    }

    _addDragControllers() {
        // Bubble-phase controller: delivers key events to DesktopManager for actions
        this._eventKey = Gtk.EventControllerKey.new();
        this._eventKey.set_propagation_phase(Gtk.PropagationPhase.BUBBLE);
        this._window.add_controller(this._eventKey);

        // Capture-phase controller: only caches modifier state, does not invoke actions
        this._eventKeyState = Gtk.EventControllerKey.new();
        this._eventKeyState.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        this._window.add_controller(this._eventKeyState);

        this._eventKey.connect(
            'key-pressed',
            this._onKeyPress.bind(this)
        );

        this._eventKeyState.connect(
            'key-pressed',
            this._onModifierUpdate.bind(this)
        );

        this._eventKeyState.connect(
            'key-released',
            this._onModifierClear.bind(this)
        );

        this._eventMotion = Gtk.EventControllerMotion.new();
        this._eventMotion.set_propagation_phase(Gtk.PropagationPhase.BUBBLE);
        this._container.add_controller(this._eventMotion);

        this._eventMotion.connect(
            'motion',
            (actor, x, y) => {
                if (!this._dragManager.rubberBand)
                    return false;

                const [X, Y] = this.coordinatesLocalToGlobal(x, y);
                this._dragManager.onMotion(X, Y);
                return false;
            }
        );

        this._buttonClick = new Gtk.GestureClick({button: 0});
        this._buttonClick.set_propagation_phase(Gtk.PropagationPhase.BUBBLE);
        this._container.add_controller(this._buttonClick);
        this._buttonLongClick = new Gtk.GestureLongPress({button: 0});
        this._buttonLongClick.set_propagation_phase(Gtk.PropagationPhase.BUBBLE);
        this._container.add_controller(this._buttonLongClick);

        this._buttonClick.set_exclusive(true);
        this._buttonLongClick.set_exclusive(true);
        this._buttonClick.group(this._buttonLongClick);
        this._longHandled = false;

        this._buttonLongClick.connect('pressed', (actor, x, y) => {
            this._longHandled = true;
            this._doGestureLongPress(actor, x, y);
        });

        this._buttonLongClick.connect('cancelled', _actor => {
            this._longHandled = false;
        });

        this._buttonClick.connect('pressed', (actor, nPress, x, y) => {
            this._doGesturePress(actor, nPress, x, y);
        });

        this._buttonClick.connect('released', (actor, nPress, x, y) => {
            if (this._longHandled)
                this._longHandled = false;

            this._doGestureRelease(actor, nPress, x, y, this);
        });

        this._setDropDestination(this._container);
        this._setDragSource(this._container);
    }

    _onKeyPress(actor, keyval, keycode, state)  {
        this._desktopManager.onKeyPress(
            keyval,
            keycode,
            state,
            this
        );
    }

    _onModifierUpdate(_actor, _keyval, _keycode, state) {
        this._desktopManager.updateModifierState(state);
    }

    _onModifierClear() {
        this._desktopManager.clearModifierState();
    }

    _doGesturePress(actor, nPress, x, y) {
        if (this._desktopManager.closePopUps())
            return;

        const button = actor.get_current_button();
        const timestamp = actor.get_current_event_time();
        const state = this._buttonClick.get_current_event_state();
        const isCtrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const isShift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
        const [X, Y] = this.coordinatesLocalToGlobal(x, y);

        const clickItem = this._fileAt(x, y);

        if (clickItem && this._clickItemClickable(clickItem, X, Y)) {
            clickItem
                ._onPressButton(
                    actor,
                    nPress,
                    X, Y,
                    x, y,
                    isShift,
                    isCtrl,
                    timestamp
                );
            return;
        }

        this._desktopManager
            .onPressButton(X, Y, x, y, button, isShift, isCtrl, this, timestamp);
    }

    async _doGestureRelease(actor, nPress, x, y, grid) {
        const button = actor.get_current_button();
        const state = this._buttonClick.get_current_event_state();
        const isCtrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const isShift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
        const [X, Y] = this.coordinatesLocalToGlobal(x, y);

        const clickItem = this._fileAt(x, y);
        const clickItemClickable = this._clickItemClickable(clickItem, X, Y);

        if (clickItemClickable && !this._dragManager.rubberBand) {
            clickItem._onReleaseButton(
                actor, nPress, X, Y, x, y, isShift, isCtrl);
            return;
        }

        this._dragManager.onReleaseButton(this);

        await this._desktopManager
            .onReleaseButton(X, Y, x, y, button, isShift, isCtrl, grid)
            .catch(logError);
    }

    _doGestureLongPress(actor, x, y) {
        const button = actor.get_current_button();
        const state = this._buttonClick.get_current_event_state();
        const isCtrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
        const isShift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
        const [X, Y] = this.coordinatesLocalToGlobal(x, y);

        const clickItem = this._fileAt(x, y);
        const clickItemClickable = this._clickItemClickable(clickItem, X, Y);

        if (clickItemClickable) {
            clickItem
            ._onLongPressButton(actor, X, Y, x, y, isShift, isCtrl);
            return;
        }

        this._desktopManager
            .onLongPressButton(X, Y, x, y, button, isShift, isCtrl, this);
    }

    _clickItemClickable(clickedItem, X, Y) {
        if (!clickedItem)
            return false;

        const clickRectangle =
            new Gdk.Rectangle({x: X, y: Y, width: 1, height: 1});

        return clickRectangle.intersect(clickedItem.iconRectangle)[0] ||
            clickRectangle.intersect(clickedItem.labelRectangle)[0];
    }

    _setDropDestination(widget) {
        this.gridDropController = new Gtk.DropTargetAsync();
        this.gridDropController.set_actions(
            Gdk.DragAction.MOVE |
            Gdk.DragAction.COPY |
            Gdk.DragAction.ASK
        );
        const desktopAcceptFormats =
            Gdk.ContentFormats.new(this.Enums.DndTargetInfo.MIME_TYPES);
        const fileItemAcceptFormats =
            Gdk.ContentFormats.new([
                this.Enums.DndTargetInfo.GNOME_ICON_LIST,
                this.Enums.DndTargetInfo.URI_LIST,
            ]);
        const desktopMoveIconsFormat =
            Gdk.ContentFormats.new([this.Enums.DndTargetInfo.DING_ICON_LIST]);
        const textDropFormat =
            Gdk.ContentFormats.new([this.Enums.DndTargetInfo.TEXT_PLAIN]);
        const oldNautilusDropFormat =
            Gdk.ContentFormats.new([this.Enums.DndTargetInfo.GNOME_ICON_LIST]);
        this.gridDropController.set_formats(desktopAcceptFormats);

        let acceptFormat = null;
        let dropData = null;

        this.gridDropController.connect(
            'accept',
            (actor, drop) => {
                if (drop.get_formats().match(desktopAcceptFormats))
                    return true;
                else
                    return false;
            }
        );

        this.gridDropController.connect(
            'drag-enter',
            (actor, drop) => {
                this.localDrag = true;
                drop.status(
                    Gdk.DragAction.COPY |
                        Gdk.DragAction.MOVE |
                        Gdk.DragAction.LINK,
                    Gdk.DragAction.MOVE
                );

                return Gdk.DragAction.MOVE;
            }
        );

        this.gridDropController.connect(
            'drag-motion',
            (actor, drop, x, y) => {
                let desktopDropZone = false;
                let fileItemDropZone = false;
                const fileItem = this._fileAt(x, y);
                const [X, Y] = this.coordinatesLocalToGlobal(x, y);
                const dropRectangle =
                    new Gdk.Rectangle({x: X, y: Y, width: 1, height: 1});
                const desktopMove =
                    drop.get_formats().match(desktopMoveIconsFormat);
                const filesMove =
                    drop.get_formats().match(fileItemAcceptFormats);

                if (fileItem) {
                    if (!this.Prefs.freePositionIcons)
                        fileItemDropZone = true;

                    else if (dropRectangle
                            .intersect(fileItem.iconRectangle)[0] ||
                        dropRectangle
                        .intersect(fileItem.labelRectangle)[0])
                        fileItemDropZone = true;

                    if (desktopMove && fileItem._hasToRouteDragToGrid())
                        fileItemDropZone = false;
                }

                desktopDropZone = !fileItemDropZone;

                this.receiveMotion(x, y, false);

                if (fileItemDropZone && !fileItem.dropCapable)
                    return false;

                if (fileItemDropZone && fileItem.dropCapable) {
                    if (!filesMove)
                        return false;

                    if (fileItem._fileExtra !==
                        this.Enums.FileType.EXTERNAL_DRIVE)
                        return Gdk.DragAction.MOVE;

                    if (fileItem._fileExtra ===
                        this.Enums.FileType.EXTERNAL_DRIVE)
                        return Gdk.DragAction.COPY;
                }

                if (desktopDropZone) {
                    if (desktopMove) {
                        if (this.Prefs.keepArranged ||
                            this.Prefs.keepStacked) {
                            if (this.Prefs.sortSpecialFolders)
                                return false;
                            else if (this._desktopManager
                                .getCurrentSelection()
                                ?.filter(f => !f.isSpecial).length >= 1)
                                return false;
                        }
                    }

                    return Gdk.DragAction.MOVE;
                }

                return false;
            });

        this.gridDropController.connect('drag-leave', () => {
            this.localDrag = false;
            this._receiveLeave();
        });

        this.gridDropController.connect('drop', (actor, drop, x, y) => {
            const event = {
                'parentWindow': this._window,
                'timestamp': Gdk.CURRENT_TIME,
            };

            let desktopDropZone = false;
            let fileItemDropZone = false;
            const fileItem = this._fileAt(x, y);
            const [X, Y] = this.coordinatesLocalToGlobal(x, y);
            const dropRectangle =
                new Gdk.Rectangle({x: X, y: Y, width: 1, height: 1});
            const desktopMove =
                drop.get_formats().match(desktopMoveIconsFormat);
            const filesMove =
                drop.get_formats().match(fileItemAcceptFormats);
            const oldNautilusMove =
                drop.get_formats().match(oldNautilusDropFormat);
            let readFormat = Gdk.FileList.$gtype;

            if (fileItem) {
                if (!this.Prefs.freePositionIcons)
                    fileItemDropZone = true;
                else if (dropRectangle.intersect(fileItem.iconRectangle)[0] ||
                    dropRectangle.intersect(fileItem.labelRectangle)[0])
                    fileItemDropZone = true;
                if (desktopMove && fileItem._hasToRouteDragToGrid())
                    fileItemDropZone = false;
            }

            desktopDropZone = !fileItemDropZone;

            const textDrop =
                drop.get_formats().match(textDropFormat) &&
                    !desktopMove &&
                    !filesMove;

            if (textDrop) {
                acceptFormat = this.Enums.DndTargetInfo.TEXT_PLAIN;
                readFormat = String.$gtype;
            }

            if (desktopMove)
                acceptFormat = this.Enums.DndTargetInfo.DING_ICON_LIST;

            if (filesMove && !desktopMove) {
                if (oldNautilusMove) {
                    acceptFormat = this.Enums.DndTargetInfo.GNOME_ICON_LIST;
                    readFormat = String.$gtype;
                } else {
                    acceptFormat = this.Enums.DndTargetInfo.URI_LIST;
                    readFormat = String.$gtype;
                }
            }

            let gdkDropAction = drop.get_actions();

            if (!Gdk.DragAction.is_unique(gdkDropAction)) {
                if (gdkDropAction >
                        (Gdk.DragAction.COPY | Gdk.DragAction.MOVE))
                    gdkDropAction = Gdk.DragAction.ASK;
            }

            let gdkReturnAction = Gdk.DragAction.COPY;

            if (desktopMove &&
                desktopDropZone &&
                (gdkDropAction === Gdk.DragAction.MOVE)
            ) {
                let [xOrigin, yOrigin] =
                    this._dragManager.dragItem.getCoordinates()
                    .slice(0, 3);

                this._dragManager.doMoveWithDragAndDrop(xOrigin, yOrigin, X, Y);

                this._receiveLeave();
                drop.finish(gdkDropAction);

                return true;
            }

            try {
                drop.read_value_async(
                    readFormat,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    async (dropactor, result) => {
                        dropData = dropactor.read_value_finish(result);

                        if (!dropData || !acceptFormat) {
                            drop.finish(0);
                            this._receiveLeave();
                            return false;
                        }

                        if (dropData && textDrop) {
                            gdkReturnAction = Gdk.DragAction.COPY;
                            this._dragManager.onTextDrop(dropData, [X, Y]);
                            drop.finish(gdkReturnAction);
                            this._receiveLeave();
                            return true;
                        }

                        gdkReturnAction =
                            await this._completeDrop(
                                X, Y,
                                x, y,
                                drop,
                                dropData,
                                gdkDropAction,
                                fileItem,
                                acceptFormat,
                                fileItemDropZone,
                                desktopDropZone,
                                desktopMove,
                                filesMove,
                                textDrop,
                                event
                            ).catch(e => console.error(e));

                        if (gdkReturnAction) {
                            drop.finish(gdkReturnAction);
                            this._receiveLeave();
                            return true;
                        } else {
                            drop.finish(0);
                            this._receiveLeave();
                            return false;
                        }
                    }
                );
            } catch (e) {
                console.error(e);
                drop.finish(0);
                this._receiveLeave();
            }
            return false;
        });

        widget.add_controller(this.gridDropController);

        this.gridDropControllerMotion = new Gtk.DropControllerMotion();

        this.gridDropControllerMotion.connect(
            'motion',
            (actor, x, y) => {
                if (!this.gridDropControllerMotion.is_pointer) {
                    const fileItem = this._fileAt(x, y);
                    const [X, Y] = this.coordinatesLocalToGlobal(x, y);
                    const pointerRectangle =
                        new Gdk.Rectangle({x: X, y: Y, width: 1, height: 1});

                    if (fileItem && fileItem.dropCapable) {
                        this._dragManager.unHighLightDropTarget();

                        if (!this.Prefs.freePositionIcons)
                            fileItem.highLightDropTarget();

                        else if (
                            pointerRectangle
                            .intersect(fileItem.iconRectangle)[0] ||
                            pointerRectangle
                            .intersect(fileItem.labelRectangle)[0])
                            fileItem.highLightDropTarget();
                    }

                    if (fileItem && (fileItem.isDirectory || fileItem.isDrive))
                        this._startSpringLoadedTimer(fileItem);
                } else {
                    this._dragManager.unHighLightDropTarget();
                    this._stopSpringLoadedTimer();
                }
            });

        widget.add_controller(this.gridDropControllerMotion);
    }

    async _completeDrop(
        X, Y,
        x, y,
        drop,
        dropData,
        gdkDropAction,
        fileItem,
        acceptFormat,
        fileItemDropZone,
        desktopDropZone,
        desktopMove,
        filesMove,
        textDrop,
        event
    ) {
        let returnAction = Gdk.DragAction.COPY;
        const localDrop = !!drop.get_drag();

        if (fileItemDropZone && (desktopMove || filesMove)) {
            returnAction =
                await fileItem.receiveDrop(
                    X, Y,
                    x, y,
                    dropData,
                    acceptFormat,
                    gdkDropAction,
                    localDrop,
                    event,
                    this._dragManager.dragItem
                ).catch(e => console.error(e));

            return returnAction;
        }

        if (desktopDropZone && (desktopMove || filesMove)) {
            returnAction = await this._receiveDrop(
                x, y,
                dropData,
                acceptFormat,
                gdkDropAction,
                localDrop,
                event,
                this._dragManager.dragItem
            ).catch(e => console.error(e));

            return returnAction;
        }

        // Finally if all above does not work, catchall-
        return false;
    }


    _setDragSource(widget) {
        const widgetDragController = Gtk.DragSource.new();
        let clickItem;

        widgetDragController.set_actions(
            Gdk.DragAction.MOVE | Gdk.DragAction.COPY | Gdk.DragAction.ASK);

        widgetDragController.connect(
            'prepare',
            // eslint-disable-next-line consistent-return
            (actor, x, y) => {
                const draggedItem = this._fileAt(x, y);

                if (draggedItem && !this._dragManager.rubberBand) {
                    clickItem = draggedItem;
                    const [a, b] =
                        this._coordinatesWidgetToWidget(
                            x, y,
                            this._container,
                            clickItem._icon
                        )
                        .map(f => Math.floor(Math.max(f)));

                    this._dragManager.localDragOffset = [a, b];

                    const dragIcon = this._createStackedDragIcon(clickItem);

                    widgetDragController.set_icon(dragIcon, a, b);
                    clickItem.dragSourceOffset = [a, b];

                    this._loadDragData();

                    if (this.contentProvider)
                        return this.contentProvider;
                }
            }
        );

        widgetDragController.connect('drag-begin', () => {
            this._dragManager.onReleaseButton(this);
            this._dragManager.onDragBegin(clickItem);
        });

        widgetDragController.connect(
            'drag-cancel',
            async (actor, drag, reason) => {
                if (reason === Gdk.DragCancelReason.NO_TARGET ||
                    reason === Gdk.DragCancelReason.ERROR) {
                    const gnomedropDetected =
                        await this._dragManager.gnomeShellDrag
                        ?.completeGnomeShellDrop()
                        .catch(e => console.error(e));

                    if (gnomedropDetected)
                        return true;
                    else
                        return false;
                } else {
                    return false;
                }
            }
        );

        widgetDragController.connect('drag-end', () => {
            this._dragManager.onDragEnd();
            this._dragManager.selected(clickItem, this.Enums.Selection.RELEASE);
        });

        widget.add_controller(widgetDragController);
    }

    _loadDragData() {
        this.contentProvider = null;
        const textCoder = new TextEncoder();

        const uriList =
            this._dragManager.fillDragDataGet(
                this.Enums.DndTargetInfo.DING_ICON_LIST);

        if (!uriList)
            return;

        const encodedUriList = textCoder.encode(uriList);

        const dingContentProvider =
            Gdk.ContentProvider.new_for_bytes(
                this.Enums.DndTargetInfo.DING_ICON_LIST,
                encodedUriList
            );

        if (this._desktopManager.checkIfSpecialFilesAreSelected()) {
            this.contentProvider = dingContentProvider;
            return;
        }

        const gnomeUriList =
            this._dragManager.fillDragDataGet(
                this.Enums.DndTargetInfo.GNOME_ICON_LIST);

        if (!gnomeUriList)
            return;

        const gnomeContentProvider =
            Gdk.ContentProvider.new_for_bytes(
                this.Enums.DndTargetInfo.GNOME_ICON_LIST,
                textCoder.encode(gnomeUriList)
            );

        const textPathList =
            this._dragManager.fillDragDataGet(
                this.Enums.DndTargetInfo.TEXT_PLAIN
            );

        if (!textPathList)
            return;

        const encodedPathList = textCoder.encode(textPathList);

        const textUriListContentProvider =
            Gdk.ContentProvider.new_for_bytes(
                this.Enums.DndTargetInfo.URI_LIST,
                encodedUriList
            );

        const textListContentProvider =
            Gdk.ContentProvider.new_for_bytes(
                this.Enums.DndTargetInfo.TEXT_PLAIN,
                encodedPathList
            );

        const textUtf8ListContentProvider =
            Gdk.ContentProvider.new_for_bytes(
                this.Enums.DndTargetInfo.TEXT_PLAIN_UTF8,
                encodedPathList
            );

        this.contentProvider = Gdk.ContentProvider.new_union([
            dingContentProvider,
            gnomeContentProvider,
            textUriListContentProvider,
            textListContentProvider,
            textUtf8ListContentProvider,
        ]);
    }

    // The following code is translated from Nautilus C to Javascript
    //  to form the similar stack of items

    _createStackedDragIcon(draggedItem) {
        const  selectionArray = this._desktopManager.getCurrentSelection();
        selectionArray.sort(
            // eslint-disable-next-line no-nested-ternary
            (a, b) => a.uri === draggedItem.uri
                ? -1
                : b.uri === draggedItem.uri
                    ? 1
                    : 0
        );

        const dragIconArray = selectionArray.map(f => f._icon.get_paintable());
        const numberOfIcons = dragIconArray.length;

        const dragIcon = Gtk.Snapshot.new();

        /* A wide shadow for the pile of icons gives a sense of floating. */
        const stackShadow =
            {
                color: {red: 0, green: 0, blue: 0, alpha: 0.15},
                dx: 0,
                dy: 2,
                radius: 10,
            };

        /* A slight shadow swhich makes each icon in the stack look separate. */
        const iconShadow =
            {
                color: {red: 0, green: 0, blue: 0, alpha: 0.30},
                dx: 0,
                dy: 1,
                radius: 1,
            };

        let xOffset = numberOfIcons % 2 === 1 ? 6 : -6;
        let yOffset;

        switch (numberOfIcons) {
        case 1:
            yOffset = 0;
            break;
        case 2:
            yOffset = 10;
            break;
        case 3:
            yOffset = 6;
            break;
        default:
            yOffset = 4;
        }

        dragIcon.translate(
            new Graphene.Point(
                {
                    x: 10 + (xOffset / 2),
                    y: yOffset * numberOfIcons,
                }
            )
        );

        const shadow = new Gsk.Shadow(stackShadow);
        dragIcon.push_shadow([shadow]);

        dragIconArray.reverse().forEach(
            paintableWidget => {
                const w = paintableWidget.get_intrinsic_width();
                const h = paintableWidget.get_intrinsic_height();
                const X = Math.floor((this.Prefs.IconSize - w) / 2);
                const Y = Math.floor((this.Prefs.IconSize - h) / 2);

                dragIcon.translate(
                    new Graphene.Point(
                        {
                            x: -xOffset,
                            y: -yOffset,
                        }
                    )
                );

                xOffset = -xOffset;

                dragIcon.translate(new Graphene.Point({x: X, y: Y}));
                dragIcon.push_shadow([new Gsk.Shadow(iconShadow)]);

                paintableWidget.snapshot(dragIcon, w, h);

                dragIcon.pop();

                dragIcon.translate(new Graphene.Point({x: -X, y: -Y}));
            }
        );
        dragIcon.pop();

        return dragIcon.to_paintable(null);
    }

    _receiveLeave() {
        this._stopSpringLoadedTimer();
        this._window.queue_draw();
        this._dragManager.onDragLeave();
    }

    receiveLeave() {
        this._receiveLeave();
    }

    receiveMotion(x, y, global) {
        let X;
        let Y;
        if (!global) {
            x = this._elementWidth * Math.floor(x / this._elementWidth);
            y = this._elementHeight * Math.floor(y / this._elementHeight);
            [X, Y] = this.coordinatesLocalToGlobal(x, y);
        }
        this._dragManager.onDragMotion(X, Y);
    }

    async _receiveDrop(
        x, y,
        selection,
        info,
        gdkDropAction,
        localDrop,
        event,
        dragItem
    ) {
        x = this._elementWidth * Math.floor(x / this._elementWidth);
        y = this._elementHeight * Math.floor(y / this._elementHeight);
        const [X, Y] = this.coordinatesLocalToGlobal(x, y);
        const returnAction =
            await this._dragManager
                .onDragDataReceived(
                    X, Y,
                    x, y,
                    selection,
                    info,
                    gdkDropAction,
                    localDrop,
                    event,
                    dragItem
                )
                .catch(e => console.error(e));
        return returnAction;
    }

    refreshDrag(selectedList, ox, oy) {
        if (!this.Prefs.showDropPlace)
            return;

        if (selectedList === null) {
            this._selectedList = null;
            this.updateOverlay();

            return;
        }

        let newSelectedList = [];

        for (let [x, y] of selectedList) {
            x += this._elementWidth / 2;
            y += this._elementHeight / 2;
            x += ox;
            y += oy;

            const r = this.getCoordinatesOfGridContaining(x, y);

            if (r &&
                !isNaN(r[0]) &&
                !isNaN(r[1]) &&
                (!this._gridInUse(r[0], r[1]) ||
                this._fileAt(r[0], r[1])?.isSelected)
            )
                newSelectedList.push(r);
        }

        if (newSelectedList.length === 0) {
            if (this._selectedList !== null) {
                this._selectedList = null;
                this.updateOverlay();
            }

            return;
        }

        if (this._selectedList !== null) {
            if ((newSelectedList[0][0] === this._selectedList[0][0]) &&
                (newSelectedList[0][1] === this._selectedList[0][1])
            )
                return;
        }

        this._selectedList = newSelectedList;
        this.updateOverlay();
    }

    _startSpringLoadedTimer(fileItem) {
        if (!this.Prefs.openFolderOnDndHover || this.directoryOpenTimer)
            return;

        if (this._dragManager.dragItem?.uri === fileItem.uri)
            return;

        this.directoryOpenTimer =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                this.Enums.DND_HOVER_TIMEOUT,
                () => {
                    const context =
                        Gdk.Display.get_default()
                        .get_app_launch_context();

                    context.set_timestamp(Gdk.CURRENT_TIME);

                    try {
                        Gio.AppInfo.launch_default_for_uri(
                            fileItem.uri,
                            context
                        );
                    } catch (e) {
                        console.error(e, `Error opening ${fileItem.uri}` +
                            ` in GNOME Files: ${e.message}`);
                    }

                    this.directoryOpenTimer = 0;
                    return GLib.SOURCE_REMOVE;
                }
            );
    }

    _stopSpringLoadedTimer() {
        if (this.directoryOpenTimer)
            GLib.Source.remove(this.directoryOpenTimer);

        this.directoryOpenTimer = 0;
    }
};

/* A Picture that can translate itself at paint time (render-only) */
const OffsetPicture = GObject.registerClass({
    Properties: {
        'tx': GObject.ParamSpec.double('tx', 'tx', 'translate x',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            -1e6, 1e6, 0.0),
        'ty': GObject.ParamSpec.double('ty', 'ty', 'translate y',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.EXPLICIT_NOTIFY,
            -1e6, 1e6, 0.0),
        'scale':  GObject.ParamSpec.double('scale', '', '',
            GObject.ParamFlags.READWRITE, 0.5, 2.0, 1.0),
        'pivot-x': GObject.ParamSpec.double('pivot-x', '', '',
            GObject.ParamFlags.READWRITE, -1e6, 1e6, 0),
        'pivot-y': GObject.ParamSpec.double('pivot-y', '', '',
            GObject.ParamFlags.READWRITE, -1e6, 1e6, 0),
    },
}, class OffsetPicture extends Gtk.Picture {
    constructor(props = {}) {
        super(
            Object.assign({
                hexpand: false,
                vexpand: false,
                halign: Gtk.Align.START,
                valign: Gtk.Align.START,
                can_target: false,
            },
            props)
        );
        this._tx = 0.0;
        this._ty = 0.0;
        this._scale = 1.0;
        this._pivot_x = 0.0;
        this._pivot_y = 0.0;
    }

    get tx() {
        return this._tx;
    }

    set tx(v) {
        v = Number(v);
        if (v !== this._tx) {
            this._tx = v;
            this.notify('tx');
            this.queue_draw();
        }
    }

    get ty() {
        return this._ty;
    }

    set ty(v) {
        v = Number(v);
        if (v !== this._ty) {
            this._ty = v;
            this.notify('ty');
            this.queue_draw();
        }
    }

    get scale() {
        return this._scale;
    }

    set scale(v) {
        v = Number(v);
        if (v !== this._scale) {
            this._scale = v;
            this.notify('scale');
            this.queue_draw();
        }
    }

    get pivot_x() {
        return this._pivot_x;
    }

    set pivot_x(v) {
        v = Number(v);
        if (v !== this._pivot_x) {
            this._pivot_x = v;
            this.notify('pivot-x');
            this.queue_draw();
        }
    }

    get pivot_y() {
        return this._pivot_y;
    }

    set pivot_y(v) {
        v = Number(v);
        if (v !== this._pivot_y) {
            this._pivot_y = v;
            this.notify('pivot-y');
            this.queue_draw();
        }
    }

    // eslint-disable-next-line no-unused-vars
    vfunc_snapshot(snapshot) {
        const a = this.get_allocation();
        if (a.width <= 0 || a.height <= 0)
            return;

        snapshot.save();
        try {
            const rect = new Graphene.Rect();
            rect.init(0, 0, a.width, a.height);
            snapshot.push_clip(rect);
            try {
                snapshot.translate(
                    new Graphene.Point({x: this._tx, y: this._ty}));
                snapshot.translate(
                    new Graphene.Point({x: this.pivot_x, y: this.pivot_y}));
                snapshot.scale(this.scale, this.scale);
                snapshot.translate(
                    new Graphene.Point({x: -this.pivot_x, y: -this.pivot_y}));

                super.vfunc_snapshot(snapshot);
            } finally {
                snapshot.pop();
            }
        } finally {
            snapshot.restore();
        }
    }
});

// Adds an auxiliary fixed layer that can sit above/below the icon grid.
const WidgetGrid = class extends ControlGrid {
    constructor(params) {
        super(params);
        this._selectedWidget = null;   // instanceId
        this._draggedWidget = null;    // instanceId
        // Pending only until the pointer moves far enough to count as a drag.
        this._pendingChromeDrag = null;
        // Small pointer jitter should not steal clicks from draggable chrome.
        this._chromeDragThreshold = 5;
        this.widgetGridEnabled = false;
        this._gridSize = this.Enums.WIDGET_GRID_SIZE;

        this._widgetContainer = new Gtk.Fixed();
        this._rootFixed.put(this._widgetContainer, 0, 0);
        this.resizeGrid();
        this._widgetContainer.set_name('widget-container');
        this._widgetContainer.set_focusable(true);
        this._widgetContainerOnTop = true;
        this.lowerWidgetContainer();

        const drag = new Gtk.GestureDrag({button: 1});
        drag.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        this._widgetContainer.add_controller(drag);

        // Click gesture: used only to track selection + click radius
        const click = new Gtk.GestureClick({button: 0});
        click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        this._widgetContainer.add_controller(click);

        const contextClick = new Gtk.GestureClick({button: 3});
        contextClick.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        this._widgetContainer.add_controller(contextClick);

        click.set_exclusive(true);
        drag.set_exclusive(true);
        click.group(drag);

        drag.connect('drag-begin', this._onWidgetMoveDragBegin.bind(this));
        drag.connect('drag-update', this._onWidgetMoveDragUpdate.bind(this));
        drag.connect('drag-end', this._onWidgetMoveDragEnd.bind(this));
        click.connect('pressed', this._onClick.bind(this));
        click.connect('released', this._onClickRelease.bind(this));
        contextClick.connect('pressed', this._onWidgetContextMenu.bind(this));
    }

    get widgetContainer() {
        return this._widgetContainer;
    }

    isWidgetContainerOnTop() {
        return this._widgetContainerOnTop;
    }

    raiseWidgetContainer() {
        this._setWidgetContainerLayer(true);
    }

    lowerWidgetContainer() {
        this._setWidgetContainerLayer(false);
    }

    setWidgetContainerOnTop(onTop = true) {
        this._setWidgetContainerLayer(onTop);
    }

    toggleWidgetLayer() {
        this.setWidgetContainerOnTop(!this._widgetContainerOnTop);
    }

    restoreWidgetLayerFocus() {
        if (!this._widgetContainerOnTop)
            return;

        this._window.present();

        if (this._widgetContainer.grab_focus())
            return;

        this._window.grab_focus();
    }

    resizeWindow() {
        super.resizeWindow();
        this._widgetContainer.set_size_request(
            this._width,
            this._height
        );
        this._sizeContainer(this._widgetContainer);
    }

    resizeGrid() {
        super.resizeGrid();
        this._widgetContainer.set_size_request(
            this._width,
            this._height
        );
        this._sizeContainer(this._widgetContainer);
    }

    _setWidgetContainerLayer(onTop) {
        if (onTop === this._widgetContainerOnTop)
            return;

        this._widgetContainerOnTop = onTop;

        if (onTop) {
        // Widgets above icons (edit mode)
        // Draw order: icons (bottom), widgets (top)

            // Reorder without unparenting:
            // place widgetContainer after container in _rootFixed
            this._widgetContainer.insert_after(this._rootFixed, this._container);

            this._widgetContainer.add_css_class('widgets-on-top');
            this._window.add_css_class('widgets-on-top');

            // Input: widget layer active, icons inert
            this._container.opacity = 0.05;
            this._container.set_can_target(false);
            this._widgetContainer.set_can_target(true);
            this._desktopManager.unselectAll();
            this._desktopManager.closeFocusStealingWindows();
            this._mainapp.set_accels_for_action(
                'app.lowerWidgetLayer',
                ['Escape']
            );

            this.restoreWidgetLayerFocus();
        } else {
        // Icons above widgets (normal mode)
        // Draw order: widgets (bottom), icons (top)

            // Reorder the other way: container after widgetContainer
            this._container.insert_after(this._rootFixed, this._widgetContainer);

            this._widgetContainer.remove_css_class('widgets-on-top');
            this._window.remove_css_class('widgets-on-top');

            // Input: icons active, widget layer background only
            this._container.opacity = 1.0;
            this._container.set_can_target(true);
            this._widgetContainer.set_can_target(false);

            this._desktopManager.widgetManager?.clearSelectedInstance();
            this._mainapp.set_accels_for_action('app.lowerWidgetLayer', []);
        }

        this._desktopManager.widgetManager
            ?.handleWidgetContainerLayerChange(this.monitorIndex, this._widgetContainerOnTop);
    }

    _onWidgetContextMenu(gesture, _nPress, x, y) {
        if (!this._widgetContainerOnTop)
            return;

        if (this._findWidgetAt(x, y))
            return;

        gesture.set_state(Gtk.EventSequenceState.CLAIMED);

        const menu = new Gio.Menu();
        menu.append(_('Back to Desktop'), 'app.lowerWidgetLayer');
        menu.append(_('Toggle Widget Grid'), 'app.toggleWidgetGrid');
        menu.append(_('Add Widget...'), 'app.addWidget');

        const popover = Gtk.PopoverMenu.new_from_model(menu);
        popover.set_parent(this._widgetContainer);
        popover.set_pointing_to(new Gdk.Rectangle({x, y, width: 1, height: 1}));
        popover.set_has_arrow(false);
        popover.popup();
        popover.connect('closed', () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                popover.unparent();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _onKeyPress(actor, keyval, keycode, state)  {
        if (this._widgetContainerOnTop)
            return true;

        return super._onKeyPress(actor, keyval, keycode, state);
    }

    beginWidgetMove(instanceId, startX, startY, allowChrome = false) {
        this.restoreWidgetLayerFocus();
        this._dragStartX = startX;
        this._dragStartY = startY;
        this._selectedWidget = instanceId;

        this._draggedWidget = this._findWidgetByInstanceId(instanceId);

        this._dragPointerOffsetX = 0;
        this._dragPointerOffsetY = 0;

        if (!this._draggedWidget ||
            (!allowChrome && this._isWidgetChromeActor(this._draggedWidget)))
            return false;

        const frame =
            this._desktopManager.widgetManager.getInstanceFrame(instanceId);

        if (frame) {
            this._dragPointerOffsetX = startX - frame.x;
            this._dragPointerOffsetY = startY - frame.y;
        }

        if (this._selectedWidget === instanceId)
            this._desktopManager.widgetManager.hideSelectionChromeDuringDrag();

        this._setWidgetDraggingState(true);
        return true;
    }

    _onWidgetMoveDragBegin(gesture, startX, startY) {
        const target = this._findWidgetAt(startX, startY);
        if (!target)
            return;

        if (!this._isWidgetDraggableChromeActor(target))
            return;

        const instanceId = target.widgetInstanceId;
        if (!instanceId)
            return;

        // Record the chrome press; actual drag start waits for movement.
        this._pendingChromeDrag = {
            instanceId,
            startX,
            startY,
        };
    }

    _onWidgetMoveDragUpdate(gesture, offsetX, offsetY) {
        if (this._pendingChromeDrag) {
            // Ignore small jitter until the pointer has moved far enough
            // to count as a real drag. This will reliably deliver clicks
            // to the underlying chrome as we are using a grouped controllers
            const dist = offsetX * offsetX + offsetY * offsetY;
            const threshold =
                this._chromeDragThreshold * this._chromeDragThreshold;
            if (dist < threshold)
                return;

            const started = this.beginWidgetMove(
                this._pendingChromeDrag.instanceId,
                this._pendingChromeDrag.startX,
                this._pendingChromeDrag.startY,
                true
            );

            if (!started) {
                this._pendingChromeDrag = null;
                gesture.set_state(Gtk.EventSequenceState.DENIED);
                return;
            }

            gesture.set_state(Gtk.EventSequenceState.CLAIMED);
            this._pendingChromeDrag = null;
        }

        this.updateWidgetMove(offsetX, offsetY);
    }

    _onWidgetMoveDragEnd(_gesture, offsetX, offsetY) {
        this.endWidgetMove(offsetX, offsetY);
        if (this._draggedWidget &&
            this._isWidgetDraggableChromeActor(this._draggedWidget))
            this._desktopManager.widgetManager.clearSelectedInstance();

        this.click = null;
        this._pendingChromeDrag = null;
    }

    _findWidgetAt(lx, ly) {
        const picked =
            this._widgetContainer.pick(lx, ly, Gtk.PickFlags.DEFAULT);

        return this._widgetFromPickedActor(picked);
    }

    _widgetFromPickedActor(picked) {
        if (!picked)
            return null;

        // We only want to return a direct child in widgetContainer,
        let w = picked;
        while (w && w !== this._widgetContainer) {
            if (w.get_parent() === this._widgetContainer)
                return w;

            w = w.get_parent();
        }

        return null;
    }

    _findWidgetByInstanceId(instanceId) {
        if (!instanceId)
            return null;

        let child = this._widgetContainer.get_first_child();
        while (child) {
            if (child.widgetInstanceId === instanceId)
                return child;

            child = child.get_next_sibling();
        }

        return null;
    }

    updateWidgetMove(offsetX, offsetY) {
        if (!this._draggedWidget)
            return;

        const lx = this._dragStartX + offsetX;
        const ly = this._dragStartY + offsetY;
        this._moveDraggedWidgetToPointer(lx, ly);
    }

    _getWidgetSnappedPosition(lx, ly) {
        let newLocalX = Math.round(lx / this._gridSize) * this._gridSize;
        let newLocalY = Math.round(ly / this._gridSize) * this._gridSize;
        newLocalX = Math.max(0, Math.min(newLocalX, this._width - this._gridSize));
        newLocalY = Math.max(0, Math.min(newLocalY, this._height - this._gridSize));
        return [newLocalX, newLocalY];
    }

    endWidgetMove(offsetX, offsetY) {
        if (!this._draggedWidget)
            return;

        const lx = this._dragStartX + offsetX;
        const ly = this._dragStartY + offsetY;
        this._finishDraggedWidgetAtPointer(lx, ly);
    }

    _moveDraggedWidgetToPointer(lx, ly) {
        if (!this._draggedWidget)
            return;

        const instanceId = this._draggedWidget.widgetInstanceId;
        const [offX, offY] = this._getWidgetOffsets(instanceId);
        let newLocalX = lx - offX;
        let newLocalY = ly - offY;

        if (this.widgetGridEnabled) {
            [newLocalX, newLocalY] =
                this._getWidgetSnappedPosition(newLocalX, newLocalY);
        }

        this._widgetContainer.move(this._draggedWidget, newLocalX, newLocalY);
    }

    _finishDraggedWidgetAtPointer(lx, ly) {
        if (!this._draggedWidget)
            return;

        const instanceId = this._draggedWidget.widgetInstanceId;
        const [offX, offY] = this._getWidgetOffsets(instanceId);
        let newLocalX = lx - offX;
        let newLocalY = ly - offY;

        if (this.widgetGridEnabled) {
            [newLocalX, newLocalY] =
                this._getWidgetSnappedPosition(newLocalX, newLocalY);
        }

        this._desktopManager.widgetManager.setInstanceFrame(instanceId, newLocalX, newLocalY);

        if (this._selectedWidget === instanceId) {
            this._desktopManager.widgetManager
                .updateSelectionChromePositionFor(instanceId);
        }

        this._setWidgetDraggingState(false);
        this._draggedWidget = null;
        this._dragPointerOffsetX = null;
        this._dragPointerOffsetY = null;
    }

    _setWidgetDraggingState(isDragging) {
        if (!this._draggedWidget)
            return;

        const ctx = this._draggedWidget.get_style_context();
        if (isDragging)
            ctx.add_class('dragging');
        else
            ctx.remove_class('dragging');
    }

    _getWidgetOffsets(instanceId) {
        const inst = this._desktopManager.widgetManager.getInstance(instanceId);
        const fallbackOffsetX = inst ? inst.width / 2 : 0;
        const fallbackOffsetY = inst ? inst.height / 2 : 0;

        const offsetX =
            typeof this._dragPointerOffsetX === 'number'
                ? this._dragPointerOffsetX
                : fallbackOffsetX;
        const offsetY =
            typeof this._dragPointerOffsetY === 'number'
                ? this._dragPointerOffsetY
                : fallbackOffsetY;

        return [offsetX, offsetY];
    }

    _onClick(gesture, nPress, x, y) {
        this.restoreWidgetLayerFocus();
        const widget = this._findWidgetAt(x, y);
        let instanceId = widget?.widgetInstanceId;
        this.click = null;

        if (!widget) {
            this._selectedWidget = null;
            this._desktopManager.widgetManager.selectInstance(null);
            return;
        }

        if (this._isWidgetMoveButtonActor(widget)) {
            instanceId = this._selectedWidget;
            if (!instanceId)
                return;

            this.beginWidgetMove(instanceId, x, y);
            gesture.set_state(Gtk.EventSequenceState.CLAIMED);
            this.click = null;
            return;
        }

        if (this._isWidgetChromeActor(widget)) {
            this.click = null;
            return;
        }

        if (this._isWidgetDraggableChromeActor(widget))
            return;

        if (!instanceId)
            return;

        this._selectedWidget = instanceId;
        this._desktopManager.widgetManager.selectInstance(instanceId);

        if (this._isWidgetHostDraggableAt(instanceId, x, y)) {
            this.beginWidgetMove(instanceId, x, y);
            gesture.set_state(Gtk.EventSequenceState.CLAIMED);
            this.click = null;
            return;
        }

        this.click = [x, y];
    }

    _onClickRelease(gesture, _nPress, x, y) {
        if (!this.click) {
            this.click = null;
            return;
        }

        if (!this._selectedWidget)
            return;

        // Reliable for the normal widget-content path: if the press stayed
        // within click radius and did not become a drag, we hand the click
        // back to the child actor here. Chrome drag handles use their own
        // thresholded path and do not depend on this fallback.
        const [clickX, clickY] = this.click ?? [x, y];
        const dx = x - clickX;
        const dy = y - clickY;
        const dist = dx * dx + dy * dy;
        // Keep a small click radius so tiny pointer jitter does not turn a
        // normal widget click into a drag-like sequence.
        const radius = 4 * 4;
        const isClick = dist <= radius;
        this.click = null;

        if (!isClick)
            return;

        // At this point we’ve done all our selection work in _onClick.
        // For a real click, we now DENY the sequence
        // so that the underlying actor (HTML WebView or Gtk.Button add
        // widget) sees a normal click.
        gesture.set_state(Gtk.EventSequenceState.DENIED);
    }

    _isWidgetChromeActor(actor) {
        const name = actor.get_name?.();
        if (typeof name !== 'string')
            return false;

        return (
            name === 'ding-widget-prefs-button' ||
            name === 'ding-widget-pin-button' ||
            name === 'ding-widget-move-button' ||
            name === 'ding-widget-close-button'
        );
    }

    _isWidgetMoveButtonActor(actor) {
        return actor && actor.get_name() === 'ding-widget-move-button';
    }

    _isWidgetDraggableChromeActor(actor) {
        const name = actor?.get_name?.();
        return name === 'ding-widget-add-button' ||
            name === 'ding-widget-grid-toggle-button';
    }

    _isWidgetHostDraggableAt(instanceId, localX, localY) {
        if (!instanceId)
            return false;

        const inst = this._desktopManager.widgetManager.getInstance(instanceId);
        if (!inst || inst.kind !== 'html' || !inst.host)
            return false;

        if (typeof inst.host.isDraggable !== 'function')
            return false;

        const frame = this._desktopManager.widgetManager.getInstanceFrame(instanceId);
        if (!frame)
            return false;

        const widgetLocalX = localX - frame.x;
        const widgetLocalY = localY - frame.y;
        return inst.host.isDraggable(widgetLocalX, widgetLocalY);
    }

    _doDrawOnGrid(snapshot) {
        super._doDrawOnGrid(snapshot);
        this._doDrawGridRectangles(snapshot);
    }

    _doDrawGridRectangles(snapshot) {
        const enabled = this.widgetGridEnabled;
        if (enabled) {
            const width = this._drawArea.get_allocated_width();
            const height = this._drawArea.get_allocated_height();
            const gridColor = new Gdk.RGBA({red: 0.3, green: 0.3, blue: 0.3, alpha: 0.18});

            for (let x = 0; x < width; x += this._gridSize) {
                const rect = new Graphene.Rect();
                rect.init(x + 0.5, 0, 1, height);
                snapshot.append_color(gridColor, rect);
            }

            for (let y = 0; y < height; y += this._gridSize) {
                const rect = new Graphene.Rect();
                rect.init(0, y + 0.5, width, 1);
                snapshot.append_color(gridColor, rect);
            }
        }
    }
};

const DesktopGrid = class extends WidgetGrid {
    constructor(params) {
        super(params);
        this._snapshotPic = new OffsetPicture();
        this._oldMargins = null;
        this._animationInProgress = false;
        this._freezeDesktop = false;
        this._pendingMargins = null;
        this._newMargins = null;
        this._tweenDelta = null;
        this._reverse = 0.33; // single tuning knob for spring snappiness
        // in ms
        this._duration =  Math.max(350, this.Enums.TRANSITIONDURATION ?? 0);
        this._setupAnimations();
    }

    destroy() {
        if (this._relayoutCoalesceSource) {
            GLib.source_remove(this._relayoutCoalesceSource);
            this._relayoutCoalesceSource = 0;
        }
        super.destroy();
    }

    _setupAnimations() {
        this._setupSpringAnimation();
        this._setupOffsetAnimation();
    }

    _captureSnapshotPaintable(widget) {
        return new Promise(resolve => {
            const width = widget.get_width();
            const height = widget.get_height();
            const size = new Graphene.Size({width, height});
            try {
                const snap = Gtk.Snapshot.new();
                widget.vfunc_snapshot(snap);
                resolve(snap.to_paintable(size));
            } catch (e) {
                logError(e);
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    try {
                        const snap = Gtk.Snapshot.new();
                        widget.vfunc_snapshot(snap);
                        resolve(snap.to_paintable(size));
                    } catch (ee) {
                        logError(ee);
                        const gdkpic =
                            Gtk.WidgetPaintable.new(widget).get_current_image();
                        resolve(gdkpic);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    async displaySnapshot() {
        if (this._freezeDesktop)
            return;

        this._freezeDesktop = true;
        const snapshot = await this._captureSnapshotPaintable(this._window);
        this._resetAll();
        this._snapshotPic.set_paintable(snapshot);

        this._oldMargins = this._getCurrentMargins();

        this._overlay.add_overlay(this._snapshotPic);

        this._snapshotPic.opacity = 1;
        this._overlay.queue_draw();
        this._rootFixed.opacity = 0;
        this._rootFixed.queue_draw();
    }

    _getCurrentMargins() {
        const margin = {
            left: this._marginLeft ?? 0,
            top:  this._marginTop  ?? 0,
            right: this._marginRight ?? 0,
            bottom: this._marginBottom ?? 0,
        };
        const contentRectangle = this._computeContentRectangle(margin);
        margin.contentRectangle = contentRectangle;
        return margin;
    }

    _computeContentRectangle(margins) {
        const contentRectangle = new Gdk.Rectangle({
            x: margins.left,
            y: margins.top,
            width: this._windowWidth - margins.left - margins.right,
            height: this._windowHeight - margins.top - margins.bottom,
        });
        return contentRectangle;
    }

    _setLiveOffset(dx, dy) {
        this._snapshotPic.tx = Math.round(dx);
        this._snapshotPic.ty = Math.round(dy);
    }

    _setLiveTransform(scale, pivotx, pivoty) {
        this._snapshotPic.scale = Number(scale);
        this._snapshotPic.pivot_x = Math.round(pivotx);
        this._snapshotPic.pivot_y = Math.round(pivoty);
    }

    _resetLiveTransform() {
        this._setLiveTransform(1.0, 0, 0);
    }

    _resetLiveOffset() {
        this._setLiveOffset(0, 0);
    }

    _resetAll() {
        this._resetLiveOffset();
        this._resetLiveTransform();
    }

    _clearOverlay(widget) {
        if (widget?.get_parent() === this._overlay)
            this._overlay.remove_overlay(widget);
    }

    _displayLive() {
        this._rootFixed.opacity = 1.0;
        this._snapshotPic.opacity = 0;
        this._rootFixed.queue_draw();
        this._resetAll();
        this._clearOverlay(this._snapshotPic);
        this._animationInProgress = false;
        this._freezeDesktop = false;
    }

    _computeTweenDelta(Old, New) {
        const sameShape =
            Old.contentRectangle.width === New.contentRectangle.width &&
            Old.contentRectangle.height === New.contentRectangle.height;

        if (sameShape) {
            // If the content rectangles are the same shape, we can just tween
            // the top left corner of the content rectangle as the anchor
            // for pixel perfect alignment of the content rectangle.
            const anchor = 'topleft';
            const dx = Old.left - New.left;
            const dy = Old.top - New.top;
            const pivotx = Old.contentRectangle.x;
            const pivoty = Old.contentRectangle.y;

            return {sameShape, anchor, dx, dy, pivotx, pivoty};
        }

        // If the content rectangles are not the same shape, or if the
        // or both axis changed size, then we cannot just tween the
        // top left corner of the content rectangle as the anchor.
        // Instead, we need to tween the center, to account for the
        // difference in aspect ratio.
        const ocx = Old.contentRectangle.x + Old.contentRectangle.width  / 2;
        const ocy = Old.contentRectangle.y + Old.contentRectangle.height / 2;
        const ncx = New.contentRectangle.x + New.contentRectangle.width  / 2;
        const ncy = New.contentRectangle.y + New.contentRectangle.height / 2;
        const anchor = 'center';
        const dx = ocx - ncx;
        const dy = ocy - ncy;
        const pivotx = ncx;
        const pivoty = ncy;

        return {sameShape, anchor, dx, dy, pivotx, pivoty};
    }

    requestAnimatedRelayout() {
        if (this._relayoutCoalesceSource) {
            GLib.source_remove(this._relayoutCoalesceSource);
            this._relayoutCoalesceSource = 0;
        }

        // coalesce multiple relayouts within this time
        const relayoutBurstMs = 100;

        this._pendingMargins = this._getCurrentMargins();

        this._relayoutCoalesceSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, relayoutBurstMs, () => {
                this._playRelayoutTransition(this._pendingMargins);
                this._relayoutCoalesceSource = 0;
                this._pendingMargins = null;
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _setupSpringAnimation() {
        const dampingRatio = 0.58; // < 1 => underdamped (dip then settle)
        const stiffness   = 250 + Math.round((1 - this._reverse) * 350);
        const mass        = 1.0;

        const springParams =
            Adw.SpringParams.new(dampingRatio, mass, stiffness);

        const springTarget = Adw.CallbackAnimationTarget.new(v => {
            const s = Number(v); // animates around 1.0 due to initial_velocity
            this._setLiveTransform(
                s, this._tweenDelta.pivotx, this._tweenDelta.pivoty
            );
        });

        this._springAnimation = new Adw.SpringAnimation({
            widget: this._overlay,
            value_from: 1.0,
            value_to:   1.0,
            spring_params: springParams,
            initial_velocity: -3.0, // negative => dip “away”, then return
            epsilon: 0.001,
            clamp: false,
            target: springTarget,
        });
    }

    _setupOffsetAnimation() {
        const target = Adw.CallbackAnimationTarget.new(value => {
            const t = Number(value); // 0.0 to 1.0
            const x = Math.round(-this._tweenDelta.dx * t);
            const y = Math.round(-this._tweenDelta.dy * t);
            this._setLiveOffset(x, y);
            this._snapshotPic.opacity = 1 - t;

            // Fade in the NEW live layers only near the end
            if (t > 0.8)
                this._rootFixed.opacity = t;
        });

        this._offsetAnim = new Adw.TimedAnimation({
            widget: this._overlay,
            value_from: 0.0,
            value_to: 1.0,
            duration: this._duration,
            easing: Adw.Easing.EASE_OUT_CUBIC,
            target,
        });

        this._offsetAnim.connect('done', () => {
            this._setLiveOffset(-this._tweenDelta.dx, -this._tweenDelta.dy);
            // Ensure we end exactly at identity scale
            if (this._moveAway) {
                this._setLiveTransform(
                    1.0, this._tweenDelta.pivotx, this._tweenDelta.pivoty
                );
            }
            this._displayLive();
        });
    }

    _playRelayoutTransition(pendingMargins = null) {
        if (!this.animationsEnabled || !this._freezeDesktop) {
            this._displayLive();
            return;
        }

        if (this._animationInProgress) {
            this._offsetAnim.pause();
            this._springAnimation.pause();
        }

        this._animationInProgress = true;
        this._newMargins = pendingMargins ?? this._getCurrentMargins();

        this._tweenDelta =
            this._computeTweenDelta(this._oldMargins, this._newMargins);

        const noshift = this._tweenDelta.dx === 0 && this._tweenDelta.dy === 0;
        this._moveAway = !this._tweenDelta.sameShape;
        if (noshift && !this._moveAway) {
            // No visible change, so just end the animation
            this._displayLive();
            return;
        }
        // Initialize transform for the OLD snapshot we are animating
        // - translation starts at the old position
        // - scale is 1.0 (no depth change yet)
        // - pivot is from tweenDelta (center for shape change, topleft otherwise)
        this._setLiveOffset(0, 0);
        this._setLiveTransform(1.0,
            this._tweenDelta.pivotx,
            this._tweenDelta.pivoty
        );

        this._offsetAnim.play();
        if (this._moveAway)
            this._springAnimation.play();
    }

    get animationsEnabled() {
        return this.Prefs.globalAnimations;
    }
};
