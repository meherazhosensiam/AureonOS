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

import {Gio, GLib} from '../dependencies/gi.js';
import {HtmlWidgetHost} from '../dependencies/localFiles.js';

export {HtmlWidgetHostWithBackend};

const HtmlWidgetHostWithBackend = class extends HtmlWidgetHost {
    constructor(params) {
        super(params);
        this._backendProc = null;
        this._backendIn = null;
        this._backendOut = null;
        this._backendErr = null;
        this._backendReading = false;
        this._backendPending = new Map();
        this._decoder = new TextDecoder('utf-8');
        this._pendingBackendRequests = [];
        this._pendingBackendEvents = [];
        this._backendEnsurePromise = null;
    }

    async _ensureBackend(inst) {
        if (!inst || this._destroyed)
            return false;

        if (this._backendProc)
            return true;

        if (this._backendEnsurePromise)
            return this._backendEnsurePromise;

        const ensurePromise = this._startBackend(inst);

        this._backendEnsurePromise = ensurePromise;

        let result;
        try {
            result = await ensurePromise;
        } finally {
            if (this._backendEnsurePromise === ensurePromise)
                this._backendEnsurePromise = null;
        }

        if (result?.ok) {
            this._flushPendingBackendRequests();
            this._flushPendingBackendEvents();
            return true;
        }

        this._failPendingBackendRequests(
            inst,
            result?.error ?? {
                code: 'E_NO_BACKEND',
                message: 'No backend configured',
            }
        );
        return false;
    }

    async _buildBackendSpec(inst) {
        if (!inst)
            return null;

        if (inst.backendSpec)
            return inst.backendSpec;

        if (!this._widgetRegistry)
            return null;

        let desc = null;
        try {
            desc = await this._widgetRegistry.getDescriptor(inst.widgetId);
        } catch (e) {
            console.error(
                'HtmlWidgetHostWithBackend: failed to fetch descriptor:',
                e
            );
            return null;
        }

        if (!desc) {
            console.error(
                'HtmlWidgetHostWithBackend: no descriptor for widget',
                inst?.widgetId ?? '<unknown>'
            );
            return null;
        }

        const spec =
            this._widgetRegistry.normalizeBackendSpec(desc, inst);

        inst.backendSpec = spec || null;

        return spec;
    }

    async _startBackend(inst) {
        let spec = inst?.backendSpec;
        if (!spec)
            spec = await this._buildBackendSpec(inst);

        if (!spec?.argv?.length) {
            console.error(
                'HtmlWidgetHostWithBackend: no backend configured for widget',
                inst?.widgetId ?? '<unknown>'
            );
            return {
                ok: false,
                error: {code: 'E_NO_BACKEND', message: 'No backend configured'},
            };
        }

        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                    Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            });

            if (spec.cwd)
                launcher.set_cwd(spec.cwd);

            if (spec.env) {
                for (const [key, value] of Object.entries(spec.env)) {
                    if (typeof key !== 'string')
                        continue;
                    launcher.setenv(key, String(value ?? ''), true);
                }
            }

            const argv = Array.isArray(spec.argv) ? [...spec.argv] : [];

            this._backendProc = launcher.spawnv(argv);
            this._backendIn = new Gio.DataOutputStream({
                base_stream: this._backendProc.get_stdin_pipe(),
            });

            this._backendOut = new Gio.DataInputStream({
                base_stream: this._backendProc.get_stdout_pipe(),
            });

            this._backendErr = new Gio.DataInputStream({
                base_stream: this._backendProc.get_stderr_pipe(),
            });

            this._backendReading = true;

            // Read stdout (protocol messages)
            this._readBackendStream(
                inst,
                this._backendOut,
                msg => this._handleBackendMessage(inst, msg),
                'stdout'
            ).catch(e => {
                console.error('BACKEND stdout loop error:', e?.message ?? e);
            });

            // Read stderr (debug/logs)
            this._readBackendStream(
                inst,
                this._backendErr,
                line => {
                    try {
                        console.warn(
                            'BACKEND stderr:',
                            inst?.instanceId ?? '<unknown>',
                            line.trim()
                        );
                    } catch (_e) {}
                },
                'stderr'
            ).catch(e => {
                console.error('BACKEND stderr loop error:', e?.message ?? e);
            });

            this._waitBackend(inst);

            this._sendBackend({
                type: 'hello',
                instanceId: inst.instanceId,
                widgetId: inst.widgetId,
                mode: 'widget',
                config: inst.config || {},
            });

            return {ok: true};
        } catch (e) {
            console.error(
                'HtmlWidgetHostWithBackend: failed to start backend:', e
            );

            this._handleBackendExit(inst, {
                code: 'E_BACKEND_START',
                message: e?.message ?? 'Failed to start backend',
            });

            return {
                ok: false,
                error: {
                    code: 'E_BACKEND_START',
                    message: e?.message ?? 'Failed to start backend',
                },
            };
        }
    }

    // Backend expects newline-delimited JSON objects. Known outbound shapes:
    //  - hello:  {type, instanceId, widgetId, mode, config}
    //  - request {type, id, method, params}
    _sendBackend(obj) {
        if (!this._backendIn)
            return;

        try {
            this._backendIn.put_string(`${JSON.stringify(obj)}\n`, null);
            this._backendIn.flush(null);
        } catch (e) {
            console.error(
                'HtmlWidgetHostWithBackend: write backend failed:', e
            );
        }
    }

    async _readBackendStream(inst, stream, onLine, label) {
        if (!stream)
            return;

        while (this._backendReading && stream) {
            let line;

            try {
                // eslint-disable-next-line no-await-in-loop
                const [bytes] = await stream.read_line_async(
                    GLib.PRIORITY_DEFAULT,
                    null
                );

                if (!bytes)
                    break;

                line = this._decoder.decode(bytes);
            } catch (e) {
                console.error('BACKEND stream read error:', label, e?.message ?? e);
                break;
            }

            try {
                let payload = line;
                if (label === 'stdout') {
                    try {
                        payload = JSON.parse(line);
                    } catch (e) {
                        console.error('BACKEND stdout JSON parse error:', e?.message ?? e);
                        continue;
                    }
                }
                onLine?.(payload);
            } catch (_e) {
                // Ignore per-line handler errors
            }
        }

        if (this._backendReading) {
            this._backendReading = false;
            this._handleBackendExit(inst, {
                code: 'E_BACKEND_EXIT',
                message: 'Backend process exited',
            });
        }
    }

    _flushPendingBackendRequests() {
        if (!this._pendingBackendRequests.length)
            return;

        for (const entry of this._pendingBackendRequests)
            this._dispatchBackendRequest(entry.payload);

        this._pendingBackendRequests.length = 0;
    }

    _flushPendingBackendEvents() {
        if (!this._pendingBackendEvents.length)
            return;

        for (const entry of this._pendingBackendEvents) {
            this._sendBackend({
                type: 'event',
                name: entry.name,
                payload: entry.payload || {},
            });
        }

        this._pendingBackendEvents.length = 0;
    }

    _handleBackendExit(inst, error) {
        this._backendReading = false;

        const proc = this._backendProc;
        this._backendProc = null;
        this._backendIn = null;
        this._backendOut = null;
        this._backendErr = null;

        if (this._destroyed)
            return;

        this._logBackendExit(inst, proc, error);
        this._failInFlightBackendRequests(inst, error);
        this._pendingBackendRequests.length = 0;
        this._pendingBackendEvents.length = 0;
    }

    _failPendingBackendRequests(inst, error) {
        if (!this._pendingBackendRequests.length || this._destroyed) {
            this._pendingBackendRequests.length = 0;
            return;
        }

        const requestIds = [];
        for (const entry of this._pendingBackendRequests) {
            const requestId = entry.payload?.requestId;
            if (requestId)
                requestIds.push(requestId);
        }

        this._failBackendRequestIds(inst, requestIds, error);
        this._pendingBackendRequests.length = 0;
    }

    _failInFlightBackendRequests(inst, error) {
        if (!this._backendPending.size || this._destroyed) {
            this._backendPending.clear();
            return;
        }

        const requestIds = Array.from(this._backendPending.keys());
        this._backendPending.clear();
        this._failBackendRequestIds(inst, requestIds, error);
    }

    _failBackendRequestIds(inst, requestIds, error) {
        if (!requestIds.length || this._destroyed)
            return;

        const instanceId = inst?.instanceId;
        if (!instanceId)
            return;

        const err = error || {
            code: 'E_BACKEND_FAILURE',
            message: 'Backend unavailable',
        };

        for (const requestId of requestIds) {
            this.postMessage({
                _dingInternal: true,
                type: 'backendReply',
                instanceId,
                requestId,
                ok: false,
                error: err,
            });
        }
    }

    _dispatchBackendRequest(payload) {
        if (!payload || !this._backendProc || this._destroyed)
            return;

        const {requestId, method, params} = payload;
        if (requestId === undefined || requestId === null)
            return;

        this._backendPending.set(requestId, true);

        this._sendBackend({
            type: 'request',
            id: requestId,
            method,
            params: params || {},
        });
    }

    // Inbound JSON objects are expected to be of type response, event or log.
    //  - response: {type, id, ok, result, error}
    //  - event:    {type, name, payload}
    //  - log:      {type, level, message}
    // with author-defined 'name' and custom JSON 'payload'

    _handleBackendMessage(inst, msg) {
        if (!msg || typeof msg !== 'object')
            return;

        switch (msg.type) {
        case 'response': {
            const requestId = msg.id;
            this._backendPending.delete(requestId);

            this.postMessage({
                _dingInternal: true,
                type: 'backendReply',
                instanceId: inst.instanceId,
                requestId,
                ok: !!msg.ok,
                result: msg.result,
                error: msg.error,
            });
            break;
        }

        case 'event': {
            this.postMessage({
                _dingInternal: true,
                type: 'backendEvent',
                instanceId: inst.instanceId,
                name: msg.name,
                payload: msg.payload,
            });
            break;
        }

        case 'log': {
            const level = msg.level || 'log';
            const text = msg.message || '';
            console.log(`HtmlWidget backend ${level}:`, inst.instanceId, text);
            break;
        }

        default:
            break;
        }
    }

    async backendRequest(inst, payload) {
        if (!inst || !payload || this._destroyed)
            return;

        if (this._backendProc) {
            this._dispatchBackendRequest(payload);
            return;
        }

        this._pendingBackendRequests.push({
            instanceId: inst.instanceId,
            payload,
        });

        await this._ensureBackend(inst);
    }

    backendSend(inst, payload) {
        if (!inst || !payload || this._destroyed)
            return;

        const {name, payload: data} = payload || {};
        if (this._backendProc) {
            this._sendBackend({
                type: 'event',
                name,
                payload: data || {},
            });
            return;
        }

        this._pendingBackendEvents.push({
            name,
            payload: data || {},
        });

        this._ensureBackend(inst);
    }

    destroy() {
        this._destroyed = true;

        try {
            if (this._backendIn)
                this._sendBackend({type: 'shutdown'});
        } catch {}

        this._backendReading = false;

        try {
            this._backendProc?.send_signal?.(15);
        } catch {}

        try {
            this._backendProc?.force_exit();
        } catch {}

        this._backendProc = null;
        this._backendIn = null;
        this._backendOut = null;
        this._backendErr = null;
        this._pendingBackendRequests.length = 0;
        this._pendingBackendEvents.length = 0;
        this._backendEnsurePromise = null;

        super.destroy();
    }

    async _readBackendStderr(inst) {
        if (!this._backendErr)
            return;

        while (!this._destroyed && this._backendErr) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const [bytes] = await this._backendErr.read_line_async(
                    GLib.PRIORITY_DEFAULT,
                    null
                );

                if (!bytes)
                    break;

                const line = this._decoder.decode(bytes);
                console.error(
                    'BACKEND STDERR:',
                    inst?.instanceId ?? '<unknown>',
                    line.trim()
                );
            } catch (_e) {
                break;
            }
        }
    }

    async _waitBackend(inst) {
        const proc = this._backendProc;
        if (!proc)
            return;

        try {
            const ok = await new Promise((resolve, reject) => {
                proc.wait_check_async(null, (p, res) => {
                    try {
                        resolve(p.wait_check_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            console.error(
                'BACKEND EXIT STATUS:',
                inst?.instanceId ?? '<unknown>',
                ok ? 'ok' : 'fail',
                'status:',
                proc.get_exit_status()
            );
        } catch (e) {
            if (this._destroyed)
                return;
            console.error(
                'BACKEND EXIT wait error:',
                inst?.instanceId ?? '<unknown>',
                e?.message ?? e
            );
        }
    }

    _logBackendExit(inst, proc, error) {
        if (!proc)
            return;

        const pid = proc.get_identifier();

        const msg = error?.message ?? 'Backend process exited';
        const code = error?.code ? `(${error.code})` : '';
        const pidStr = pid ? `pid ${pid}` : 'pid unknown';

        console.error(
            'HtmlWidget backend exit:',
            inst?.instanceId ?? '<unknown>',
            pidStr,
            msg,
            code
        );
    }
};
