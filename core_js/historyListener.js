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
* This script is responsible for listen on history changes.
* This technique is often used to inject tracking code into the location bar,
* because all feature events will use the updated URL.
*/

/**
 * Kept for compatibility with genesis(); the listener is registered at load time
 * (required for service workers) and checks the setting on every event.
 */
function historyListenerStart() {
}

/**
 * Runs inside the page: replaces the current history entry with the cleaned URL.
 */
function replaceHistoryStateInPage(url) {
    history.replaceState(null, "", url);
}

/**
* Function that is triggered on history changes. Injects script into page
* to clean links that were pushed to the history stack with the
* history.replaceState method.
* @param  {state object} details The state object is a JavaScript object
* which is associated with the new history entry created by replaceState()
*/
function historyCleaner(details) {
    ready.then(() => {
        if (!storage.historyListenerEnabled || !storage.globalStatus) return;

        const urlBefore = details.url;
        const urlAfter = pureCleaning(urlBefore);

        if (urlBefore !== urlAfter) {
            return injectFunction(details.tabId, details.frameId, replaceHistoryStateInPage, [urlAfter]);
        }
    }).catch(onError);
}

function onError(error) {
    console.log(`[ClearURLs] Error: ${error}`);
}

if (browser.webNavigation && browser.webNavigation.onHistoryStateUpdated) {
    browser.webNavigation.onHistoryStateUpdated.addListener(historyCleaner);
}
