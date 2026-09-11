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
* This script is responsible for context menu cleaning functions
* and based on: https://github.com/mdn/webextensions-examples/tree/master/context-menu-copy-link-with-types
*/

const CONTEXT_MENU_ID = "copy-link-to-clipboard";

/**
 * (Re)creates the context menu entry. Called once the storage is loaded.
 * The menu is recreated on every start, so remove a possibly existing entry first
 * (a service worker restarts many times per browser session).
 */
function contextMenuStart() {
    if (!browser.contextMenus) return;

    const create = () => {
        if (!storage.contextMenuEnabled) return;

        browser.contextMenus.create({
            id: CONTEXT_MENU_ID,
            title: translate("clipboard_copy_link"),
            contexts: ["link"]
        }, () => {
            // Accessing lastError marks a "duplicate id" error as handled.
            void browser.runtime.lastError;
        });
    };

    try {
        Promise.resolve(browser.contextMenus.removeAll()).then(create, create);
    } catch (e) {
        create();
    }
}

/**
 * Runs inside the page: copies the given text to the clipboard.
 * Must be self-contained, it is serialized into the tab.
 */
function copyToClipboardInPage(text) {
    function oncopy(event) {
        document.removeEventListener("copy", oncopy, true);
        event.stopImmediatePropagation();
        event.preventDefault();
        event.clipboardData.setData("text/plain", text);
    }

    document.addEventListener("copy", oncopy, true);
    const copied = document.execCommand("copy");
    document.removeEventListener("copy", oncopy, true);

    if (!copied && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
    }
}

if (browser.contextMenus && browser.contextMenus.onClicked) {
    browser.contextMenus.onClicked.addListener((info, tab) => {
        if (info.menuItemId !== CONTEXT_MENU_ID || !tab) return;

        ready.then(() => {
            const url = pureCleaning(info.linkUrl);
            return injectFunction(tab.id, info.frameId, copyToClipboardInPage, [url]);
        }).catch((error) => {
            console.error("Failed to copy text: " + error);
        });
    });
}
