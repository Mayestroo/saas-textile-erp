import type { PattaPrintBatchProjection } from '@textile/sync-protocol'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('uz-UZ').format(value)
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

function pattaSlip(batch: PattaPrintBatchProjection, patta: PattaPrintBatchProjection['pattas'][number]): string {
  const operations = [...patta.operations]
    .sort((left, right) => left.sort_order - right.sort_order || left.operation_id.localeCompare(right.operation_id))
    .map((operation) => `
      <li><span>${escapeHtml(operation.operation_name_snapshot)}</span>
        <strong>${escapeHtml(operation.unit_price_snapshot)} so‘m</strong></li>
    `).join('')
  return `
    <article class="slip">
      <div class="slip-brand"><span>ATELIER / ISHLAB CHIQARISH</span><b>PATTA</b></div>
      <div class="model">${escapeHtml(batch.model_name_snapshot)}</div>
      <div class="identity">
        <div><small>PARTIYA №</small><strong>${escapeHtml(batch.partiya_number)}</strong></div>
        <div><small>PATTA №</small><strong>${escapeHtml(patta.patta_number)}</strong></div>
      </div>
      <div class="quantity"><span>MAHSULOT MIQDORI</span><strong>${formatInteger(batch.ish_soni)}<small> dona</small></strong></div>
      <div class="details">
        <div><small>RAZMER</small><strong>${escapeHtml(patta.razmer ?? '—')}</strong></div>
        <div><small>RANG</small><strong>${escapeHtml(batch.rang)}</strong></div>
        <div><small>CHOP ETILDI</small><strong>${escapeHtml(formatTimestamp(batch.printed_at ?? batch.created_at))}</strong></div>
      </div>
      <ol class="operations">${operations}</ol>
      <footer><span>Har bir operatsiya bo‘yicha bajarilganda Jetonni kiriting</span><b>${escapeHtml(patta.patta_number)}</b></footer>
    </article>
  `
}

export function renderPattaPrintHtml(batch: PattaPrintBatchProjection): string {
  const activePattas = batch.pattas.filter((patta) => patta.status === 'ACTIVE')
  if (batch.status !== 'ACTIVE' || activePattas.length === 0) {
    throw new Error('Faqat faol va saqlangan Pattalarni chop etish mumkin')
  }
  const sortedPattas = [...activePattas].sort((left, right) => {
    const leftNumber = BigInt(left.patta_number)
    const rightNumber = BigInt(right.patta_number)
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
  })
  const summaries = batch.size_distribution
    .slice()
    .sort((left, right) => left.sort_order - right.sort_order || left.razmer.localeCompare(right.razmer))
    .map((size) => `${escapeHtml(size.razmer)} ${formatInteger(size.patta_count)} pachka`)
    .join(' · ')
  const revisionMark = batch.revision > 1 ? `<b class="revision">TUZATILGAN NUSXA · ${batch.revision}-tahrir</b>` : ''
  const pages: string[] = []
  for (let index = 0; index < sortedPattas.length; index += 2) {
    const first = sortedPattas[index]
    const second = sortedPattas[index + 1]
    if (!first) continue
    pages.push(`<section class="page">${index === 0 ? `
      <header class="page-summary">
        <div><small>BOSMA TO‘PLAMI</small><strong>${escapeHtml(batch.model_name_snapshot)}</strong></div>
        <div class="page-summary-meta"><span>Partiya № <b>${escapeHtml(batch.partiya_number)}</b></span>
          <span>Jami <b>${formatInteger(activePattas.length)}</b> pachka</span>
          <span>${summaries}</span></div>
        ${revisionMark}
      </header>` : ''}<div class="slips">${pattaSlip(batch, first)}${second ? pattaSlip(batch, second) : '<div class="blank"></div>'}</div></section>`)
  }
  return `<!doctype html>
<html lang="uz"><head><meta charset="utf-8"><title>Patta ${escapeHtml(batch.partiya_number)}</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #202723; font-family: "Segoe UI", "Noto Sans", sans-serif; }
  body { background: #edf3ee; }
  .revision { color:#8a5c12; font-weight:800; font-size:8pt; }
  .page { width:210mm; height:297mm; margin:8mm auto; padding:7mm 11mm; background:#fff; display:flex; flex-direction:column; gap:4mm; page-break-after:always; break-after:page; }
  .page:last-of-type { page-break-after:auto; break-after:auto; }
  .page-summary { min-height:15mm; display:flex; align-items:center; justify-content:space-between; gap:4mm; border-bottom:1px solid #c7cdc5; }
  .page-summary > div:first-child { display:flex; align-items:baseline; gap:3mm; }
  .page-summary small { color:#6e776f; font-size:6pt; font-weight:800; letter-spacing:.12em; }
  .page-summary strong { font-size:11pt; }
  .page-summary-meta { display:flex; flex-wrap:wrap; gap:3mm; justify-content:flex-end; font-size:7pt; }
  .page-summary-meta b { color:#147a4c; }
  .slips { min-height:0; flex:1; display:grid; grid-template-rows:1fr 1fr; gap:5mm; }
  .slip { position:relative; min-height:0; padding:7mm 8mm 6mm; border:1px solid #c6d3c9; border-left:4px solid #147a4c; display:flex; flex-direction:column; overflow:hidden; }
  .slip-brand { display:flex; justify-content:space-between; align-items:center; color:#667067; font-size:7pt; font-weight:800; letter-spacing:.14em; }
  .slip-brand b { color:#147a4c; font-size:12pt; letter-spacing:.08em; }
  .model { margin-top:4mm; font-size:19pt; font-weight:750; letter-spacing:-.04em; }
  .identity { display:grid; grid-template-columns:1fr 1fr; gap:4mm; margin-top:5mm; }
  .identity div, .details div { display:flex; flex-direction:column; gap:1mm; }
  small { color:#6e776f; font-size:7pt; font-weight:800; letter-spacing:.13em; }
  .identity strong { font-size:18pt; font-variant-numeric:tabular-nums; }
  .quantity { margin-top:5mm; padding:3mm 4mm; background:#edf5ef; display:flex; align-items:center; justify-content:space-between; }
  .quantity span { font-size:8pt; font-weight:800; letter-spacing:.08em; }
  .quantity strong { font-size:18pt; }
  .quantity strong small { font-size:8pt; letter-spacing:0; }
  .details { display:grid; grid-template-columns:1fr 1fr 1.3fr; gap:4mm; margin-top:4mm; }
  .details strong { font-size:10pt; }
  .operations { list-style:none; padding:0; margin:5mm 0 0; border-top:1px solid #d5d9d3; }
  .operations li { display:flex; justify-content:space-between; padding:2mm 0; border-bottom:1px solid #d5d9d3; font-size:9pt; }
  .operations strong { font-variant-numeric:tabular-nums; }
  footer { margin-top:auto; padding-top:3mm; display:flex; justify-content:space-between; border-top:1px dashed #aeb6ad; color:#657067; font-size:7pt; }
  footer b { color:#202723; font-size:9pt; }
  .blank { border:1px dashed #d5d9d3; }
  @media print { body { background:#fff; } .page { margin:0; } }
</style></head><body>
  ${pages.join('')}
</body></html>`
}
