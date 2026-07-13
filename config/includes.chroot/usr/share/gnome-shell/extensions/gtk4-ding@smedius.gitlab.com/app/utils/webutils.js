/* eslint-disable jsdoc/require-param-type */
/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2026 Sundeep Mediratta <smedius@gmail.com>
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
import {Gio, GLib, Soup} from '../../dependencies/localFiles.js';

/**
 *
 * @param message
 * @param bytes
 * @returns {{ok: boolean, error?: string}}
 */
export function verifyHttpDownload(message, bytes) {
    if (!message) {
        return {
            ok: false,
            error: 'Download verification failed: missing response.',
        };
    }

    const status = message.get_status?.() ?? 0;
    if (status !== Soup.Status.OK) {
        return {
            ok: false,
            error: `Download failed: HTTP ${status}`,
        };
    }

    if (!bytes || bytes.get_size() <= 0) {
        return {
            ok: false,
            error: 'Download verification failed: empty archive.',
        };
    }

    return {ok: true};
}

/**
 *
 * @param url
 * @param timeoutMs
 * @param cancellable
 * @returns {Promise<{message: object, bytes: GLib.Bytes}>}
 */
export async function downloadBytes(url, timeoutMs = 30, cancellable = null) {
    if (!Soup)
        throw new Error('Soup is unavailable');

    const session = new Soup.Session({
        timeout: timeoutMs,
    });

    const message = Soup.Message.new('GET', url);
    let cancelId = 0;

    try {
        if (cancellable) {
            cancelId = cancellable.connect(() => {
                session.abort();
            });
        }

        const bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (_soupSession, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });

        const verification = verifyHttpDownload(message, bytes);
        if (!verification.ok) {
            const error = new Error(verification.error);
            error.status = message.get_status() ?? 0;
            throw error;
        }

        return {message, bytes};
    } finally {
        if (!cancellable || !cancellable.is_cancelled())
            session.abort();

        if (cancelId && cancellable)
            cancellable.disconnect(cancelId);
    }
}

/**
 *
 * @param file
 * @param bytes
 * @param cancellable
 */
export async function writeBytesToFile(file, bytes, cancellable = null) {
    await new Promise((resolve, reject) => {
        try {
            file.replace_contents_bytes_async(
                bytes,
                null,
                true,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                cancellable,
                (_source, result) => {
                    try {
                        resolve(file.replace_contents_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        } catch (e) {
            reject(e);
        }
    });
}

/**
 *
 * @param archiveFile
 * @param extractDir
 * @param cancellable
 */
export async function extractTarGzArchive(
    archiveFile,
    extractDir,
    cancellable = null
) {
    // Keep the tar fallback async in the app process so extraction does not
    // block GNOME Shell when AutoAr is unavailable.
    const subprocess = new Gio.Subprocess({
        argv: [
            'tar',
            '-xzf',
            String(archiveFile.get_path()),
            '-C',
            String(extractDir.get_path()),
        ],
        flags:
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE,
    });

    const [, stdout, stderr] = await new Promise((resolve, reject) => {
        subprocess.communicate_utf8_async(
            null,
            cancellable,
            (_proc, result) => {
                try {
                    resolve(subprocess.communicate_utf8_finish(result));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });

    if (!subprocess.get_if_exited() || subprocess.get_exit_status() !== 0) {
        const output = stderr?.trim() || stdout?.trim() || 'Archive extraction failed';
        throw new Error(output);
    }
}
