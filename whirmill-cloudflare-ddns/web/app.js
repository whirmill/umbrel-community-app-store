(function () {
  "use strict";

  const REQUEST_HEADER = { "X-Requested-With": "cloudflare-ddns" };
  const DEFAULT_ZONES = ["satssurge.com"];
  const DEFAULT_RECORDS = ["smp.satssurge.com", "xftp.satssurge.com", "turn.satssurge.com"];
  const DEFAULT_INTERVAL = 300;
  const REFRESH_INTERVAL_MS = 30000;

  const form = document.getElementById("config-form");
  const zonesInput = document.getElementById("zones");
  const recordsInput = document.getElementById("records");
  const intervalInput = document.getElementById("interval");
  const saveButton = document.getElementById("save-button");
  const runButton = document.getElementById("run-button");
  const refreshButton = document.getElementById("refresh-button");
  const removeButton = document.getElementById("remove-button");
  const removeConfirmation = document.getElementById("remove-confirmation");
  const confirmRemoveButton = document.getElementById("confirm-remove-button");
  const cancelRemoveButton = document.getElementById("cancel-remove-button");
  const serviceStatus = document.getElementById("service-status");
  const stateDot = document.getElementById("state-dot");
  const savedIndicator = document.getElementById("saved-indicator");
  const formFeedback = document.getElementById("form-feedback");
  const tokenStatus = document.getElementById("token-status");
  const currentIp = document.getElementById("current-ip");
  const lastAttempt = document.getElementById("last-attempt");
  const lastSuccess = document.getElementById("last-success");
  const lastResult = document.getElementById("last-result");

  let statusRequest = null;
  let latestStatusRequest = 0;
  let actionInProgress = false;
  let hasHydratedConfiguration = false;
  let formIsDirty = false;

  function setText(element, value) {
    element.textContent = value || "—";
  }

  function setServiceStatus(message, state) {
    serviceStatus.textContent = message;
    serviceStatus.dataset.state = state;
    stateDot.dataset.state = state;
  }

  function setFeedback(message, state) {
    formFeedback.textContent = message;
    formFeedback.dataset.state = state || "idle";
  }

  function setBusy(isBusy, actionLabel) {
    actionInProgress = isBusy;
    saveButton.disabled = isBusy || saveButton.dataset.tokenConfigured !== "true";
    runButton.disabled = isBusy || runButton.dataset.configured !== "true";
    refreshButton.disabled = isBusy;
    removeButton.disabled = isBusy || removeButton.dataset.configured !== "true";
    confirmRemoveButton.disabled = isBusy;
    cancelRemoveButton.disabled = isBusy;
    if (isBusy && actionLabel) {
      setFeedback(actionLabel, "loading");
    }
  }

  function parseRecords(value) {
    const records = value
      .split(/[\n,]/)
      .map(function (record) { return record.trim().toLowerCase().replace(/\.$/, ""); })
      .filter(Boolean);
    const uniqueRecords = Array.from(new Set(records));
    const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

    if (!uniqueRecords.length) {
      return { error: "Add at least one DNS record to manage." };
    }
    if (uniqueRecords.some(function (record) { return !hostnamePattern.test(record); })) {
      return { error: "Each record must be a fully qualified domain name." };
    }
    return { records: uniqueRecords };
  }

  function parseZones(value) {
    const zones = value
      .split(/[\n,]/)
      .map(function (zone) { return zone.trim().toLowerCase().replace(/\.$/, ""); })
      .filter(Boolean);
    const uniqueZones = Array.from(new Set(zones));
    const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

    if (!uniqueZones.length) {
      return { error: "Add at least one Cloudflare zone." };
    }
    if (uniqueZones.length > 20) {
      return { error: "Configure no more than 20 Cloudflare zones." };
    }
    if (uniqueZones.some(function (zone) { return !hostnamePattern.test(zone); })) {
      return { error: "Each zone must be a valid DNS name." };
    }
    return { zones: uniqueZones };
  }

  function validateForm() {
    const interval = Number(intervalInput.value);
    const parsedZones = parseZones(zonesInput.value);
    const parsedRecords = parseRecords(recordsInput.value);

    if (parsedZones.error) {
      return { field: zonesInput, error: parsedZones.error };
    }
    if (!Number.isInteger(interval) || interval < 60 || interval > 86400) {
      return { field: intervalInput, error: "Choose an interval from 60 seconds to 24 hours." };
    }
    if (parsedRecords.error) {
      return { field: recordsInput, error: parsedRecords.error };
    }
    if (parsedRecords.records.length > 100) {
      return { field: recordsInput, error: "Configure no more than 100 DNS records." };
    }
    if (parsedRecords.records.some(function (record) {
      return !parsedZones.zones.some(function (zone) {
        return record === zone || record.endsWith("." + zone);
      });
    })) {
      return { field: recordsInput, error: "Every managed record must belong to one of the configured zones." };
    }

    return {
      data: {
        zones: parsedZones.zones,
        records: parsedRecords.records,
        interval_seconds: interval
      }
    };
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  function displayResult(status) {
    if (status.error) return status.error;
    if (status.last_result) return status.last_result;
    return status.configured ? "No update has run yet" : "Waiting for configuration";
  }

  function updateConfiguredControls(configured, tokenConfigured) {
    saveButton.dataset.tokenConfigured = String(tokenConfigured);
    saveButton.disabled = actionInProgress || !tokenConfigured;
    runButton.dataset.configured = String(configured);
    runButton.disabled = actionInProgress || !configured;
    removeButton.dataset.configured = String(configured || tokenConfigured);
    removeButton.disabled = actionInProgress || (!configured && !tokenConfigured);
    if (!configured && !tokenConfigured) closeRemovalConfirmation();
  }

  function closeRemovalConfirmation() {
    removeConfirmation.hidden = true;
    removeButton.setAttribute("aria-expanded", "false");
  }

  function applyStatus(status, hydrateForm) {
    const configured = Boolean(status && status.configured);
    const tokenConfigured = Boolean(status && status.token_configured);
    const running = Boolean(status && status.running);
    const statusMessage = !tokenConfigured
      ? "SSH token required"
      : !configured
      ? "Needs configuration"
      : running
        ? "Update in progress"
        : status.error
          ? "Action needed"
          : "Monitoring";
    const statusState = !tokenConfigured || !configured ? "idle" : running ? "loading" : status.error ? "error" : "ready";

    setServiceStatus(statusMessage, statusState);
    setText(currentIp, status.current_ip);
    setText(lastAttempt, formatDate(status.last_attempt));
    setText(lastSuccess, formatDate(status.last_success));
    setText(lastResult, displayResult(status));
    tokenStatus.textContent = tokenConfigured ? "Token installed" : "Token missing";
    tokenStatus.dataset.state = tokenConfigured ? "ready" : "error";
    updateConfiguredControls(configured, tokenConfigured);

    if (configured && hydrateForm && !formIsDirty) {
      zonesInput.value = Array.isArray(status.zones) && status.zones.length
        ? status.zones.join("\n")
        : status.zone || DEFAULT_ZONES.join("\n");
      recordsInput.value = Array.isArray(status.records) && status.records.length ? status.records.join("\n") : DEFAULT_RECORDS.join("\n");
      intervalInput.value = String(status.interval_seconds || DEFAULT_INTERVAL);
      hasHydratedConfiguration = true;
      savedIndicator.textContent = "Saved settings loaded";
    } else if (!configured && !hasHydratedConfiguration) {
      zonesInput.value = DEFAULT_ZONES.join("\n");
      recordsInput.value = DEFAULT_RECORDS.join("\n");
      intervalInput.value = String(DEFAULT_INTERVAL);
    }
  }

  async function readJson(response) {
    const body = await response.text();
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch (_error) {
      return { error: "The app returned an unexpected response." };
    }
  }

  function apiError(response, payload, fallback) {
    if (payload && payload.error) return payload.error;
    return fallback + " (HTTP " + response.status + ").";
  }

  async function loadStatus(options) {
    const settings = options || {};
    const requestId = latestStatusRequest + 1;
    latestStatusRequest = requestId;

    if (statusRequest) statusRequest.abort();
    statusRequest = new AbortController();
    if (!settings.quiet) setServiceStatus("Checking configuration…", "loading");

    try {
      const response = await fetch("/api/status", { signal: statusRequest.signal, headers: { Accept: "application/json" } });
      const payload = await readJson(response);
      if (requestId !== latestStatusRequest) return;
      if (!response.ok) throw new Error(apiError(response, payload, "Could not load the service status"));
      applyStatus(payload, !hasHydratedConfiguration);
    } catch (error) {
      if (error.name === "AbortError" || requestId !== latestStatusRequest) return;
      setServiceStatus("Status unavailable", "error");
      setText(lastResult, "Could not reach the local DDNS service.");
      if (!settings.quiet) setFeedback("Could not refresh status. Check that the app is running, then try again.", "error");
    }
  }

  async function saveConfiguration(event) {
    event.preventDefault();
    if (actionInProgress) return;
    const validation = validateForm();
    if (validation.error) {
      setFeedback(validation.error, "error");
      validation.field.focus();
      return;
    }

    setBusy(true, "Saving configuration…");
    try {
      const response = await fetch("/api/config", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json" }, REQUEST_HEADER),
        body: JSON.stringify(validation.data)
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiError(response, payload, "Could not save the configuration"));

      formIsDirty = false;
      hasHydratedConfiguration = true;
      savedIndicator.textContent = "Configuration saved";
      setFeedback("Configuration saved. The SSH-installed token was verified without entering it in this browser.", "success");
      await loadStatus({ quiet: true });
    } catch (error) {
      setFeedback(error.message || "Could not save the configuration.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function runUpdate() {
    if (actionInProgress) return;
    setBusy(true, "Starting an update…");
    try {
      const response = await fetch("/api/run", { method: "POST", headers: Object.assign({ Accept: "application/json" }, REQUEST_HEADER) });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiError(response, payload, "Could not start the update"));
      setFeedback("Update started. Refreshing its status…", "success");
      await loadStatus({ quiet: true });
    } catch (error) {
      setFeedback(error.message || "Could not start the update.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function removeConfiguration() {
    if (actionInProgress) return;
    setBusy(true, "Removing the saved configuration…");
    try {
      const response = await fetch("/api/config", { method: "DELETE", headers: Object.assign({ Accept: "application/json" }, REQUEST_HEADER) });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(apiError(response, payload, "Could not remove the configuration"));
      formIsDirty = false;
      hasHydratedConfiguration = false;
      savedIndicator.textContent = "Configuration removed";
      closeRemovalConfirmation();
      setFeedback("Saved token and settings removed. DNS records were left unchanged.", "success");
      await loadStatus({ quiet: true });
    } catch (error) {
      setFeedback(error.message || "Could not remove the configuration.", "error");
    } finally {
      setBusy(false);
    }
  }

  function markFormDirty() {
    formIsDirty = true;
    savedIndicator.textContent = "Unsaved changes";
  }

  form.addEventListener("submit", saveConfiguration);
  runButton.addEventListener("click", runUpdate);
  refreshButton.addEventListener("click", function () { loadStatus(); });
  removeButton.addEventListener("click", function () {
    removeConfirmation.hidden = false;
    removeButton.setAttribute("aria-expanded", "true");
    confirmRemoveButton.focus();
  });
  confirmRemoveButton.addEventListener("click", removeConfiguration);
  cancelRemoveButton.addEventListener("click", function () {
    closeRemovalConfirmation();
    removeButton.focus();
  });
  [zonesInput, recordsInput, intervalInput].forEach(function (input) {
    input.addEventListener("input", markFormDirty);
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !actionInProgress) loadStatus({ quiet: true });
  });
  window.setInterval(function () {
    if (!document.hidden && !actionInProgress) loadStatus({ quiet: true });
  }, REFRESH_INTERVAL_MS);

  loadStatus();
}());
