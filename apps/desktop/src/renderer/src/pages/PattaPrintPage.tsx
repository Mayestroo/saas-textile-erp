import { useEffect, useMemo, useState } from 'react'
import type {
  DesktopModelOption,
  DesktopPattaPrintBatchResult,
  DesktopPattaPrintBatchInput
} from '../../../preload/erp-api'

interface EditableSizeRow {
  key: number
  razmer: string
  patta_count: string
}

const DEFAULT_SIZE_ROWS: readonly EditableSizeRow[] = [
  { key: 1, razmer: '', patta_count: '1' }
]

function integerDisplay(value: number): string {
  return new Intl.NumberFormat('uz-UZ').format(value)
}

function canonical(value: string): string {
  return value.replace(/[ \t\n\v\f\r]+/g, ' ').trim()
}

function formatPrintTime(value: string | null): string {
  if (!value) return 'Hali chop etilmagan'
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return value
  return new Intl.DateTimeFormat('uz-UZ', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(parsed)
}

export function PattaPrintPage(): React.JSX.Element {
  const [models, setModels] = useState<readonly DesktopModelOption[]>([])
  const [modelId, setModelId] = useState('')
  const [ishSoni, setIshSoni] = useState('125')
  const [rang, setRang] = useState('')
  const [sizes, setSizes] = useState<readonly EditableSizeRow[]>(DEFAULT_SIZE_ROWS)
  const [nextSizeKey, setNextSizeKey] = useState(2)
  const [savedBatch, setSavedBatch] = useState<DesktopPattaPrintBatchResult | null>(null)
  const [isCorrecting, setIsCorrecting] = useState(false)
  const [correctionReason, setCorrectionReason] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [isLoadingModels, setIsLoadingModels] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isPrinting, setIsPrinting] = useState(false)

  useEffect(() => {
    let mounted = true
    void window.erp.pattaPrint.models()
      .then((options) => {
        if (!mounted) return
        setModels(options)
        setModelId(options[0]?.id ?? '')
      })
      .catch(() => {
        if (mounted) setMessage('Mahalliy faol modellar ro‘yxatini olib bo‘lmadi')
      })
      .finally(() => {
        if (mounted) setIsLoadingModels(false)
      })
    return () => { mounted = false }
  }, [])

  const modelName = useMemo(
    () => models.find((model) => model.id === modelId)?.name ?? '',
    [models, modelId]
  )
  const normalizedSizes = useMemo(() => sizes.map((row) => ({
    key: row.key,
    razmer: canonical(row.razmer),
    count: Number(row.patta_count)
  })), [sizes])
  const totalPattas = normalizedSizes.reduce((sum, row) =>
    Number.isSafeInteger(row.count) && row.count > 0 ? sum + row.count : sum, 0)
  const sizeErrors = useMemo(() => {
    const errors = new Map<number, string>()
    const seen = new Set<string>()
    for (const row of normalizedSizes) {
      if (!row.razmer) errors.set(row.key, 'Razmerni kiriting')
      else if (seen.has(row.razmer.toLocaleLowerCase())) errors.set(row.key, 'Bu razmer takrorlangan')
      else seen.add(row.razmer.toLocaleLowerCase())
      if (!Number.isSafeInteger(row.count) || row.count < 1) errors.set(row.key, 'Pachka soni kamida 1 bo‘lsin')
    }
    return errors
  }, [normalizedSizes])

  const canSave = !isLoadingModels && !isSaving && models.length > 0 && Boolean(modelId) &&
    Number.isSafeInteger(Number(ishSoni)) && Number(ishSoni) > 0 && Boolean(canonical(rang)) &&
    sizes.length > 0 && sizeErrors.size === 0 && totalPattas <= 100 &&
    (!isCorrecting || Boolean(savedBatch && canonical(correctionReason).length >= 3))

  const changeSize = (key: number, field: 'razmer' | 'patta_count', value: string): void => {
    if (!isCorrecting) setSavedBatch(null)
    setSizes((previous) => previous.map((row) => row.key === key ? { ...row, [field]: value } : row))
  }

  const addSize = (): void => {
    if (!isCorrecting) setSavedBatch(null)
    setSizes((previous) => [...previous, { key: nextSizeKey, razmer: '', patta_count: '1' }])
    setNextSizeKey((previous) => previous + 1)
  }

  const removeSize = (key: number): void => {
    if (!isCorrecting) setSavedBatch(null)
    setSizes((previous) => previous.length > 1 ? previous.filter((row) => row.key !== key) : previous)
  }

  const saveBatch = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!canSave) return
    setIsSaving(true)
    setMessage(null)
    try {
      const sizeDistribution = normalizedSizes.map((row, sort_order) => ({
        razmer: row.razmer,
        patta_count: row.count,
        sort_order
      }))
      const batch = isCorrecting && savedBatch
        ? await window.erp.pattaPrint.correctBatch({
          batch_id: savedBatch.id,
          expected_version: savedBatch.version,
          correction_reason: canonical(correctionReason),
          ish_soni: Number(ishSoni),
          rang: canonical(rang),
          size_distribution: sizeDistribution
        })
        : await window.erp.pattaPrint.createBatch({
          model_id: modelId,
          ish_soni: Number(ishSoni),
          rang: canonical(rang),
          size_distribution: sizeDistribution
        } satisfies DesktopPattaPrintBatchInput)
      setSavedBatch(batch)
      setIsCorrecting(false)
      setCorrectionReason('')
      setMessage(batch.revision > 1
        ? 'Tuzatish saqlandi. Yangi tahrirdagi Pattalarni chop eting.'
        : 'Bosma to‘plami mahalliy bazaga saqlandi')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Bosma to‘plamini saqlab bo‘lmadi')
    } finally {
      setIsSaving(false)
    }
  }

  const printSavedBatch = async (): Promise<void> => {
    if (!savedBatch || isPrinting) return
    setIsPrinting(true)
    setMessage(null)
    try {
      const result = await window.erp.pattaPrint.printBatch(savedBatch.id)
      setSavedBatch(result.batch)
      setMessage(result.event.outcome === 'SUCCEEDED'
        ? 'Pechat hodisasi saqlandi. Raqamlar qayta ajratilmadi.'
        : 'Pechat urinishi bajarilmadi; saqlangan Pattalar o‘zgarmadi')
    } catch (error) {
      setMessage(error instanceof Error
        ? `${error.message}. Saqlangan Patta raqamlari o‘zgarmadi.`
        : 'Pechat bajarilmadi. Saqlangan Patta raqamlari o‘zgarmadi.')
    } finally {
      setIsPrinting(false)
    }
  }

  const resetForm = (): void => {
    setIsCorrecting(false)
    setCorrectionReason('')
    setSavedBatch(null)
    setMessage(null)
    setSizes(DEFAULT_SIZE_ROWS)
    setNextSizeKey(2)
    setIshSoni('125')
    setRang('')
  }

  const beginCorrection = (): void => {
    if (!savedBatch || savedBatch.status !== 'ACTIVE') return
    setIsCorrecting(true)
    setMessage(null)
    setModelId(savedBatch.model_id)
    setIshSoni(String(savedBatch.ish_soni))
    setRang(savedBatch.rang)
    setCorrectionReason('')
    setSizes(savedBatch.size_distribution.map((size, index) => ({
      key: index + 1,
      razmer: size.razmer,
      patta_count: String(size.patta_count)
    })))
    setNextSizeKey(savedBatch.size_distribution.length + 1)
  }

  const cancelCorrection = (): void => {
    if (!savedBatch) return
    setIsCorrecting(false)
    setCorrectionReason('')
    setModelId(savedBatch.model_id)
    setIshSoni(String(savedBatch.ish_soni))
    setRang(savedBatch.rang)
    setSizes(savedBatch.size_distribution.map((size, index) => ({
      key: index + 1,
      razmer: size.razmer,
      patta_count: String(size.patta_count)
    })))
    setNextSizeKey(savedBatch.size_distribution.length + 1)
  }

  return (
    <section className="patta-print-page" aria-labelledby="patta-print-title">
      <header className="print-page-heading">
        <div>
          <p className="print-kicker"><span className="print-kicker-mark" /> ISHLAB CHIQARISH / BOSMA</p>
          <h2 id="patta-print-title">Patta chiqarish</h2>
          <p className="print-intro">Partiya va Patta raqamlari korxona bo‘yicha ketma-ket ajratiladi.</p>
        </div>
        <div className="print-step-mark" aria-hidden="true"><span>01</span><i /> <span>03</span></div>
      </header>

      <form className="print-form" onSubmit={(event) => void saveBatch(event)}>
        <div className="print-fields">
          <label className="print-field print-field-model">
            <span className="print-label">MODEL <b className="auto-tag">MAHALLIY RO‘YXAT</b></span>
            <select value={modelId} onChange={(event) => { setModelId(event.target.value); setSavedBatch(null) }} disabled={isCorrecting || isLoadingModels || models.length === 0} required>
              {models.length === 0 ? <option value="">Faol model topilmadi</option> : null}
              {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
            {modelName ? <span className="print-field-hint">Tanlangan model: {modelName}</span> : null}
          </label>
          <label className="print-field">
            <span className="print-label">ISH SONI <b className="required-tag">MAJBURIY</b></span>
            <span className="print-input-unit">
              <input
                value={ishSoni}
                onChange={(event) => { setIshSoni(event.target.value); setSavedBatch(null) }}
                inputMode="numeric"
                pattern="[0-9]+"
                min={1}
                type="number"
                required
                aria-label="Mahsulot miqdori"
              />
              <span>dona</span>
            </span>
          </label>
          <label className="print-field">
            <span className="print-label">RANG <b className="required-tag">MAJBURIY</b></span>
            <input
              value={rang}
              onChange={(event) => { setRang(event.target.value); setSavedBatch(null) }}
              placeholder="Masalan, Qora"
              maxLength={120}
              required
            />
          </label>
        </div>

        {isCorrecting ? (
          <label className="print-field correction-reason-field">
            <span className="print-label">TUZATISH SABABI <b className="required-tag">MAJBURIY</b></span>
            <input
              value={correctionReason}
              onChange={(event) => setCorrectionReason(event.target.value)}
              placeholder="Masalan, razmer taqsimoti qayta tekshirildi"
              maxLength={500}
              required
            />
          </label>
        ) : null}

        <section className="size-editor" aria-labelledby="size-editor-title">
          <div className="size-editor-heading">
            <div>
              <p className="print-label">RAZMER TAQSIMOTI</p>
              <h3 id="size-editor-title">Har bir pachka — alohida Patta</h3>
            </div>
            <div className="pack-total"><small>JAMI PACHKA</small><strong>{integerDisplay(totalPattas)}</strong></div>
          </div>
          <div className="size-grid-heading" aria-hidden="true">
            <span>№</span><span>Razmer</span><span>Pachka soni</span><span>Amal</span>
          </div>
          <div className="size-rows">
            {sizes.map((row, index) => (
              <div className="size-row" key={row.key}>
                <span className="size-index">{String(index + 1).padStart(2, '0')}</span>
                <label className="visually-hidden" htmlFor={`size-${row.key}`}>Razmer {index + 1}</label>
                <input
                  id={`size-${row.key}`}
                  value={row.razmer}
                  onChange={(event) => changeSize(row.key, 'razmer', event.target.value)}
                  placeholder="S, M, L…"
                  maxLength={48}
                  aria-invalid={sizeErrors.has(row.key)}
                  required
                />
                <label className="visually-hidden" htmlFor={`count-${row.key}`}>Pachka soni {index + 1}</label>
                <input
                  id={`count-${row.key}`}
                  value={row.patta_count}
                  onChange={(event) => changeSize(row.key, 'patta_count', event.target.value)}
                  inputMode="numeric"
                  type="number"
                  min={1}
                  max={100}
                  aria-invalid={sizeErrors.has(row.key)}
                  required
                />
                <button
                  className="size-remove"
                  type="button"
                  onClick={() => removeSize(row.key)}
                  disabled={sizes.length <= 1}
                  aria-label={`${row.razmer || `Razmer ${index + 1}`} qatorini olib tashlash`}
                >−</button>
                {sizeErrors.has(row.key) ? <span className="size-error" role="alert">{sizeErrors.get(row.key)}</span> : null}
              </div>
            ))}
          </div>
          <button className="add-size-button" type="button" onClick={addSize} disabled={sizes.length >= 12}>
            <span aria-hidden="true">＋</span> Razmer qatori qo‘shish
          </button>
          {totalPattas > 100 ? <p className="form-error" role="alert">Bir to‘plamda ko‘pi bilan 100 ta Patta bo‘lishi mumkin.</p> : null}
        </section>

        <div className="numbering-note">
          <span className="numbering-icon" aria-hidden="true">↗</span>
          <p><strong>Raqamlar avtomatik.</strong> Partiya va Patta raqamlari model almashganda ham qayta boshlanmaydi.</p>
        </div>
        <div className="print-form-actions">
          <button className="save-batch-button" type="submit" disabled={!canSave}>
            {isSaving ? 'Mahalliy bazaga saqlanmoqda…' : isCorrecting ? 'Tuzatishni saqlash' : 'Bosma to‘plamini saqlash'}
            <span aria-hidden="true">↗</span>
          </button>
          {isCorrecting ? <button className="new-batch-button" type="button" onClick={cancelCorrection}>Bekor qilish</button> : null}
          {savedBatch ? <button className="new-batch-button" type="button" onClick={resetForm}>Yangi to‘plam</button> : null}
        </div>
      </form>

      {message ? <p className="print-status-message" role="status">{message}</p> : null}
      {savedBatch ? (
        <section className="saved-batch-card" aria-labelledby="saved-batch-title">
          <div className="saved-batch-topline"><span className="saved-badge"><i /> SAQLANGAN</span><span>Tahrir {savedBatch.revision}</span></div>
          <div className="saved-batch-main">
            <div><small>MODEL</small><strong id="saved-batch-title">{savedBatch.model_name_snapshot}</strong></div>
            <div><small>PARTIYA №</small><strong className="number-value">{savedBatch.partiya_number}</strong></div>
            <div><small>FAOL PATTALAR</small><strong className="number-value">{integerDisplay(savedBatch.pattas.filter(({ status }) => status === 'ACTIVE').length)}</strong></div>
          </div>
          <div className="saved-batch-sizes">
            {savedBatch.size_distribution.map((size) => (
              <span key={size.id}><b>{size.razmer}</b><em>{integerDisplay(size.patta_count)} pachka</em></span>
            ))}
          </div>
          <p className="saved-batch-print-time">Birinchi chop etish: {formatPrintTime(savedBatch.printed_at)}</p>
          {savedBatch.pattas.some(({ status }) => status === 'VOID') ? (
            <p className="reprint-note">VOID: {integerDisplay(savedBatch.pattas.filter(({ status }) => status === 'VOID').length)} ta Patta tarixda saqlandi, chop etilmaydi.</p>
          ) : null}
          <div className="saved-batch-actions">
          <button className="print-batch-button" type="button" onClick={() => void printSavedBatch()} disabled={isPrinting}>
            <span className="printer-glyph" aria-hidden="true">▤</span>
            {isPrinting ? 'Chop etish oynasi ochilmoqda…' : savedBatch.revision > 1
              ? savedBatch.printed_at ? 'Tuzatilgan nusxani qayta pechat qilish' : 'Tuzatilgan nusxani chop etish'
              : savedBatch.printed_at ? 'Qayta pechat qilish' : 'Pechat qilish'}
            <span className="button-arrow" aria-hidden="true">→</span>
          </button>
          <button className="new-batch-button" type="button" onClick={beginCorrection} disabled={isCorrecting || isPrinting}>
            Tuzatish
          </button>
          </div>
          <p className="reprint-note">Qayta pechat yangi Patta raqamlari ajratmaydi.</p>
        </section>
      ) : null}
      <p className="print-page-footer"><span>OFFLINE-FIRST</span><span>Mahalliy saqlash · keyin sinxronlash</span></p>
    </section>
  )
}
