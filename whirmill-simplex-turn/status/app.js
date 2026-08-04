(function () {
  "use strict";

  const addressOutput = document.getElementById("turn-address");
  const copyButton = document.getElementById("copy");
  const revealButton = document.getElementById("reveal");
  const status = document.getElementById("status");
  const feedback = document.getElementById("feedback");
  let addresses = "";
  let revealed = false;

  function setStatus(message, state) {
    status.textContent = message;
    status.dataset.state = state;
  }

  function renderAddress() {
    addressOutput.textContent = revealed ? addresses : "Three ICE server addresses are hidden";
    addressOutput.classList.toggle("address--hidden", !revealed);
    revealButton.textContent = revealed ? "Hide" : "Reveal";
    revealButton.setAttribute("aria-pressed", String(revealed));
  }

  function showError(message) {
    addresses = "";
    revealed = false;
    addressOutput.textContent = "Address unavailable";
    addressOutput.classList.remove("address--hidden");
    copyButton.disabled = true;
    revealButton.disabled = true;
    setStatus("Setup unavailable", "error");
    feedback.textContent = message;
  }

  async function copyAddress() {
    if (!addresses) return;

    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      feedback.textContent = "Copy is unavailable in this browser. Reveal the address and copy it manually.";
      return;
    }

    try {
      await navigator.clipboard.writeText(addresses);
      feedback.textContent = "ICE server addresses copied to the clipboard.";
    } catch (_error) {
      feedback.textContent = "Could not copy automatically. Reveal the address and copy it manually.";
    }
  }

  function loadAddress() {
    const config = window.SIMPLEX_TURN_CONFIG;
    if (!config || !config.host || !config.port || !config.username || !config.password) {
      showError("The local TURN server is not fully configured.");
      return;
    }

    addresses = [
      "stun:" + config.host + ":" + config.port,
      "turn:" + config.username + ":" + config.password + "@" + config.host + ":" + config.port + "?transport=udp",
      "turn:" + config.username + ":" + config.password + "@" + config.host + ":" + config.port + "?transport=tcp"
    ].join("\n");
    copyButton.disabled = false;
    revealButton.disabled = false;
    renderAddress();
    setStatus("Ready", "ready");
    feedback.textContent = "Addresses are concealed until you choose to reveal them.";
  }

  revealButton.addEventListener("click", function () {
    if (!addresses) return;
    revealed = !revealed;
    renderAddress();
    feedback.textContent = revealed ? "Addresses visible." : "Addresses hidden.";
  });

  copyButton.addEventListener("click", copyAddress);
  loadAddress();
}());
