import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const css = readFileSync(
  new URL("../../web/style.css", import.meta.url),
  "utf8",
);
function palette(dark: boolean) {
  const v: Record<string, string> = {};
  for (const pattern of [
    /:root\s*\{([^}]+)\}/g,
    ...(dark ? [/:root\[data-theme="dark"\]\s*\{([^}]+)\}/g] : []),
  ])
    for (const block of css.matchAll(pattern))
      for (const decl of block[1]!.matchAll(/(--[\w-]+):\s*([^;]+);/g))
        v[decl[1]!] = decl[2]!.trim();
  return (key: string): string => {
    let value = v[key]!;
    while (value.startsWith("var(")) value = v[value.slice(4, -1)]!;
    return value;
  };
}
function luminance(h: string) {
  const values = [1, 3, 5]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return values.reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i]!, 0);
}
function contrast(a: string, b: string) {
  const [low, high] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (high! + 0.05) / (low! + 0.05);
}
test("neutral dark surface and semantic financial/error foregrounds keep palette contrast without green", () => {
  const colors = palette(true);
  for (const [fg, bg] of [
    ["--ink", "--surface"],
    ["--tone-24", "--surface"],
    ["--sidebar-ink", "--sidebar-bg"],
    ["--tone-53", "--sidebar-bg"],
    ["--tone-87", "--sidebar-active"],
    ["--ink", "--surface-input"],
    ["--danger", "--surface"],
    ["--local", "--surface"],
    ["--remote", "--surface"],
    ["--warning", "--surface"],
    ["--success", "--success-bg"],
  ])
    assert.ok(contrast(colors(fg!), colors(bg!)) >= 4.5, fg + "/" + bg);
  for (const match of css.matchAll(/#[0-9a-f]{6}\b/gi)) {
    const h = match[0],
      r = parseInt(h.slice(1, 3), 16),
      g = parseInt(h.slice(3, 5), 16),
      b = parseInt(h.slice(5, 7), 16);
    assert.ok(!(g > r && g > b), "Green remains: " + h);
  }
  assert.equal(colors("--tone-79"), "#111113");
});
