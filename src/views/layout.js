const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Every value rendered into a page comes from the database, so nothing is trusted. */
export function esc(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (char) => ENTITIES[char])
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa;
    --panel: #ffffff;
    --ink: #1a1d21;
    --muted: #6b7280;
    --line: #e6e6e3;
    --accent: #0f766e;
    --warn: #b45309;
    --warn-bg: #fef3c7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181c;
      --panel: #1d2025;
      --ink: #e8eaed;
      --muted: #9aa2ad;
      --line: #2c3037;
      --accent: #5eead4;
      --warn: #fbbf24;
      --warn-bg: #3a2f14;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header {
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .bar {
    max-width: 1080px;
    margin: 0 auto;
    padding: 14px 20px;
    display: flex;
    align-items: baseline;
    gap: 22px;
    flex-wrap: wrap;
  }
  .brand { font-weight: 650; letter-spacing: -0.01em; }
  .bar a { color: var(--muted); text-decoration: none; font-size: 14px; }
  .bar a:hover, .bar a[aria-current] { color: var(--accent); }
  main { max-width: 1080px; margin: 0 auto; padding: 28px 20px 64px; }
  h1 { font-size: 22px; letter-spacing: -0.02em; margin: 0 0 4px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.06em;
       color: var(--muted); margin: 32px 0 10px; font-weight: 600; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .card .n { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; }
  .card .k { color: var(--muted); font-size: 13px; }
  .wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; font-size: 12px;
       text-transform: uppercase; letter-spacing: 0.05em; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  a { color: var(--accent); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 999px;
         background: var(--bg); border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .low { color: var(--warn); font-weight: 600; }
  .empty { padding: 22px; color: var(--muted); }
  form.record { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
                padding: 16px; display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
  label { display: flex; flex-direction: column; gap: 5px; font-size: 12px;
          color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  input, select {
    font: inherit; padding: 7px 9px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--bg); color: var(--ink); min-width: 130px;
  }
  button {
    font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 7px;
    border: 1px solid var(--accent); background: var(--accent); color: var(--panel); cursor: pointer;
  }
  .notice { border-radius: 10px; padding: 11px 14px; margin-bottom: 18px; font-size: 14px;
            background: var(--warn-bg); color: var(--warn); border: 1px solid var(--line); }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; align-items: flex-end; }
`

const NAV = [
  ['/', 'Dashboard'],
  ['/items', 'Items'],
  ['/movements', 'Movements']
]

export function layout({ title, current, body }) {
  const nav = NAV.map(
    ([href, label]) =>
      `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`
  ).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Inventory Service</title>
<style>${STYLES}</style>
</head>
<body>
<header><div class="bar"><span class="brand">Inventory Service</span>${nav}</div></header>
<main>${body}</main>
</body>
</html>`
}

export function table({ columns, rows, empty = 'Nothing to show.' }) {
  if (rows.length === 0) return `<div class="wrap"><p class="empty">${esc(empty)}</p></div>`

  const head = columns
    .map((column) => `<th${column.num ? ' class="num"' : ''}>${esc(column.label)}</th>`)
    .join('')

  const body = rows
    .map(
      (row) =>
        `<tr>${columns
          .map((column) => `<td${column.num ? ' class="num"' : ''}>${column.cell(row)}</td>`)
          .join('')}</tr>`
    )
    .join('')

  return `<div class="wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}
