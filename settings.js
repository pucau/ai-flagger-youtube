// Shared settings loader for the content script and the options page.
// Earlier versions stored the user's lists as blockedChannels/blockedKeywords;
// those are moved to flaggedChannels/flaggedKeywords the first time settings
// are read, so existing lists survive the rename.

const DEFAULT_SETTINGS = {
  enabled: true,
  flagLabelled: true,
  flaggedChannels: [],
  flaggedKeywords: []
};

const LEGACY_KEYS = {
  blockedChannels: "flaggedChannels",
  blockedKeywords: "flaggedKeywords"
};

function getSettings(callback) {
  chrome.storage.sync.get(null, (stored) => {
    const migrated = {};
    const legacyFound = [];

    for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
      if (!(oldKey in stored)) continue;
      legacyFound.push(oldKey);
      if (stored[newKey] === undefined) migrated[newKey] = stored[oldKey];
      delete stored[oldKey];
    }

    if (legacyFound.length > 0) {
      chrome.storage.sync.set(migrated, () => chrome.storage.sync.remove(legacyFound));
    }

    callback({ ...DEFAULT_SETTINGS, ...stored, ...migrated });
  });
}
