# Contributing

Thanks for taking an interest. This is a small, dependency-free Chrome extension, so getting from a clone to a running copy takes about a minute.

## Ways to help

- **Report a video that's flagged wrongly** (or not flagged when YouTube clearly labels it). Include the video URL — that's the single most useful thing in a bug report, because it lets anyone reproduce the lookup.
- **Fix a broken selector.** YouTube changes its markup regularly, and that's the most common way this extension breaks. See [When YouTube changes its markup](#when-youtube-changes-its-markup).
- **Improve the options page or the docs.**

If you're planning something larger than a fix, open an issue first so we don't duplicate work.

## Getting set up

There is no build step, no bundler, no package manager and no dependencies. The files you edit are the files the browser runs.

1. Fork and clone the repo.
2. Open `chrome://extensions` in Chrome, Edge, Brave or another Chromium browser.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the repo folder.
5. Open YouTube.

Your edit loop after that:

1. Save your change.
2. Click the reload icon on the extension's card in `chrome://extensions`.
3. Refresh the YouTube tab.

Step 2 is easy to forget, and skipping it means you're testing the old code.

## How the extension is put together

Four files matter:

| File | Role |
|---|---|
| [`settings.js`](settings.js) | Settings defaults and the loader. Runs before `content.js` and shares its scope. |
| [`content.js`](content.js) | Everything that happens on youtube.com. |
| [`options.js`](options.js) | Reads and writes the settings form. |
| [`manifest.json`](manifest.json) | Manifest V3 declaration: permissions, content scripts, icons. |

`content.js` is ~480 lines split into commented sections, and it's worth reading in this order:

- **Label lookup** ([content.js:39-151](content.js#L39-L151)) — asks YouTube's own `/youtubei/v1/next` endpoint for a video's data and parses out the "How this was made" label. `parseAiLabel` ([content.js:57](content.js#L57)) does the matching, at most `MAX_CONCURRENT_LOOKUPS` (3) run at once, and results are cached in `chrome.storage.local` for `LABEL_CACHE_TTL_MS` (7 days).
- **Feed cards** ([content.js:153-297](content.js#L153-L297)) — finds video cards, works out each card's video ID, and flags it. Lookups don't start until a card nears the viewport, via the `IntersectionObserver` at [content.js:229](content.js#L229).
- **Watch page** ([content.js:298-373](content.js#L298-L373)) — the banner under the player.
- **UI** ([content.js:374-428](content.js#L374-L428)) — the toast and the injected stylesheet.
- **Lifecycle** ([content.js:430-484](content.js#L430-L484)) — `start()` sets up a `MutationObserver` plus a listener for YouTube's own `yt-navigate-finish` event, since YouTube is a single-page app and normal page loads don't happen during navigation.

Two details that surprise people:

- **YouTube recycles card elements.** The same DOM node gets reused for a different video as you scroll, which is why `processCard` ([content.js:252](content.js#L252)) re-checks when `aiFlaggerVideoId` changes, and why `checkCardLabel` re-verifies the ID after its `await`.
- **The lookup asks for English** (`hl=en`) on purpose, so the header text stays `"Made with AI"` regardless of the user's YouTube language. Don't remove that.

## Testing a change

There are no automated tests; the extension is entirely dependent on live YouTube markup, so testing is manual. Before opening a PR, check your change on each surface it could affect:

- **Home feed** — scroll far enough to trigger lazy-loaded cards.
- **Search results**
- **Watch page** — both the banner and the sidebar cards.
- **A channel page**
- **In-app navigation** — click from the home feed into a video and back, rather than reloading. This is where SPA bugs show up.

Useful while debugging:

- The extension logs to the page console with a `[YT AI Flagger]` prefix.
- To force fresh lookups, clear the cache by running this in the YouTube tab's console: `chrome.storage.local.clear()`.
- Flagged cards carry a `data-ai-flagger-flagged` attribute (`label` or `channel`/`keyword`), which makes it easy to inspect what matched and why.

A known-good test video helps: find one whose description shows **How this was made → Made with AI**, and keep the URL handy.

## When YouTube changes its markup

If flags stop appearing, the cause is usually one of three lists in `content.js`:

- `CARD_SELECTORS` ([content.js:160-166](content.js#L160-L166)) — the card elements themselves.
- The title and channel selectors in `getCardTitleAndChannel` ([content.js:169](content.js#L169)).
- The thumbnail selector in `flagCard` ([content.js:210](content.js#L210)), which is where the badge is attached.

When you fix one of these, **add** the new selector rather than replacing the old one where it's reasonable to — YouTube rolls changes out gradually, so both forms are often live at the same time for different users.

## Code style

Match what's there rather than introducing new conventions:

- Plain JavaScript, no frameworks, no dependencies, no build step. Please don't add any.
- Two-space indent, double-quoted strings, semicolons.
- British spelling in identifiers and user-facing text (`FLAG_COLOUR`, "capitalisation").
- Comments explain **why**, not what. The existing comments are a good guide: they mostly document YouTube quirks that aren't obvious from the code.

## Scope and hard constraints

Some things are deliberate design decisions, not gaps waiting to be filled. A PR that changes one of these will likely be declined unless it's been discussed first:

- **It flags, it doesn't hide or block.** Adding a hide/block mode changes what the extension is.
- **A video is flagged only when YouTube itself says "Made with AI."** Guessing at AI content by other signals is out of scope, and so is treating related labels like "Auto-dubbed" as AI.
- **Requests go only to `www.youtube.com`**, and label lookups are sent without cookies so they aren't tied to the user's account and don't affect their recommendations. No third-party services, no analytics, no telemetry.
- **Nothing is collected.** The only stored data is the user's settings and the label cache, both local to the browser.

Anything that widens `host_permissions` or adds a permission to [`manifest.json`](manifest.json) needs a clear justification in the PR, because it also affects the Chrome Web Store review.

## Opening a pull request

1. Branch off `main`.
2. Keep the change focused — one fix or feature per PR.
3. In the description, say **which YouTube surfaces you tested** (see above) and include a screenshot for anything visual.
4. Don't bump the `version` in [`manifest.json`](manifest.json); that's handled at release time.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
