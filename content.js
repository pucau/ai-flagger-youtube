// YouTube AI Flagger - content script
// Strategy: flag a video only when YouTube itself says it was made with AI.
// YouTube shows this in the video's "How this was made" section, whose body
// header reads "Made with AI" (sometimes with an attribution such as
// "Info from OpenAI"). The same section is also used for non-AI notices like
// "Auto-dubbed", so the heading alone is not a signal, and neither is
// YouTube's broader "altered or synthetic" wording.
//
// Feed cards (home, search, sidebar) don't carry this label, so each card's
// label is fetched from YouTube's own /youtubei/v1/next endpoint (the data
// behind the watch page) once the card is near the viewport. Results are
// cached in chrome.storage.local. Requesting with hl=en keeps the header
// text in English whatever the user's YouTube language is.
//
// Behaviour: this does NOT hide or block anything. It flags matching videos
// with a coloured border and a badge on the thumbnail, and shows a brief
// toast notification when new flagged videos appear on the page.

const STYLE_ID = "yt-ai-flagger-style";
const BANNER_ID = "yt-ai-flagger-banner";
const FLAG_COLOUR = "#e8710a"; // amber/orange, distinct from YouTube's own red

const AI_HEADER_TEXT = "made with ai";
const FALLBACK_CLIENT_VERSION = "2.20260911.08.00";
const MAX_CONCURRENT_LOOKUPS = 3;
const LABEL_CACHE_PREFIX = "aiLabel:";
const LABEL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// DEFAULT_SETTINGS and getSettings come from settings.js, loaded first.
let settings = { ...DEFAULT_SETTINGS };

function loadSettings(callback) {
  getSettings((stored) => {
    settings = stored;
    callback();
  });
}

// ---------------------------------------------------------------------------
// Label lookup
// ---------------------------------------------------------------------------

let clientVersion = null;

// The isolated content-script world can't read window.ytcfg, so take the
// client version from YouTube's inline config script instead.
function getClientVersion() {
  if (clientVersion) return clientVersion;
  for (const script of document.querySelectorAll("script:not([src])")) {
    const match = script.textContent.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
    if (match) return (clientVersion = match[1]);
  }
  return FALLBACK_CLIENT_VERSION;
}

// Extracts { ai, attribution } from a /youtubei/v1/next response body.
function parseAiLabel(responseText) {
  const start = responseText.indexOf('"howThisWasMadeSectionViewModel":{');
  if (start < 0) return { ai: false, attribution: "" };
  const section = responseText.slice(start, start + 4000);
  const header = (section.match(/"bodyHeader":\{"content":"([^"]*)"/) || [])[1] || "";
  const attribution = (section.match(/"attributionText":\{"content":"([^"]*)"/) || [])[1] || "";
  return { ai: header.trim().toLowerCase() === AI_HEADER_TEXT, attribution };
}

async function fetchAiLabel(videoId) {
  const response = await fetch("/youtubei/v1/next?prettyPrint=false", {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: "WEB", clientVersion: getClientVersion(), hl: "en" } }
    })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseAiLabel(await response.text());
}

// Caps parallel requests so a long feed doesn't fire dozens at once.
let activeLookups = 0;
const lookupQueue = [];

function queueLookup(task) {
  return new Promise((resolve, reject) => {
    lookupQueue.push({ task, resolve, reject });
    drainLookupQueue();
  });
}

function drainLookupQueue() {
  while (activeLookups < MAX_CONCURRENT_LOOKUPS && lookupQueue.length > 0) {
    const { task, resolve, reject } = lookupQueue.shift();
    activeLookups += 1;
    task()
      .then(resolve, reject)
      .finally(() => {
        activeLookups -= 1;
        drainLookupQueue();
      });
  }
}

function readCachedLabel(videoId) {
  const key = LABEL_CACHE_PREFIX + videoId;
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (items) => {
      const entry = items[key];
      const fresh = entry && Date.now() - entry.checkedAt < LABEL_CACHE_TTL_MS;
      resolve(fresh ? { ai: entry.ai, attribution: entry.attribution } : null);
    });
  });
}

function writeCachedLabel(videoId, label) {
  chrome.storage.local.set({ [LABEL_CACHE_PREFIX + videoId]: { ...label, checkedAt: Date.now() } });
}

function pruneLabelCache() {
  chrome.storage.local.get(null, (items) => {
    const expired = Object.keys(items).filter(
      (key) => key.startsWith(LABEL_CACHE_PREFIX) && Date.now() - items[key].checkedAt >= LABEL_CACHE_TTL_MS
    );
    if (expired.length > 0) chrome.storage.local.remove(expired);
  });
}

// One lookup per video per page session; resolves to { ai, attribution },
// or null if the lookup failed (not cached, so it is retried next time).
const labelLookups = new Map();

function getAiLabel(videoId) {
  if (!labelLookups.has(videoId)) {
    const lookup = readCachedLabel(videoId)
      .then(
        (cached) =>
          cached ||
          queueLookup(() => fetchAiLabel(videoId)).then((label) => {
            writeCachedLabel(videoId, label);
            return label;
          })
      )
      .catch((error) => {
        console.warn("[YT AI Flagger] label lookup failed for", videoId, error);
        labelLookups.delete(videoId);
        return null;
      });
    labelLookups.set(videoId, lookup);
  }
  return labelLookups.get(videoId);
}

// ---------------------------------------------------------------------------
// Feed cards
// ---------------------------------------------------------------------------

// Covers home, search, sidebar and channel pages. yt-lockup-view-model is
// YouTube's newer card, used on its own in the watch page sidebar and nested
// inside ytd-rich-item-renderer on the home page.
const CARD_SELECTORS = [
  "ytd-video-renderer",
  "ytd-rich-item-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "yt-lockup-view-model"
];
const OUTER_CARD_SELECTOR = CARD_SELECTORS.filter((s) => s !== "yt-lockup-view-model").join(", ");

function getCardTitleAndChannel(card) {
  const titleEl = card.querySelector("#video-title, a#video-title-link, a.ytLockupMetadataViewModelTitle");
  const channelEl = card.querySelector(
    "ytd-channel-name a, #channel-name a, .ytd-channel-name, .ytContentMetadataViewModelMetadataText"
  );
  return {
    title: titleEl ? titleEl.textContent.trim() : "",
    channel: channelEl ? channelEl.textContent.trim() : ""
  };
}

// Returns the card's video ID, or "" for non-video cards (playlists, mixes,
// channels) and cards whose link hasn't rendered yet.
function getCardVideoId(card) {
  const link = card.querySelector('a[href^="/watch?"], a[href^="/shorts/"]');
  if (!link) return "";
  const url = new URL(link.getAttribute("href"), location.origin);
  if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
  if (url.searchParams.has("list")) return "";
  return url.searchParams.get("v") || "";
}

function listMatchReason(card) {
  if (!settings.enabled) return null;

  const { title, channel } = getCardTitleAndChannel(card);

  if (settings.flaggedChannels.some((c) => channel.toLowerCase() === c.toLowerCase())) {
    return "channel";
  }
  if (settings.flaggedKeywords.some((k) => title.toLowerCase().includes(k.toLowerCase()))) {
    return "keyword";
  }
  return null;
}

function flagCard(card, reason) {
  card.style.outline = `3px solid ${FLAG_COLOUR}`;
  card.style.outlineOffset = "2px";
  card.dataset.aiFlaggerFlagged = reason;

  const thumb = card.querySelector("#thumbnail, ytd-thumbnail, a.ytLockupViewModelContentImage");
  if (thumb && !thumb.querySelector(".yt-ai-flagger-badge")) {
    const badge = document.createElement("div");
    badge.className = "yt-ai-flagger-badge";
    badge.textContent = reason === "label" ? "MADE WITH AI" : "YOUR LIST";
    thumb.style.position = thumb.style.position || "relative";
    thumb.appendChild(badge);
  }
}

function unflagCard(card) {
  visibilityObserver.unobserve(card);
  card.style.outline = "";
  card.style.outlineOffset = "";
  delete card.dataset.aiFlaggerFlagged;
  card.querySelectorAll(".yt-ai-flagger-badge").forEach((el) => el.remove());
}

// Label lookups start only once a card is close to the viewport.
const visibilityObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      visibilityObserver.unobserve(entry.target);
      checkCardLabel(entry.target);
    }
  },
  { rootMargin: "300px" }
);

async function checkCardLabel(card) {
  const videoId = card.dataset.aiFlaggerVideoId;
  if (!videoId) return;
  const label = await getAiLabel(videoId);
  // The card may have been recycled for another video, or flags cleared,
  // while the lookup was in flight.
  if (!label || !label.ai || card.dataset.aiFlaggerVideoId !== videoId) return;
  if (!settings.enabled || !settings.flagLabelled || card.dataset.aiFlaggerFlagged) return;
  flagCard(card, "label");
  noteNewlyFlagged();
}

function processCard(card) {
  const videoId = getCardVideoId(card);
  // YouTube reuses card elements for different videos, so re-check whenever
  // the video behind the card changes.
  if (card.dataset.aiFlaggerChecked === "1" && card.dataset.aiFlaggerVideoId === videoId) return;

  unflagCard(card);
  card.dataset.aiFlaggerChecked = "1";
  card.dataset.aiFlaggerVideoId = videoId;

  const reason = listMatchReason(card);
  if (reason) {
    flagCard(card, reason);
    noteNewlyFlagged();
  } else if (settings.enabled && settings.flagLabelled && videoId) {
    visibilityObserver.observe(card);
  }
}

function processFeedCards(root = document) {
  CARD_SELECTORS.forEach((selector) => {
    root.querySelectorAll(selector).forEach((card) => {
      // A lockup nested in an outer card is handled through the outer card.
      if (selector === "yt-lockup-view-model" && card.parentElement?.closest(OUTER_CARD_SELECTOR)) return;
      processCard(card);
    });
  });
}

// Batches flags that arrive from separate lookups into a single toast.
let newlyFlaggedCount = 0;
let flaggedToastTimer = null;

function noteNewlyFlagged() {
  newlyFlaggedCount += 1;
  clearTimeout(flaggedToastTimer);
  flaggedToastTimer = setTimeout(() => {
    showToast(
      newlyFlaggedCount === 1
        ? "1 flagged video found on this page"
        : `${newlyFlaggedCount} flagged videos found on this page`
    );
    newlyFlaggedCount = 0;
  }, 800);
}

// ---------------------------------------------------------------------------
// Watch page
// ---------------------------------------------------------------------------

// label: undefined while the lookup is in flight.
let watchLabelState = { videoId: null, label: undefined };

function getWatchVideoId() {
  return location.pathname === "/watch" ? new URLSearchParams(location.search).get("v") : null;
}

function checkWatchPageLabel() {
  const videoId = getWatchVideoId();
  const active = settings.enabled && settings.flagLabelled && Boolean(videoId);

  const banner = document.getElementById(BANNER_ID);
  if (banner && (!active || banner.dataset.videoId !== videoId)) banner.remove();
  if (!active) return;

  if (watchLabelState.videoId !== videoId) {
    watchLabelState = { videoId, label: undefined };
    getAiLabel(videoId).then((label) => {
      if (watchLabelState.videoId !== videoId) return;
      watchLabelState.label = label;
      if (label && label.ai) {
        console.log("[YT AI Flagger] YouTube labels this video Made with AI", label);
        showToast("YouTube labels this video as made with AI");
      }
      checkWatchPageLabel();
    });
    return;
  }

  // Re-added on later passes if YouTube re-renders the page and drops it.
  const { label } = watchLabelState;
  if (label && label.ai && !document.getElementById(BANNER_ID)) {
    showWatchPageBanner(videoId, label);
  }
}

function showWatchPageBanner(videoId, { attribution }) {
  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.dataset.videoId = videoId;
  banner.textContent =
    "YouTube labels this video as made with AI" + (attribution ? ` (${attribution}).` : ".");
  banner.style.cssText = `background:${FLAG_COLOUR};color:#fff;padding:8px 12px;font:14px/1.4 Roboto,Arial,sans-serif;border-radius:4px;margin:8px 0;position:relative;z-index:100;`;

  const anchor =
    document.querySelector("#player") ||
    document.querySelector("ytd-watch-metadata") ||
    document.querySelector("#below") ||
    document.querySelector("#primary");

  if (anchor) {
    anchor.insertAdjacentElement("afterend", banner);
  } else {
    // Last resort: floating card below YouTube's masthead, not a full-width
    // bar pinned to the very top, so it can't collide with the header.
    banner.style.cssText = `
      background:${FLAG_COLOUR};color:#fff;padding:10px 16px;
      font:14px/1.4 Roboto,Arial,sans-serif;border-radius:8px;
      position:fixed;top:76px;left:50%;transform:translateX(-50%);
      z-index:2100;max-width:90vw;box-shadow:0 4px 12px rgba(0,0,0,0.4);
      display:flex;align-items:center;gap:10px;
    `;
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.style.cssText =
      "background:none;border:none;color:#fff;font-size:18px;line-height:1;cursor:pointer;padding:0;";
    closeBtn.addEventListener("click", () => banner.remove());
    banner.appendChild(closeBtn);
    document.body.appendChild(banner);
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

// Toast: small, auto-dismissing, non-blocking notification in the corner.
let toastTimer = null;
function showToast(message) {
  let toast = document.getElementById("yt-ai-flagger-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "yt-ai-flagger-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.opacity = "0";
  }, 3500);
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .yt-ai-flagger-badge {
      position: absolute;
      top: 4px;
      left: 4px;
      background: ${FLAG_COLOUR};
      color: #fff;
      font: bold 10px/1.4 Roboto, Arial, sans-serif;
      padding: 2px 6px;
      border-radius: 3px;
      z-index: 10;
      pointer-events: none;
    }
    #yt-ai-flagger-toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #212121;
      color: #fff;
      padding: 10px 16px;
      border-radius: 6px;
      font: 13px/1.4 Roboto, Arial, sans-serif;
      z-index: 99999;
      opacity: 0;
      transition: opacity 0.3s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function clearAllFlags() {
  document.querySelectorAll("[data-ai-flagger-checked]").forEach((card) => {
    unflagCard(card);
    delete card.dataset.aiFlaggerChecked;
    delete card.dataset.aiFlaggerVideoId;
  });
  document.querySelectorAll(".yt-ai-flagger-badge").forEach((el) => el.remove());
}

// watchLabelState is kept: checkWatchPageLabel starts a new lookup when the
// video changes, and keeping it avoids a repeat toast for the same video
// (yt-navigate-finish also fires on the initial page load).
function resetPage() {
  clearAllFlags();
  const banner = document.getElementById(BANNER_ID);
  if (banner) banner.remove();
  runPass();
}

function runPass() {
  processFeedCards();
  checkWatchPageLabel();
}

function start() {
  console.log("[YT AI Flagger] content script loaded on", location.href);
  injectStyle();
  pruneLabelCache();
  loadSettings(() => {
    console.log("[YT AI Flagger] settings loaded:", settings);
    runPass();

    const observer = new MutationObserver(() => {
      runPass();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // YouTube is a SPA; listen for its own navigation event so both the
    // feed scan and the watch page check re-run on in-app navigation.
    document.addEventListener("yt-navigate-finish", resetPage);
  });
}

// Settings live in storage.sync; storage.local only holds the label cache,
// whose writes must not reset the page.
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== "sync") return;
  loadSettings(resetPage);
});

start();
