# SatsSurge export DLS 1.0.0

Generation contract for supplied, authorized report content. Choose components
and composition to answer the request; these examples are optional, not fixed
templates. The renderer supplies this CSS, A4 page profile and bundled fonts.
PDF and PNG use the same paginated print layout; PNG is one first-page preview
at 120 DPI (993 × 1404 pixels for A4), never a silent truncation of a multipage
report: its manifest always retains total pages and selected page 1. Use PDF
for the complete long report. No JavaScript or externally fetched assets.

The application's Manrope headings and DM Sans body carry into white-paper
exports. Fonts in `fonts/` include original variable TTF sources and pinned static 400/700 instances with OFL licenses,
source Git blob, full-axis fontTools derivation and SHA-256 receipts; the worker validates them before render.
Use Manrope 700 for headings/KPIs and DM Sans 400/700 for body/labels, with
system sans-serif only as a diagnostic fallback. Missing qualified families
must fail qualification; never claim font coverage from a CSS name alone.

Semantic tokens: ink #111113, paper #ffffff, surface #f4f4f5, muted/unknown
#52525b, line #d4d4d8, brand #1d4ed8, positive #166534, warning #854d0e,
negative #991b1b. Every text token exceeds WCAG 4.5:1 against white and surface.
Borders are separators, not the sole state cue. State names, coverage text,
values and legends accompany color. The paper palette preserves the app's
neutral hierarchy while supporting print and small Telegram previews.

Body 10pt/1.5; title 25pt/1.2; section 16pt/1.2; subsection 12pt/1.2;
metadata/tables 9pt; footer 8pt. Keep title and metadata readable. Spacing scale
4/6/8/12/16/24pt; cards 12pt padding, 6pt radius, 1pt border. Explicit two/three
column grids use 12pt gaps. Prefer one column for prose and long labels; avoid
nested grids, auto-fill, subgrid, fixed heights, absolute/fixed positioning and
unbounded SVG canvases. The validator rejects unsafe CSS and unsupported layout
features. Supplied font-size overrides must be literal absolute 8–48pt
(10.67–64px, including SVG attributes); zero, relative/calculated sizes, font
shorthand and font-size-adjust fail. Prefer trusted DLS classes. Do not squeeze text to fit; paginate or simplify.

Reports identify the question, observation timestamp and time zone, units,
coverage and provenance before drawing conclusions. KPI label/value/unit and
observation window stay together. State unknown values as “Non disponibile”,
partial coverage as “Copertura parziale: …”, and simulated/example data as
“Dati di esempio”. Never fill gaps with zero or treat forecasts as realized
revenue. Source references are bounded opaque IDs, not confidential raw tool
payloads, credentials, or private financial identifiers.

Italian formatting: `1.234,56 €`, integer `1.234 sat`, precise `1.234.567 msat`,
percent `12,5%`, date `10 ott 2026, 14:30 Europe/Rome`. Do not derive monetary
values with floating-point rounding. Preserve exact source integer values;
label conversions and data windows. Charts must include a textual summary,
axis/units, tick labels, legend, observation window and explicit missing data.
Inline SVG only; no images or referenced resources. Never use color alone.

A4 portrait, 18mm top/16mm side/19mm bottom margins, page counters and DLS
footer. Repeat table headers, right-align numbers, wrap long labels, keep
ordinary rows/cards together, and allow long tables across pages. Avoid rows
larger than one page: split prose or use a detail section. Use `.page-break`
only for a deliberate new section. Charts/cards cannot exceed printable area.
Inspect every page after substantial content change for clipping, overlaps,
missing glyphs and illegible labels. Source-only tests do not qualify target
Linux or Telegram rendering. Long representative `example.html` covers KPI,
chart, partial-data warning, long labels, 90-row tables and deliberate breaks.

Do: escape every dynamic string; use semantic HTML and restrained styles;
include source freshness; keep unknowns explicit; deliver CSV/XLSX directly.
Don't: add scripts, events, imports, URL/data/file resources, font-face rules,
attachments, fixed overlays, hidden text, arbitrary paths or finance authority.

### Untrusted output policy puppeteer-visible-v1

The worker injects this qualified CSS; do not copy the full CSS into HTML. Compose
semantic DLS classes freely. Custom declarations are restricted to font-size
8–48pt, font-weight 400/700, normal/italic, text alignment, numeric variant,
line-height 1.2–2, dark semantic text colors, light DLS backgrounds and safe page
breaks. Layout overrides, transforms, !important, functions/variables, hidden or
transparent text and arbitrary paint/layout properties are rejected.

Charts use a literal zero-origin viewport 80–660px wide and 40–800px high, with
an equal viewBox. Use bounded rect/circle/line/polyline/polygon shapes before
plain-text labels, no transforms, paths, nested SVG or tspan. Labels specify x/y
and an absolute readable font-size, remain inside the viewport and must not
overlap each other or shapes. The worker pins opaque DM Sans 400/700 and checks
actual bundled glyph advances. Use HTML legends outside SVG for crowded charts;
SVG cannot be scaled down inside a narrow grid. Output policy rejects invalid
artifacts rather than silently omitting labels. Identity/layout checks cannot
certify that the agent included every authorized fact.

The authorized observation timestamp, exact coverage statement and every supplied
evidence reference must appear as visible text in the HTML. The renderer rejects
missing provenance; metadata in an attachment caption does not replace it.
Puppeteer renders this HTML to A4 PDF; PNG rasterizes its first PDF page, retaining
the total page count. The renderer never authors report content.

Code uses the qualified DM Sans body face at 8pt with wrapping; do not rely on
monospaced text alignment. Use semantic tables for aligned source/value columns.
