(function () {
  var mode = "system";
  try {
    var saved = localStorage.getItem("satssurge.theme");
    if (["light", "dark", "system"].includes(saved)) mode = saved;
  } catch (_) {}
  var dark =
    mode === "dark" ||
    (mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? "#111113" : "#f7f7f8";
})();
