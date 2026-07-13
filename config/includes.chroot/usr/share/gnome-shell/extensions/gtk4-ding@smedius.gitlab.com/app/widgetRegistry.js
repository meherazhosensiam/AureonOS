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

/*
 * Layout:
 *   $XDG_DATA_HOME/<app-id>/widgets/<widgetId>/widget.json
 *   $XDG_DATA_DIRS/.../<app-id>/widgets/<widgetId>/widget.json
 */

import {Gio, GLib} from '../dependencies/gi.js';

export {WidgetRegistry};

function cloneJsonObject(value, fallback = {}) {
    if (value === null || value === undefined)
        return fallback;

    try {
        return JSON.parse(JSON.stringify(value));
    } catch (e) {
        console.error('WidgetRegistry: failed to clone JSON object:', e);
        return fallback;
    }
}

const WidgetRegistry = class  {
    constructor(desktopIconsUtil) {
        this._util = desktopIconsUtil;

        this._appId = null;
        this._userRoot = null;
        this._systemRoots = [];

        // id -> descriptor
        this._widgets = new Map();

        this._loaded = false;
        this._loadingPromise = null;

        this._initPaths();
        this.preload();
    }

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    preload() {
        this._ensureLoadedAsync().catch(e => {
            console.error('WidgetRegistry.preload():', e);
        });
    }

    /**
     * Get a snapshot of all known widgets.
     *
     * @returns {Promise<Array<object>>}
     */
    async listWidgets() {
        await this._ensureLoadedAsync();
        return Array.from(this._widgets.values()).map(
            desc => this._cloneDescriptor(desc)
        );
    }

    /**
     * Look up a widget descriptor by ID.
     *
     * Descriptor shape:
     * {
     *   id: string,
     *   name: string,
     *   kind: 'html' | 'gtk',
     *   dir: Gio.File,
     *   manifestFile: Gio.File,
     *   isUser: boolean,
     *   defaultWidth: number | null,
     *   defaultHeight: number | null,
     *   defaultConfig: object | null,
     *   "name_localized": {
     *     "fr": "Horloge analogique"
     *   },
     *   description: "A simple analog clock widget.",
     *   "description_localized": {
     *     "fr": "Un widget d'horloge analogique simple."
     *   },
     *   category: "time",
     *   author: "Sundeep Mediratta",
     *   version: "1.0",
     *   homepage: "https://…",
     *   license: "GPL-3.0-or-later",
     *   pinnable: boolean,
     *   chrome: {
     *     showCloseButton: boolean,
     *     showPrefsButton: boolean,
     *     showMoveButton: boolean,
     *     showPinButton: boolean
     *   }
     * }
     *
     * @param {string} id Widget identifier
     * @returns {Promise<object|null>}
     */
    async getDescriptor(id) {
        if (!id)
            return null;

        await this._ensureLoadedAsync();
        const desc = this._widgets.get(id) ?? null;
        return desc ? this._cloneDescriptor(desc) : null;
    }

    /*
     * Get widget kind ('html' | 'gtk')
     *
     * @param {string} id Widget identifier
     * @returns {Promise<'html'|'gtk'>}
     */
    async getKind(id) {
        const desc = await this.getDescriptor(id);
        return desc?.kind === 'gtk' ? 'gtk' : 'html';
    }

    /**
     * For HTML widgets, return the entry file (always index.html).
     *
     * @param {string} id Widget identifier
     * @returns {Promise<Gio.File|null>}
     */
    async getHtmlEntryFile(id) {
        const desc = await this.getDescriptor(id);
        if (!desc || desc.kind !== 'html')
            return null;

        const file = desc.dir.get_child('index.html');

        try {
            const info = file.query_info(
                'standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            if (info.get_file_type() === Gio.FileType.REGULAR)
                return file;
        } catch (e) {
            console.error(
                'WidgetRegistry: getHtmlEntryFile failed for',
                id,
                e
            );
        }

        return null;
    }

    reload() {
        this._loaded = false;
        this._loadingPromise = null;
        this._widgets.clear();
        this.preload();
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    _initPaths() {
        const mainApp = this._util.mainApp;
        const appId = mainApp?.get_application_id
            ? mainApp.get_application_id()
            : null;

        if (!appId) {
            console.error(
                'WidgetRegistry: application-id not available; ' +
                'widget paths will not be resolved.'
            );
            return;
        }

        this._appId = appId;

        // User root: $XDG_DATA_HOME/<app-id>/widgets
        try {
            const appDataDir = this._util.getAppUserDataDir();
            this._userRoot = appDataDir.get_child('widgets');
        } catch (e) {
            console.warn('WidgetRegistry: failed to resolve user root:', e);
        }

        // System roots: for each XDG data dir, <dir>/<app-id>/widgets
        try {
            const systemBaseDirs = GLib.get_system_data_dirs();

            this._systemRoots = systemBaseDirs.map(base => {
                return Gio.File.new_build_filenamev([
                    base,
                    this._appId,
                    'widgets',
                ]);
            });
        } catch (e) {
            console.warn('WidgetRegistry: failed to build system roots:', e);
            this._systemRoots = [];
        }
    }

    async _ensureLoadedAsync() {
        if (this._loaded)
            return;

        // Idempotent
        if (this._loadingPromise) {
            await this._loadingPromise;
            return;
        }

        const loadPromise = this._loadOnceAsync();
        this._loadingPromise = loadPromise;

        try {
            await loadPromise;
        } finally {
            this._loadingPromise = null;
        }
    }

    async _loadOnceAsync() {
        const newMap = new Map();

        this._loggedDuplicateIds = new Set();

        if (this._userRoot)
            await this._scanRootAsync(this._userRoot, true, newMap);

        for (const root of this._systemRoots)
            // eslint-disable-next-line no-await-in-loop
            await this._scanRootAsync(root, false, newMap);

        this._widgets = newMap;
        this._loaded = true;
    }

    /**
     * Async scan of a single root dir:
     *   <root>/<widgetId>/widget.json
     *
     * @param {Gio.File} root
     * @param {boolean} isUser
     * @param {Map<string,object>} outMap
     */
    async _scanRootAsync(root, isUser, outMap) {
        let info;
        try {
            info = root.query_info(
                'standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
        } catch (e) {
            return;
        }

        if (info.get_file_type() !== Gio.FileType.DIRECTORY)
            return;

        let enumerator;
        try {
            enumerator = root.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
        } catch (e) {
            console.error(
                'WidgetRegistry: enumerate_children failed for',
                root.get_path?.(),
                e
            );
            return;
        }

        try {
            while (true) {
                // eslint-disable-next-line no-await-in-loop
                const files = await this._nextFilesAsync(enumerator);
                if (!files.length)
                    break;

                for (const finfo of files) {
                    if (finfo.get_file_type() !== Gio.FileType.DIRECTORY)
                        continue;

                    const name = finfo.get_name();
                    const widgetDir = root.get_child(name);
                    const manifestFile =
                        widgetDir.get_child('widget.json');

                    let manifestInfo;
                    try {
                        manifestInfo = manifestFile.query_info(
                            'standard::type',
                            Gio.FileQueryInfoFlags.NONE,
                            null
                        );
                    } catch (e) {
                        continue;
                    }

                    if (manifestInfo.get_file_type() !== Gio.FileType.REGULAR)
                        continue;

                    const manifest =
                        // eslint-disable-next-line no-await-in-loop
                        await this._util.readJsonFile(manifestFile);
                    if (!manifest)
                        continue;

                    // ID must come from widget.json and must be valid.
                    const idRaw =
                        typeof manifest.id === 'string'
                            ? manifest.id.trim() : '';
                    const idOk =
                        !!idRaw && /^[A-Za-z0-9._-]+$/.test(idRaw);

                    if (!idOk) {
                        const mf =
                            manifestFile.get_path?.() ??
                            manifestFile.get_uri?.() ??
                            String(manifestFile);
                        console.warn(
                            `WidgetRegistry:
                            rejecting widget with invalid id in ${mf}`
                        );
                        continue;
                    }

                    const id = idRaw;
                    const kind = manifest.kind === 'gtk' ? 'gtk' : 'html';
                    const widgetName =
                        typeof manifest.name === 'string' &&
                            manifest.name.trim()
                            ? manifest.name.trim()
                            : id;
                    const description =
                        typeof manifest.description === 'string' &&
                            manifest.description.trim()
                            ? manifest.description.trim()
                            : id;
                    const author = manifest.author || '';
                    const version = manifest.version || '';
                    const icon = manifest.icon || '';

                    const defaultWidth =
                        Number.isFinite(manifest.defaultWidth)
                            ? Math.max(1, Math.floor(manifest.defaultWidth))
                            : 260;

                    const defaultHeight =
                        Number.isFinite(manifest.defaultHeight)
                            ? Math.max(1, Math.floor(manifest.defaultHeight))
                            : 160;

                    const defaultConfig = cloneJsonObject(
                        this._isObject(manifest.defaultConfig)
                            ? manifest.defaultConfig
                            : {},
                        {}
                    );

                    const prefs =
                        typeof manifest.prefs === 'string'
                            ? manifest.prefs
                            : null;

                    const backend =
                        this._isObject(manifest.backend)
                            ? manifest.backend
                            : null;
                    const pinnable = manifest.pinnable === true;

                    const chrome = this._normalizeChromePolicy(
                        manifest.chrome
                    );

                    const desc = {
                        id,
                        kind,
                        dir: widgetDir,
                        manifestFile,
                        isUser,
                        name: widgetName,
                        description,
                        author,
                        version,
                        icon,
                        defaultWidth,
                        defaultHeight,
                        defaultConfig,
                        prefs,
                        backend,
                        pinnable,
                        chrome,
                        hasBackend: !!backend,
                    };

                    // Resolve duplicates deterministically;
                    // log each duplicated id only once.

                    const existing = outMap.get(id);
                    if (existing) {
                        const replace = isUser && !existing.isUser;

                        this._logDuplicateIds(
                            id, existing, replace, widgetDir, isUser
                        );

                        if (replace)
                            outMap.set(id, desc);
                    } else {
                        outMap.set(id, desc);
                    }
                }
            }
        } catch (e) {
            console.error(
                'WidgetRegistry: error scanning root',
                root.get_path?.(),
                e
            );
        } finally {
            try {
                enumerator.close(null);
            } catch (e) {
                console.error(
                    'WidgetRegistry: error closing enumerator',
                    e
                );
            }
        }
    }

    _isObject(object) {
        const isObject =
            object !== null &&
            typeof object === 'object' &&
            !Array.isArray(object) &&
            Object.getPrototypeOf(object) === Object.prototype;

        return isObject;
    }

    _normalizeChromePolicy(policy) {
        const defaults = {
            showCloseButton: true,
            showPrefsButton: true,
            showMoveButton: true,
            showPinButton: true,
        };

        if (!this._isObject(policy))
            return defaults;

        return {
            showCloseButton:
                typeof policy.showCloseButton === 'boolean'
                    ? policy.showCloseButton
                    : defaults.showCloseButton,
            showPrefsButton:
                typeof policy.showPrefsButton === 'boolean'
                    ? policy.showPrefsButton
                    : defaults.showPrefsButton,
            showMoveButton:
                typeof policy.showMoveButton === 'boolean'
                    ? policy.showMoveButton
                    : defaults.showMoveButton,
            showPinButton:
                typeof policy.showPinButton === 'boolean'
                    ? policy.showPinButton
                    : defaults.showPinButton,
        };
    }

    _logDuplicateIds(id, existing, replace, widgetDir, isUser) {
        if (this._loggedDuplicateIds.has(id))
            return;

        const toPathString = file =>
            file?.get_path?.() ??
            file?.get_uri?.() ??
            String(file);

        const existingPath = toPathString(existing?.dir);
        const newPath = toPathString(widgetDir);
        const existingScope = existing?.isUser ? 'user' : 'system';
        const newScope = isUser ? 'user' : 'system';
        const action = replace ? 'using user override' : 'keeping first';

        console.warn(
            `WidgetRegistry: duplicate widget id "${id}": ` +
            `${existingPath} (${existingScope}) vs ` +
            `${newPath} (${newScope}) — ${action}`
        );
        this._loggedDuplicateIds.add(id);
    }

    _cloneDescriptor(desc) {
        if (!desc)
            return null;

        return {
            ...desc,
            defaultConfig: cloneJsonObject(desc.defaultConfig, {}),
            backend: desc.backend ? cloneJsonObject(desc.backend, null) : null,
            chrome: desc.chrome ? cloneJsonObject(desc.chrome, null) : null,
        };
    }

    _nextFilesAsync(enumerator) {
        const batchSize = 32;
        const cancelable = null;

        return new Promise((resolve, reject) => {
            enumerator.next_files_async(
                batchSize,
                GLib.PRIORITY_DEFAULT,
                cancelable,
                (src, res) => {
                    try {
                        const files = src.next_files_finish(res);
                        resolve(files ?? []);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    normalizeBackendSpec(desc, inst) {
        return this._normalizeBackendSpec(desc, inst);
    }

    _normalizeBackendSpec(desc, inst) {
        const b = desc?.backend;
        if (!b || typeof b !== 'object')
            return null;

        const dirFile = desc.dir;
        const dirPath = dirFile?.get_path?.();
        if (!dirFile || !dirPath)
            return null;

        const argv = this._buildBackendArgv(b, dirFile);
        if (!argv?.length) {
            console.error(
                'WidgetRegistry: backend argv missing/invalid for widget',
                desc?.id ?? '<unknown>'
            );
            return null;
        }

        const cwd = this._resolveBackendCwd(b, dirFile, dirPath);

        const envOverrides =
            b.env && typeof b.env === 'object' ? b.env : null;

        const env = {
            DING_WIDGET_ID: String(inst?.widgetId ?? ''),
            DING_INSTANCE_ID: String(inst?.instanceId ?? ''),
        };

        if (envOverrides) {
            for (const [key, value] of Object.entries(envOverrides)) {
                if (typeof key !== 'string')
                    continue;
                if (value === undefined)
                    continue;
                env[key] = typeof value === 'string'
                    ? value
                    : String(value);
            }
        }

        return {
            argv,
            cwd,
            env,
        };
    }

    _buildBackendArgv(backend, dirFile) {
        const cmd = backend?.command;
        if (typeof cmd !== 'string' || cmd.length === 0)
            return null;

        // eslint-disable-next-line no-nested-ternary
        const args = Array.isArray(backend.args)
            ? backend.args.filter(a => typeof a === 'string')
            : Array.isArray(backend.argv)
                ? backend.argv.filter(a => typeof a === 'string')
                : [];

        // Resolve argv[0] to an absolute path if it isn't already.
        let argv0 = null;

        if (cmd.startsWith('/')) {
            argv0 = cmd;
        } else if (cmd.includes('/')) {
            const f = dirFile.resolve_relative_path
                ? dirFile.resolve_relative_path(cmd)
                : dirFile.get_child(cmd);
            argv0 = f?.get_path?.() ?? null;
        } else {
            argv0 = GLib.find_program_in_path(cmd);
            if (!argv0) {
                const f = dirFile.resolve_relative_path
                    ? dirFile.resolve_relative_path(cmd)
                    : dirFile.get_child(cmd);
                argv0 = f?.get_path?.() ?? null;
            }
        }

        if (!argv0)
            return null;

        return [argv0, ...args];
    }

    _resolveBackendCwd(backend, dirFile, fallbackDirPath) {
        const cwdRel =
            typeof backend?.cwd === 'string' && backend.cwd.length
                ? backend.cwd
                : '.';

        const cwdFile = dirFile.resolve_relative_path
            ? dirFile.resolve_relative_path(cwdRel)
            : dirFile.get_child(cwdRel);
        return cwdFile?.get_path?.() ?? fallbackDirPath;
    }
};
