/**
 * Rie Context — Popup Controller
 */

document.addEventListener("DOMContentLoaded", async () => {
  // DOM Elements
  const statusPill = document.getElementById("status-pill");
  const statusLabel = document.getElementById("status-label");
  const browserBadge = document.getElementById("browser-badge");
  const queueBadge = document.getElementById("queue-badge");
  const tabTitle = document.getElementById("tab-title");
  const tabUrl = document.getElementById("tab-url");
  const trackingToggle = document.getElementById("tracking-toggle");
  const toggleSubtitle = document.getElementById("toggle-subtitle");
  const eventsCount = document.getElementById("events-count");
  const lastEventTime = document.getElementById("last-event-time");
  const lastEventPreview = document.getElementById("last-event-preview");
  const btnTest = document.getElementById("btn-test");
  const testFeedback = document.getElementById("test-feedback");
  const endpointInput = document.getElementById("endpoint-input");
  const incognitoToggle = document.getElementById("incognito-toggle");
  const btnSaveSettings = document.getElementById("btn-save-settings");
  const saveStatus = document.getElementById("save-status");

  // Format relative time helper
  function formatRelativeTime(isoString) {
    if (!isoString) return "—";
    try {
      const date = new Date(isoString);
      const diffSecs = Math.floor((Date.now() - date.getTime()) / 1000);
      if (diffSecs < 5) return "Just now";
      if (diffSecs < 60) return `${diffSecs}s ago`;
      const diffMins = Math.floor(diffSecs / 60);
      if (diffMins < 60) return `${diffMins}m ago`;
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "—";
    }
  }

  // Update Status UI
  function setStatus(status) {
    statusPill.className = `status-pill ${status}`;
    if (status === "connected") {
      statusLabel.textContent = "Connected";
    } else if (status === "disconnected") {
      statusLabel.textContent = "Offline";
    } else if (status === "paused") {
      statusLabel.textContent = "Paused";
    } else {
      statusLabel.textContent = "Checking...";
    }
  }

  // Load and populate state
  async function refreshState() {
    chrome.runtime.sendMessage({ type: "PING" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        setStatus("disconnected");
        return;
      }

      const { browser, config, currentTab, queueLength } = response;

      // Browser name
      browserBadge.textContent = `🌐 ${browser || "Browser"}`;

      // Active Tab
      if (currentTab) {
        tabTitle.textContent = currentTab.title || "Untitled Tab";
        tabUrl.textContent = currentTab.url || "";
      } else {
        tabTitle.textContent = "No active tab";
        tabUrl.textContent = "—";
      }

      // Offline queue
      if (queueLength > 0) {
        queueBadge.style.display = "inline-block";
        queueBadge.textContent = `${queueLength} buffered`;
      } else {
        queueBadge.style.display = "none";
      }

      // Toggle state
      const isPaused = config.isPaused || false;
      const rConfig = config.remoteConfig || {};
      const sensorDisabled = rConfig.workstream === false || (rConfig.sensors && rConfig.sensors.browser === false);

      trackingToggle.checked = !isPaused && !sensorDisabled;
      if (sensorDisabled) {
        toggleSubtitle.textContent = "Disabled in Rie Activity Control Center";
        setStatus("paused");
      } else {
        toggleSubtitle.textContent = isPaused ? "Tracking paused" : "Streaming active tabs to Rie";
        setStatus(isPaused ? "paused" : config.connectionStatus || "connected");
      }

      // Stats
      eventsCount.textContent = (config.eventsCount || 0).toLocaleString();

      // Last event
      if (config.lastEvent) {
        lastEventPreview.textContent = `${config.lastEvent.title || config.lastEvent.url}`;
        lastEventTime.textContent = formatRelativeTime(config.lastEvent.timestamp);
      } else {
        lastEventPreview.textContent = "No events sent yet";
        lastEventTime.textContent = "—";
      }

      // Settings
      if (endpointInput && !endpointInput.value) {
        endpointInput.value = config.endpoint || "http://localhost:14300/workstream/events";
      }
      if (incognitoToggle) {
        incognitoToggle.checked = config.ignoreIncognito !== false;
      }
    });
  }

  // Toggle Tracking switch
  trackingToggle.addEventListener("change", () => {
    chrome.runtime.sendMessage({ type: "TOGGLE_PAUSE" }, (response) => {
      if (response && response.success) {
        const isPaused = response.isPaused;
        toggleSubtitle.textContent = isPaused ? "Tracking paused" : "Streaming active tabs to Rie";
        setStatus(isPaused ? "paused" : "connected");
      }
    });
  });

  // Test Connection button
  btnTest.addEventListener("click", () => {
    btnTest.disabled = true;
    testFeedback.className = "test-feedback";
    testFeedback.textContent = "Pinging Rie backend...";

    const finish = (isSuccess, msg, status) => {
      btnTest.disabled = false;
      testFeedback.className = isSuccess ? "test-feedback success" : "test-feedback error";
      testFeedback.textContent = msg;
      setStatus(status);
    };

    // Safety timeout
    const popupTimeout = setTimeout(() => {
      finish(false, "✗ Request timed out (backend not responding on 14300)", "disconnected");
    }, 5000);

    try {
      chrome.runtime.sendMessage({ type: "TEST_CONNECTION" }, (res) => {
        clearTimeout(popupTimeout);

        if (chrome.runtime.lastError || !res) {
          // Direct fetch fallback from popup context
          const endpoint = (endpointInput.value || "").trim() || "http://localhost:14300/workstream/events";
          const statusUrl = endpoint.replace(/\/workstream\/events\/?$/, "") + "/workstream/status";

          fetch(statusUrl, { signal: AbortSignal.timeout(3000) })
            .then((r) => r.json())
            .then((data) => {
              finish(true, `✓ Connected • ${data.total_activities || 0} events in DB`, "connected");
            })
            .catch((err) => {
              finish(false, `✗ Unreachable: ${err.message || "Connection refused on localhost:14300"}`, "disconnected");
            });
          return;
        }

        if (res.success) {
          const acts = res.data?.total_activities ?? 0;
          finish(true, `✓ Connected (${res.latency}ms) • ${acts} desktop events in DB`, "connected");
        } else {
          finish(false, `✗ Unreachable: ${res.error}`, "disconnected");
        }
      });
    } catch (err) {
      clearTimeout(popupTimeout);
      finish(false, `✗ Extension error: ${err.message}`, "disconnected");
    }
  });

  // Save Settings button
  btnSaveSettings.addEventListener("click", () => {
    const newEndpoint = endpointInput.value.trim();
    const newIncognito = incognitoToggle.checked;

    if (!newEndpoint) {
      saveStatus.style.color = "var(--danger)";
      saveStatus.textContent = "Endpoint cannot be empty";
      return;
    }

    chrome.storage.local.set({
      endpoint: newEndpoint,
      ignoreIncognito: newIncognito,
    }, () => {
      saveStatus.style.color = "var(--success)";
      saveStatus.textContent = "✓ Settings saved successfully";
      setTimeout(() => {
        saveStatus.textContent = "";
      }, 2500);
      refreshState();
    });
  });

  // Listen for storage changes in real time
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local") {
      if (changes.eventsCount) {
        eventsCount.textContent = (changes.eventsCount.newValue || 0).toLocaleString();
      }
      if (changes.lastEvent && changes.lastEvent.newValue) {
        lastEventPreview.textContent = `${changes.lastEvent.newValue.title || changes.lastEvent.newValue.url}`;
        lastEventTime.textContent = formatRelativeTime(changes.lastEvent.newValue.timestamp);
      }
      if (changes.connectionStatus) {
        setStatus(changes.connectionStatus.newValue);
      }
    }
  });

  // Initial load
  await refreshState();
});
