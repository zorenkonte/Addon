# Manifest V3 (Chrome) notes

`manifest.json` is Manifest V3 for Chrome / Chromium. `manifest.firefox.json` is the
original Manifest V2 manifest for Firefox (copy it over `manifest.json` to build for Firefox).

Load in Chrome: `chrome://extensions` -> enable "Developer mode" -> "Load unpacked" -> select this folder.

## How cleaning works in Chrome

Chrome MV3 has no blocking `webRequest`, so the work is split:

| Piece | File | Job |
|---|---|---|
| Service worker entry | `background.js` | `importScripts` of the former background scripts |
| declarativeNetRequest rules | `core_js/dnr.js` | Built from the providers on every rule update / setting change. Literal parameter names become `removeParams` rules, regex rules become `regexSubstitution` rules, exceptions become `allow` rules, `completeProvider` becomes `block` rules, plus ping blocking, ETag removal and local host skipping. Works for every request type, no page flicker. |
| Navigation handler | `core_js/navigationHandler.js` | `webNavigation.onBeforeNavigate` runs the full JavaScript engine (redirections, rawRules, hash parameters) on top-level navigations and updates the tab. Non-blocking `webRequest` listeners feed the statistics, the badge and the log. |
| Storage readiness | `core_js/storage.js` | `ready` promise; every event handler awaits it because the worker restarts often. |
| Timers | `core_js/watchdog.js` | `alarms` API instead of `setInterval` (watchdog every minute, rule update check every hour). |
| Script injection | `core_js/tools.js` (`injectFunction`) | `scripting.executeScript` in MV3, `tabs.executeScript` in MV2. |

Known limitations in Chrome:

- Rule updates are checked at most once per hour (`lastRuleCheck`), not on every worker start.
- Redirections (`redirections` in the rule set), `rawRules` and `#hash` parameters are only cleaned for top-level navigations.
- Parameter rules in the DNR layer are matched case-sensitively; the navigation handler stays case-insensitive.
- ETag filtering removes the header instead of replacing it with a random value.
- Each regex rule removes one parameter per internal redirect; a URL with many regex-matched parameters needs several internal redirects.
