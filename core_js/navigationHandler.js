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
* Manifest V3 (Chrome) fallback for the blocking webRequest listener:
*
*  - top-level navigations are cleaned with the full JavaScript engine
*    (redirections, rawRules, regex rules, hash parameters) and the tab is
*    updated to the cleaned URL.
*  - non-blocking webRequest listeners feed the statistics, the badge and the log
*    for the requests that were cleaned by the declarativeNetRequest rules.
*/

/**
 * True if the navigation based cleaning has to be used
 * (no blocking webRequest available).
 */
function navigationHandlerActive() {
    return typeof browser !== "undefined" && !!browser.webNavigation && !supportsBlockingWebRequest();
}

/**
 * Cleans a top-level navigation.
 * @param details webNavigation.onBeforeNavigate details
 */
async function handleBeforeNavigate(details) {
    if (details.frameId !== 0 || details.tabId < 0) return;
    if (!/^https?:/i.test(details.url)) return;

    await ready;

    if (!storage.globalStatus || !isStorageAvailable() || !providers.length) return;

    const request = {
        url: details.url,
        tabId: details.tabId,
        frameId: details.frameId,
        type: "main_frame",
        method: "GET",
        timeStamp: details.timeStamp
    };

    let result;
    try {
        result = clearUrl(request);
    } catch (error) {
        handleError(error);
        return;
    }

    if (result && result.redirectUrl && result.redirectUrl !== details.url && /^https?:/i.test(result.redirectUrl)) {
        browser.tabs.update(details.tabId, {url: result.redirectUrl}).catch(handleError);
    }
}

/**
 * Counts the parameters of every request for the statistics.
 * Top-level navigations are counted by handleBeforeNavigate.
 */
function observeRequest(details) {
    if (!isReady || !storage.statisticsStatus || details.type === "main_frame") return;

    const url = details.url;
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) return;

    try {
        increaseTotalCounter(countFields(url));
    } catch (e) {
        // ignore malformed urls
    }
}

/**
 * Detects redirects done by the declarativeNetRequest rules and
 * reflects them in the log, the badge and the statistics.
 */
function observeRedirect(details) {
    if (!isReady || details.type === "main_frame") return;
    if (!details.redirectUrl || details.redirectUrl === details.url) return;

    const internal = /internal redirect/i.test(details.statusLine || "")
        || (details.statusCode === 307 && !details.ip && !details.fromCache);
    if (!internal) return;

    try {
        if (new URL(details.redirectUrl).origin !== new URL(details.url).origin
            || details.redirectUrl.length >= details.url.length) return;
    } catch (e) {
        return;
    }

    pushToLog(details.url, details.redirectUrl, "declarativeNetRequest");
    increaseBadged(false, details);
}

if (navigationHandlerActive()) {
    browser.webNavigation.onBeforeNavigate.addListener(handleBeforeNavigate);

    if (browser.webRequest) {
        browser.webRequest.onBeforeRequest.addListener(observeRequest, {urls: ["<all_urls>"]});
        browser.webRequest.onBeforeRedirect.addListener(observeRedirect, {urls: ["<all_urls>"]});
    }
}
