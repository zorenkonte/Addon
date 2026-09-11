/*
 * ClearURLs
 * Copyright (c) 2017-2025 Kevin Röbert
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/*jshint esversion: 8 */
/*
 * This script is responsible for the communication between background and content_scripts.
 */

/**
 * Handles a message from the popup, the settings page or other extension pages.
 * The message names a global background function and its parameters.
 *
 * Waits until the storage has been loaded (service worker may have just woken up).
 *
 * @param  request      The message itself. This is a JSON-ifiable object.
 * @param  sender       A runtime.MessageSender object representing the sender of the message.
 * @return {Promise<{response: *}>}
 */
async function handleMessage(request, sender) {
    await ready;

    const fn = globalThis[request.function];

    if (typeof fn !== "function") {
        return {response: undefined};
    }

    try {
        const response = await fn.apply(null, request.params || []);
        return {response};
    } catch (error) {
        handleError(error);
        return {response: undefined, error: String(error)};
    }
}

browser.runtime.onMessage.addListener(handleMessage);
