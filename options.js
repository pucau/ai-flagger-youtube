function load() {
  getSettings((stored) => {
    document.getElementById("enabled").checked = stored.enabled;
    document.getElementById("flagLabelled").checked = stored.flagLabelled;
    document.getElementById("channels").value = stored.flaggedChannels.join("\n");
    document.getElementById("keywords").value = stored.flaggedKeywords.join("\n");
  });
}

function save() {
  const enabled = document.getElementById("enabled").checked;
  const flagLabelled = document.getElementById("flagLabelled").checked;
  const flaggedChannels = document
    .getElementById("channels")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const flaggedKeywords = document
    .getElementById("keywords")
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  chrome.storage.sync.set(
    { enabled, flagLabelled, flaggedChannels, flaggedKeywords },
    () => {
      const status = document.getElementById("status");
      status.textContent = "Saved.";
      setTimeout(() => (status.textContent = ""), 1500);
    }
  );
}

document.addEventListener("DOMContentLoaded", load);
document.getElementById("save").addEventListener("click", save);
