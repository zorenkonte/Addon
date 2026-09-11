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
* Manifest V3 (Chrome) does not allow blocking webRequest listeners anymore.
* This script translates the ClearURLs providers into declarativeNetRequest
* session rules, so that tracking parameters are removed on the network layer
* for every request type:
*
*  - literal rules      -> one redirect rule per provider (queryTransform.removeParams)
*  - regex rules        -> one regex redirect rule per rule (regexSubstitution)
*  - exceptions         -> allow rules with a higher priority
*  - completeProvider   -> block rules (main_frame is redirected to the blocked page)
*  - pingBlocking       -> block rule for ping requests
*  - eTagFiltering      -> modifyHeaders rule that removes the ETag header
*  - localHostsSkipping -> allow rule for local addresses
*
* Redirections, rawRules and hash (#) parameters cannot be expressed with
* declarativeNetRequest; they are handled for top-level navigations
* by core_js/navigationHandler.js.
*/

const DNR_RELEVANT_KEYS = ["globalStatus", "referralMarketing", "domainBlocking", "pingBlocking",
    "eTagFiltering", "localHostsSkipping", "types", "pingRequestTypes"];
const DNR_ALL_TYPES = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
    "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"];
const DNR_REGEX_META = /[\\^$.*+?()[\]{}|\/]/;
const DNR_TRAILING_SEPARATOR_REGEX = "^(.*?)[?&]$";
const DNR_LOCAL_HOSTS_REGEX = "^[a-z][a-z0-9+.-]*://(?:localhost|127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}" +
    "|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3}" +
    "|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}" +
    "|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}" +
    "|169\\.254\\.\\d{1,3}\\.\\d{1,3})(?::\\d+)?(?:[/?#]|$)";

let dnrSyncTimer = null;
let dnrSyncChain = Promise.resolve();
let dnrMemorySession = {};

/**
 * Returns true if the declarativeNetRequest API is available.
 */
function hasDNR() {
    return typeof browser !== "undefined" && !!browser.declarativeNetRequest
        && typeof browser.declarativeNetRequest.updateSessionRules === "function";
}

/**
 * Debounced request to rebuild the declarativeNetRequest rules.
 * Called after the providers were (re)built and when a relevant setting changed.
 */
function scheduleDNRSync() {
    if (!hasDNR()) return;

    clearTimeout(dnrSyncTimer);
    dnrSyncTimer = setTimeout(() => {
        syncDNRRules().catch(handleError);
    }, 250);
}

/**
 * Rebuilds the rules. Calls are serialized.
 * @return {Promise<void>}
 */
function syncDNRRules() {
    if (!hasDNR()) return Promise.resolve();

    dnrSyncChain = dnrSyncChain.catch(() => {}).then(_syncDNRRules);
    return dnrSyncChain;
}

async function _syncDNRRules() {
    await ready;

    const rules = await buildDNRRules();
    const hash = await sha256(JSON.stringify(rules));
    const previous = await dnrSessionGet("dnrRulesHash");
    const existing = await browser.declarativeNetRequest.getSessionRules();

    if (previous === hash && (existing.length > 0 || rules.length === 0)) return;

    if (existing.length) {
        await browser.declarativeNetRequest.updateSessionRules({removeRuleIds: existing.map(r => r.id)});
    }

    await addDNRRulesResilient(rules);
    await dnrSessionSet("dnrRulesHash", hash);

    const active = await browser.declarativeNetRequest.getSessionRules();
    console.log("[ClearURLs] declarativeNetRequest: " + active.length + " of " + rules.length + " session rules active");
}

/**
 * Adds the rules; if the browser rejects the batch, bisects to skip only the offending rules.
 */
async function addDNRRulesResilient(rules) {
    if (!rules.length) return;

    try {
        await browser.declarativeNetRequest.updateSessionRules({addRules: rules});
    } catch (error) {
        if (rules.length === 1) {
            console.warn("[ClearURLs] declarativeNetRequest rule skipped: " + error, rules[0]);
            return;
        }

        const mid = rules.length >> 1;
        await addDNRRulesResilient(rules.slice(0, mid));
        await addDNRRulesResilient(rules.slice(mid));
    }
}

/**
 * Resource types to clean, based on the "types" setting.
 */
function dnrResourceTypes() {
    const types = (storage.types || []).filter(t => DNR_ALL_TYPES.includes(t));
    return types.length ? types : DNR_ALL_TYPES.slice();
}

/**
 * Converts all capturing groups of a regex string to non-capturing groups,
 * so that the group numbering of the surrounding regex stays stable.
 */
function toNonCapturing(regex) {
    let out = "";
    let inClass = false;

    for (let i = 0; i < regex.length; i++) {
        const c = regex[i];

        if (c === "\\") {
            out += c + (regex[i + 1] !== undefined ? regex[i + 1] : "");
            i++;
            continue;
        }

        if (inClass) {
            if (c === "]") inClass = false;
            out += c;
            continue;
        }

        if (c === "[") {
            inClass = true;
            out += c;
            continue;
        }

        if (c === "(" && regex[i + 1] !== "?") {
            out += "(?:";
            continue;
        }

        out += c;
    }

    return out;
}

/**
 * Builds the complete rule set from the current providers and settings.
 * @return {Promise<Array>} rules with consecutive ids
 */
async function buildDNRRules() {
    const rules = [];

    if (!storage.globalStatus || !isStorageAvailable()) return rules;

    let nextId = 1;
    const types = dnrResourceTypes();
    const regexChecks = [];

    const add = (rule, regexToValidate = null) => {
        rule.id = nextId++;
        rules.push(rule);
        if (regexToValidate !== null) regexChecks.push({rule, regex: regexToValidate});
    };

    if (storage.localHostsSkipping) {
        add({
            priority: 3,
            action: {type: "allow"},
            condition: {regexFilter: DNR_LOCAL_HOSTS_REGEX, resourceTypes: DNR_ALL_TYPES, isUrlFilterCaseSensitive: false}
        }, DNR_LOCAL_HOSTS_REGEX);
    }

    if (storage.pingBlocking) {
        const pingTypes = (storage.pingRequestTypes || []).filter(t => DNR_ALL_TYPES.includes(t));
        if (pingTypes.length) {
            add({priority: 1, action: {type: "block"}, condition: {resourceTypes: pingTypes}});
        }
    }

    if (storage.eTagFiltering) {
        add({
            priority: 1,
            action: {type: "modifyHeaders", responseHeaders: [{header: "ETag", operation: "remove"}]},
            condition: {resourceTypes: DNR_ALL_TYPES}
        });
    }

    // Removes a dangling "?" or "&" left behind by a parameter removal.
    add({
        priority: 1,
        action: {type: "redirect", redirect: {regexSubstitution: "\\1"}},
        condition: {regexFilter: DNR_TRAILING_SEPARATOR_REGEX, resourceTypes: types, isUrlFilterCaseSensitive: false}
    }, DNR_TRAILING_SEPARATOR_REGEX);

    const blockedPage = browser.runtime.getURL("html/siteBlockedAlert.html");
    const subTypes = types.filter(t => t !== "main_frame");

    for (const provider of providers) {
        const pattern = provider.getURLPatternString();
        const isGlobal = pattern === "" || pattern === ".*";
        const patternPrefix = isGlobal ? ""
            : (pattern.startsWith("^") ? "" : ".*?") + "(?:" + toNonCapturing(pattern) + ")";

        for (const exception of provider.getExceptions()) {
            add({
                priority: 2,
                action: {type: "allow"},
                condition: {regexFilter: exception, resourceTypes: DNR_ALL_TYPES, isUrlFilterCaseSensitive: false}
            }, exception);
        }

        if (provider.isCaneling() && storage.domainBlocking) {
            if (subTypes.length) {
                const condition = {resourceTypes: subTypes, isUrlFilterCaseSensitive: false};
                if (!isGlobal) condition.regexFilter = pattern;
                add({priority: 1, action: {type: "block"}, condition}, isGlobal ? null : pattern);
            }

            if (types.includes("main_frame")) {
                const regex = "^.*?(?:" + toNonCapturing(pattern) + ").*";
                add({
                    priority: 1,
                    action: {type: "redirect", redirect: {regexSubstitution: blockedPage + "?source=\\0"}},
                    condition: {regexFilter: regex, resourceTypes: ["main_frame"], isUrlFilterCaseSensitive: false}
                }, regex);
            }

            continue;
        }

        const literal = new Set();
        const regexRules = [];

        for (const rule of provider.getRules()) {
            // "(?:%3F)?name" is the common pattern for an optionally double-encoded key
            const stripped = rule.replace(/^\(\?:%3F\)\?/, "");

            if (!DNR_REGEX_META.test(stripped)) {
                literal.add(stripped);
            } else {
                regexRules.push(rule);
            }
        }

        if (literal.size) {
            const condition = {resourceTypes: types, isUrlFilterCaseSensitive: false};
            if (!isGlobal) condition.regexFilter = pattern;

            add({
                priority: 1,
                action: {type: "redirect", redirect: {transform: {queryTransform: {removeParams: Array.from(literal)}}}},
                condition
            }, isGlobal ? null : pattern);
        }

        for (const rule of regexRules) {
            // group 1: everything before the parameter; the parameter and its separator are dropped
            const regex = "^(" + patternPrefix + "[^?]*\\?(?:[^&]*&)*?)(?:" + toNonCapturing(rule) + ")(?:=[^&]*)?(?:&|$)";
            add({
                priority: 1,
                action: {type: "redirect", redirect: {regexSubstitution: "\\1"}},
                condition: {regexFilter: regex, resourceTypes: types, isUrlFilterCaseSensitive: false}
            }, regex);
        }
    }

    // Drop every rule whose regex is not supported by the browser (RE2 syntax, size limits).
    const results = await Promise.all(regexChecks.map(check =>
        Promise.resolve(browser.declarativeNetRequest.isRegexSupported({regex: check.regex, isCaseSensitive: false}))
            .catch(error => ({isSupported: false, reason: String(error)}))
    ));

    const unsupported = new Set();
    results.forEach((result, i) => {
        if (!result || !result.isSupported) {
            unsupported.add(regexChecks[i].rule.id);
            console.warn("[ClearURLs] unsupported regex skipped (" + (result && result.reason) + "): " + regexChecks[i].regex);
        }
    });

    const filtered = rules.filter(rule => !unsupported.has(rule.id));
    filtered.forEach((rule, i) => rule.id = i + 1);

    return filtered;
}

/**
 * Session storage helpers (chrome.storage.session survives service worker restarts,
 * but not a browser restart, same as session rules).
 */
async function dnrSessionGet(key) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) {
        try {
            const items = await chrome.storage.session.get(key);
            return items[key];
        } catch (e) {
            return dnrMemorySession[key];
        }
    }
    return dnrMemorySession[key];
}

async function dnrSessionSet(key, value) {
    dnrMemorySession[key] = value;
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) {
        try {
            await chrome.storage.session.set({[key]: value});
        } catch (e) {
            // ignore
        }
    }
}
