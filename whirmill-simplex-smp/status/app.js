(function () {
  "use strict";

  const addressOutput = document.getElementById("relay-address");
  const copyButton = document.getElementById("copy");
  const revealButton = document.getElementById("reveal");
  const status = document.getElementById("status");
  const feedback = document.getElementById("feedback");
  let address = "";
  let revealed = false;

  function setStatus(message, state) {
    status.textContent = message;
    status.dataset.state = state;
  }

  function renderAddress() {
    addressOutput.textContent = revealed ? address : "••••••••••••••••••••";
    addressOutput.classList.toggle("address--hidden", !revealed);
    revealButton.textContent = revealed ? "Hide" : "Reveal";
    revealButton.setAttribute("aria-pressed", String(revealed));
  }

  function showError(message) {
    address = "";
    revealed = false;
    addressOutput.textContent = "Address unavailable";
    addressOutput.classList.remove("address--hidden");
    copyButton.disabled = true;
    revealButton.disabled = true;
    setStatus("Setup unavailable", "error");
    feedback.textContent = message;
  }

  async function copyAddress() {
    if (!address) return;

    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      feedback.textContent = "Copy is unavailable in this browser. Reveal the address and copy it manually.";
      return;
    }

    try {
      await navigator.clipboard.writeText(address);
      feedback.textContent = "Address copied to the clipboard.";
    } catch (error) {
      feedback.textContent = "Could not copy automatically. Reveal the address and copy it manually.";
    }
  }

  async function loadAddress() {
    const config = window.SIMPLEX_SMP_CONFIG;
    if (!config || !config.host) {
      showError("The local relay host is not configured.");
      return;
    }

    try {
      const response = await fetch("/fingerprint", { cache: "no-store", headers: { Accept: "text/plain" } });
      if (!response.ok) throw new Error("fingerprint request failed");

      const fingerprint = (await response.text()).trim();
      if (!fingerprint) throw new Error("fingerprint is empty");

      address = "smp://" + fingerprint + (config.password ? ":" + config.password : "") + "@" + config.host;
      copyButton.disabled = false;
      revealButton.disabled = false;
      renderAddress();
      setStatus("Ready", "ready");
      feedback.textContent = "Address is concealed until you choose to reveal it.";
    } catch (error) {
      showError("The fingerprint could not be loaded. Check that the relay setup is complete, then refresh this page.");
    }
  }

  revealButton.addEventListener("click", function () {
    if (!address) return;
    revealed = !revealed;
    renderAddress();
    feedback.textContent = revealed ? "Address visible." : "Address hidden.";
  });

  copyButton.addEventListener("click", copyAddress);
  loadAddress();
}());
