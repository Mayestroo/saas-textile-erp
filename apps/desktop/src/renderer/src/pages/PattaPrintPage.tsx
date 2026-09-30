import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Printer,
  Plus,
  Layers,
  CheckCircle2,
  TrendingUp,
  X,
  RotateCcw
} from 'lucide-react'
import type {
  DesktopModelOption,
  DesktopPattaPrintBatchResult,
  DesktopPattaPrintBatchInput
} from '../../../preload/erp-api'
import { PattaPrintPreview } from '../components/PattaPrintPreview'

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
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const closePreview = useCallback(() => setIsPreviewOpen(false), [])

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

  const saveBatch = async (event?: React.FormEvent): Promise<void> => {
    if (event) event.preventDefault()
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
    setIsPreviewOpen(false)
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

  // Calculate statistics for the summary table
  const summaryList = useMemo(() => {
    return models.map((m) => {
      const isCurrentSaved = savedBatch && savedBatch.model_id === m.id
      return {
        modelId: m.id,
        modelName: m.name,
        partyCount: isCurrentSaved ? 1 : 0,
        pattaCount: isCurrentSaved ? savedBatch.pattas.filter((p) => p.status === 'ACTIVE').length : 0,
        ishSoni: isCurrentSaved ? savedBatch.ish_soni : 0
      }
    })
  }, [models, savedBatch])

  const grandTotals = useMemo(() => {
    return summaryList.reduce(
      (acc, item) => {
        acc.parties += item.partyCount
        acc.pattas += item.pattaCount
        acc.ishSoni += item.ishSoni
        return acc
      },
      { parties: 0, pattas: 0, ishSoni: 0 }
    )
  }, [summaryList])

  return (
    <div
      className="excel-grid-container"
      style={{
        padding: '16px 20px',
        backgroundColor: 'var(--bg-app)',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        userSelect: 'none'
      }}
    >
      {/* 1. Top Global Action Bar (exact match to hisob PattaBatchView) */}
      <div
        style={{
          width: '100%',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl, 16px)',
          padding: '12px 20px',
          boxShadow: 'var(--shadow-sm)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <div
            style={{
              background: 'var(--primary-light)',
              color: 'var(--primary)',
              padding: '6px 14px',
              borderRadius: 'var(--radius-full, 9999px)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontWeight: 800,
              fontSize: '13px'
            }}
          >
            <Layers size={16} />
            <span>Pattalar Pechati (Partiyalar)</span>
          </div>

          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <span>Model: <strong style={{ color: 'var(--text-primary)' }}>{modelName || '—'}</strong></span>
            <span>Jami patta: <strong style={{ color: totalPattas > 0 ? '#4f46e5' : 'var(--text-primary)' }}>{totalPattas} ta</strong></span>
            {totalPattas > 0 && (
              <span style={{ color: 'var(--primary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <CheckCircle2 size={15} /> ({Math.ceil(totalPattas / 2)} ta A4 varaq)
              </span>
            )}
          </div>
        </div>

        {/* Global Action Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {savedBatch && (
            <span
              style={{
                background: 'rgba(16, 185, 129, 0.15)',
                color: '#059669',
                padding: '5px 14px',
                borderRadius: 'var(--radius-full, 9999px)',
                fontWeight: 700,
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <CheckCircle2 size={14} /> Partiya #{savedBatch.partiya_number} saqlangan
            </span>
          )}

          <button
            type="button"
            onClick={() => void saveBatch()}
            disabled={!canSave}
            className="soft-btn soft-btn-primary"
            style={{
              borderRadius: 'var(--radius-full, 9999px)',
              padding: '8px 22px',
              fontSize: '13.5px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              opacity: canSave ? 1 : 0.6,
              cursor: canSave ? 'pointer' : 'not-allowed'
            }}
          >
            <Printer size={16} />
            <span>Pechat ({totalPattas} ta patta)</span>
          </button>
        </div>
      </div>

      {/* Status banner */}
      {message && (
        <div
          role="status"
          style={{
            padding: '10px 16px',
            borderRadius: 'var(--radius-md, 8px)',
            background: message.includes('xato') || message.includes('bo‘lmadi') ? '#fef2f2' : 'var(--primary-light)',
            color: message.includes('xato') || message.includes('bo‘lmadi') ? '#dc2626' : 'var(--primary)',
            fontSize: '12.5px',
            fontWeight: 600,
            border: `1px solid ${message.includes('xato') || message.includes('bo‘lmadi') ? '#fecaca' : 'rgba(16, 185, 129, 0.3)'}`
          }}
        >
          {message}
        </div>
      )}

      {/* 2. Main Model Grid or Form Card */}
      {models.length === 0 && !isLoadingModels ? (
        <div
          style={{
            textAlign: 'center',
            padding: '48px 24px',
            background: 'var(--bg-surface)',
            borderRadius: 'var(--radius-xl, 16px)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--shadow-sm)'
          }}
        >
          <Layers size={36} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <h3 style={{ margin: '0 0 6px', fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
            Faol model topilmadi
          </h3>
          <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-muted)' }}>
            Iltimos, chap menyudagi &quot;+ Model&quot; tugmasi orqali yangi model qo‘shing.
          </p>
        </div>
      ) : (
        <form onSubmit={(e) => void saveBatch(e)} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Models Tab / Grid Header if multiple models */}
          {models.length > 1 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                overflowX: 'auto',
                paddingBottom: '4px'
              }}
            >
              {models.map((m) => {
                const isSelected = m.id === modelId
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setModelId(m.id)
                      setSavedBatch(null)
                    }}
                    className={`soft-btn ${isSelected ? 'soft-btn-primary' : ''}`}
                    style={{
                      borderRadius: 'var(--radius-md, 8px)',
                      padding: '8px 16px',
                      fontSize: '12.5px',
                      fontWeight: isSelected ? 800 : 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      backgroundColor: isSelected ? 'var(--primary-light)' : 'var(--bg-surface)',
                      borderColor: isSelected ? 'var(--primary)' : 'var(--border-subtle)',
                      color: isSelected ? 'var(--primary)' : 'var(--text-secondary)'
                    }}
                  >
                    <span>{m.name}</span>
                  </button>
                )
              })}
            </div>
          )}

          {/* Active Model Card matching hisob's Model Card */}
          <div
            style={{
              background: 'var(--bg-surface)',
              border: totalPattas > 0 ? '1.5px solid var(--primary)' : '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl, 16px)',
              boxShadow: totalPattas > 0 ? 'var(--shadow-md)' : 'var(--shadow-xs)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
            }}
          >
            {/* Card Header */}
            <div
              style={{
                padding: '12px 18px',
                background: totalPattas > 0 ? 'var(--primary-light)' : 'var(--bg-surface-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid var(--border-subtle)',
                gap: '8px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span
                  style={{
                    fontWeight: 800,
                    fontSize: '14px',
                    color: totalPattas > 0 ? 'var(--primary)' : 'var(--text-primary)'
                  }}
                >
                  {modelName || 'Model tanlang'}
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-secondary)',
                    fontWeight: 600,
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-full, 9999px)'
                  }}
                >
                  Model parametrlarini kiritish
                </span>
              </div>

              {/* Quick Model Selector (if models exist) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label htmlFor="model-select" style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--text-muted)' }}>
                  Model:
                </label>
                <select
                  id="model-select"
                  value={modelId}
                  onChange={(e) => {
                    setModelId(e.target.value)
                    setSavedBatch(null)
                  }}
                  disabled={isCorrecting || isLoadingModels || models.length === 0}
                  className="soft-input"
                  style={{ height: '30px', padding: '2px 10px', fontSize: '12px', fontWeight: 600, width: 'auto', minWidth: '140px' }}
                >
                  {models.length === 0 ? <option value="">Faol model topilmadi</option> : null}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Card Body */}
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {/* Row 1: Parameters */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: '14px'
                }}
              >
                {/* 1. Ish Soni */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label htmlFor="ish-soni-input" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    Jami ish soni (dona):
                  </label>
                  <input
                    id="ish-soni-input"
                    aria-label="Mahsulot miqdori"
                    type="number"
                    min="1"
                    value={ishSoni}
                    onChange={(e) => {
                      setIshSoni(e.target.value)
                      setSavedBatch(null)
                    }}
                    placeholder="125"
                    className="soft-input"
                    style={{
                      height: '32px',
                      textAlign: 'center',
                      fontWeight: 800,
                      fontSize: '13px',
                      color: 'var(--primary)'
                    }}
                    required
                  />
                </div>

                {/* 2. Partiya Raqami */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label htmlFor="partiya-input" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    Partiya:
                  </label>
                  <input
                    id="partiya-input"
                    type="text"
                    value={savedBatch ? `№ ${savedBatch.partiya_number}` : 'Avtomatik ajratiladi'}
                    readOnly
                    className="soft-input"
                    style={{
                      height: '32px',
                      textAlign: 'center',
                      fontWeight: 700,
                      fontSize: '12px',
                      backgroundColor: 'var(--bg-surface-subtle)',
                      color: 'var(--text-muted)'
                    }}
                  />
                </div>

                {/* 3. Rang */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label htmlFor="rang-input" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    RANG:
                  </label>
                  <input
                    id="rang-input"
                    aria-label="RANG"
                    type="text"
                    value={rang}
                    onChange={(e) => {
                      setRang(e.target.value)
                      setSavedBatch(null)
                    }}
                    placeholder="Masalan, Qora"
                    maxLength={120}
                    className="soft-input"
                    style={{
                      height: '32px',
                      textAlign: 'center',
                      fontWeight: 600,
                      fontSize: '12.5px'
                    }}
                    required
                  />
                </div>
              </div>

              {/* Metric Summary Pill */}
              <div
                style={{
                  padding: '8px 14px',
                  borderRadius: 'var(--radius-md, 8px)',
                  backgroundColor: totalPattas > 0 ? 'var(--primary-light)' : 'var(--bg-surface-subtle)',
                  color: totalPattas > 0 ? 'var(--primary)' : 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: '12.5px',
                  fontWeight: 700
                }}
              >
                <div>
                  Patta soni: <strong>{totalPattas} ta</strong>
                </div>
                {Number(ishSoni) > 0 && totalPattas > 0 && (
                  <div style={{ fontSize: '11.5px', color: 'var(--text-primary)' }}>
                    Har bir pattaga: <strong>{Math.floor(Number(ishSoni) / totalPattas)} dona</strong> ish
                  </div>
                )}
                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                  A4 varaqlari: <strong>{Math.ceil(totalPattas / 2)} ta</strong>
                </div>
              </div>

              {/* Correction reason field if correcting */}
              {isCorrecting && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label htmlFor="correction-reason" style={{ fontSize: '11.5px', fontWeight: 700, color: '#b45309' }}>
                    TUZATISH SABABI (MAJBURIY):
                  </label>
                  <input
                    id="correction-reason"
                    value={correctionReason}
                    onChange={(e) => setCorrectionReason(e.target.value)}
                    placeholder="Masalan, razmer taqsimoti qayta tekshirildi"
                    maxLength={500}
                    required
                    className="soft-input"
                    style={{ height: '34px', borderColor: '#f59e0b' }}
                  />
                </div>
              )}

              {/* Sizes Matrix Section */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)' }}>
                    Razmerlar taqsimoti (Har bir pachka — 1 patta)
                  </span>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--primary)' }}>
                    Jami pachka: {totalPattas}
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {sizes.map((row, index) => (
                    <div
                      key={row.key}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '36px 1fr 140px 36px',
                        gap: '8px',
                        alignItems: 'center',
                        background: 'var(--bg-surface-subtle)',
                        padding: '6px 10px',
                        borderRadius: 'var(--radius-sm, 6px)',
                        border: '1px solid var(--border-subtle)'
                      }}
                    >
                      <span style={{ fontWeight: 700, color: 'var(--text-muted)', fontSize: '11.5px', textAlign: 'center' }}>
                        {String(index + 1).padStart(2, '0')}
                      </span>

                      <div>
                        <label className="visually-hidden" htmlFor={`size-${row.key}`}>
                          Razmer {index + 1}
                        </label>
                        <input
                          id={`size-${row.key}`}
                          aria-label={`Razmer ${index + 1}`}
                          value={row.razmer}
                          onChange={(e) => changeSize(row.key, 'razmer', e.target.value)}
                          placeholder="Razmer (masalan, S, M, L...)"
                          maxLength={48}
                          required
                          className="soft-input"
                          style={{
                            height: '30px',
                            fontWeight: 700,
                            fontSize: '12px',
                            backgroundColor: row.razmer ? 'var(--bg-surface)' : 'transparent',
                            borderColor: sizeErrors.has(row.key) ? '#ef4444' : undefined
                          }}
                        />
                      </div>

                      <div>
                        <label className="visually-hidden" htmlFor={`count-${row.key}`}>
                          Pachka soni {index + 1}
                        </label>
                        <input
                          id={`count-${row.key}`}
                          aria-label={`Pachka soni ${index + 1}`}
                          value={row.patta_count}
                          onChange={(e) => changeSize(row.key, 'patta_count', e.target.value)}
                          type="number"
                          min="1"
                          max="100"
                          required
                          className="soft-input"
                          style={{
                            height: '30px',
                            textAlign: 'center',
                            fontWeight: 700,
                            fontSize: '12px',
                            backgroundColor: 'var(--bg-surface)'
                          }}
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => removeSize(row.key)}
                        disabled={sizes.length <= 1}
                        aria-label={`${row.razmer || `Razmer ${index + 1}`} qatorini olib tashlash`}
                        style={{
                          height: '30px',
                          width: '30px',
                          borderRadius: 'var(--radius-xs, 4px)',
                          background: sizes.length <= 1 ? 'transparent' : '#fee2e2',
                          color: '#dc2626',
                          border: '1px solid #fecaca',
                          cursor: sizes.length <= 1 ? 'not-allowed' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '14px',
                          fontWeight: 700,
                          opacity: sizes.length <= 1 ? 0.3 : 1
                        }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Add Size Button */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '4px' }}>
                  <button
                    type="button"
                    onClick={addSize}
                    disabled={sizes.length >= 12}
                    className="soft-btn"
                    style={{
                      padding: '5px 12px',
                      background: 'transparent',
                      border: '1px dashed var(--border-default)',
                      borderRadius: 'var(--radius-sm, 6px)',
                      color: 'var(--primary)',
                      fontSize: '11.5px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px'
                    }}
                  >
                    <Plus size={13} />
                    <span>Razmer qatori qo‘shish</span>
                  </button>

                  {totalPattas > 100 && (
                    <span style={{ fontSize: '11px', color: '#ef4444', fontWeight: 600 }}>
                      Bir to‘plamda ko‘pi bilan 100 ta Patta bo‘lishi mumkin.
                    </span>
                  )}
                </div>
              </div>

              {/* Form Bottom Action Buttons */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  paddingTop: '10px',
                  borderTop: '1px solid var(--border-subtle)',
                  flexWrap: 'wrap'
                }}
              >
                <button
                  type="submit"
                  disabled={!canSave}
                  className="save-batch-button soft-btn soft-btn-primary"
                  style={{
                    padding: '8px 20px',
                    fontSize: '13px',
                    fontWeight: 700,
                    borderRadius: 'var(--radius-full, 9999px)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    opacity: canSave ? 1 : 0.6,
                    cursor: canSave ? 'pointer' : 'not-allowed'
                  }}
                >
                  <Printer size={15} />
                  <span>
                    {isSaving
                      ? 'Mahalliy bazaga saqlanmoqda…'
                      : isCorrecting
                      ? 'Tuzatishni saqlash'
                      : 'Bosma to‘plamini saqlash'}
                  </span>
                </button>

                {isCorrecting && (
                  <button
                    type="button"
                    onClick={cancelCorrection}
                    className="soft-btn"
                    style={{
                      borderRadius: 'var(--radius-full, 9999px)',
                      padding: '8px 16px',
                      fontSize: '12.5px'
                    }}
                  >
                    Bekor qilish
                  </button>
                )}

                {savedBatch && (
                  <button
                    type="button"
                    onClick={resetForm}
                    className="soft-btn"
                    style={{
                      borderRadius: 'var(--radius-full, 9999px)',
                      padding: '8px 16px',
                      fontSize: '12.5px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px'
                    }}
                  >
                    <RotateCcw size={13} />
                    <span>Yangi to‘plam</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </form>
      )}

      {/* 3. Saved Batch Detail Card (matching hisob's batch status) */}
      {savedBatch && (
        <div
          style={{
            background: 'var(--bg-surface)',
            borderRadius: 'var(--radius-xl, 16px)',
            border: '1px solid var(--border-subtle)',
            padding: '18px 20px',
            boxShadow: 'var(--shadow-sm)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span
              style={{
                background: 'var(--primary-light)',
                color: 'var(--primary)',
                padding: '4px 12px',
                borderRadius: 'var(--radius-full, 9999px)',
                fontSize: '12px',
                fontWeight: 800,
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <CheckCircle2 size={13} /> SAQLANGAN BOSMA TO‘PLAMI
            </span>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>
              Tahrir: {savedBatch.revision}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: '14px',
              padding: '10px 14px',
              background: 'var(--bg-surface-subtle)',
              borderRadius: 'var(--radius-md, 8px)'
            }}
          >
            <div>
              <div style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--text-muted)' }}>MODEL</div>
              <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
                {savedBatch.model_name_snapshot}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--text-muted)' }}>PARTIYA №</div>
              <div style={{ fontSize: '15px', fontWeight: 800, color: '#4f46e5' }}>
                {savedBatch.partiya_number}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--text-muted)' }}>FAOL PATTALAR</div>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--primary)' }}>
                {integerDisplay(savedBatch.pattas.filter(({ status }) => status === 'ACTIVE').length)} ta
              </div>
            </div>

            <div>
              <div style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--text-muted)' }}>RANG</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                {savedBatch.rang}
              </div>
            </div>
          </div>

          {/* Sizes list */}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {savedBatch.size_distribution.map((size) => (
              <span
                key={size.razmer}
                style={{
                  background: 'var(--bg-surface-subtle)',
                  padding: '3px 10px',
                  borderRadius: 'var(--radius-full, 9999px)',
                  fontSize: '11.5px',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                <strong style={{ color: 'var(--text-primary)' }}>{size.razmer}:</strong>
                <span style={{ color: 'var(--text-secondary)' }}>{integerDisplay(size.patta_count)} pachka</span>
              </span>
            ))}
          </div>

          <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
            Birinchi chop etish: {formatPrintTime(savedBatch.printed_at)}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
            <button
              type="button"
              onClick={() => setIsPreviewOpen(true)}
              className="soft-btn"
              style={{
                borderRadius: 'var(--radius-full, 9999px)',
                padding: '6px 16px',
                fontSize: '12.5px',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <Printer size={14} />
              <span>Ko‘rib chiqish</span>
            </button>

            <button
              type="button"
              onClick={() => void printSavedBatch()}
              disabled={isPrinting}
              className="print-batch-button soft-btn soft-btn-primary"
              style={{
                borderRadius: 'var(--radius-full, 9999px)',
                padding: '7px 20px',
                fontSize: '12.5px',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <Printer size={14} />
              <span>
                {isPrinting
                  ? 'Chop etilmoqda…'
                  : savedBatch.printed_at
                  ? 'Qayta pechat qilish'
                  : 'Pechat qilish'}
              </span>
            </button>

            <button
              type="button"
              onClick={beginCorrection}
              disabled={isCorrecting || isPrinting}
              className="soft-btn"
              style={{
                borderRadius: 'var(--radius-full, 9999px)',
                padding: '6px 14px',
                fontSize: '12.5px'
              }}
            >
              Tuzatish
            </button>
          </div>
        </div>
      )}

      {/* 4. Bottom Statistics Table (exact match to hisob PattaBatchView lines 820-940) */}
      <div
        style={{
          background: 'var(--bg-surface)',
          borderRadius: 'var(--radius-xl, 16px)',
          boxShadow: 'var(--shadow-sm)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden'
        }}
      >
        {/* Table Header Card */}
        <div
          style={{
            padding: '14px 20px',
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '34px',
                height: '34px',
                borderRadius: 'var(--radius-md, 8px)',
                background: 'var(--primary-light)',
                color: 'var(--primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <TrendingUp size={18} />
            </div>
            <div>
              <h3 style={{ fontSize: '13.5px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                Barcha modellar bo‘yicha partiya, patta va ish soni statistikasi
              </h3>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                Modellar kesimida chiqarilgan partiyalar, pattalar va jami ish soni xulosasi
              </p>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              fontSize: '11.5px',
              fontWeight: 700,
              background: 'var(--bg-surface-subtle)',
              padding: '5px 12px',
              borderRadius: 'var(--radius-full, 9999px)',
              border: '1px solid var(--border-subtle)'
            }}
          >
            <span>Jami: <strong style={{ color: 'var(--text-primary)' }}>{models.length} ta model</strong></span>
            <span style={{ color: 'var(--border-subtle)' }}>•</span>
            <span><strong style={{ color: '#818cf8' }}>{grandTotals.parties} ta</strong> partiya</span>
            <span style={{ color: 'var(--border-subtle)' }}>•</span>
            <span><strong style={{ color: '#10b981' }}>{grandTotals.pattas} ta</strong> patta</span>
            <span style={{ color: 'var(--border-subtle)' }}>•</span>
            <span><strong style={{ color: 'var(--primary)' }}>{grandTotals.ishSoni.toLocaleString()} dona</strong> ish</span>
          </div>
        </div>

        {/* Table Content */}
        <div style={{ overflowX: 'auto' }}>
          <table className="excel-table" style={{ width: '100%' }}>
            <thead>
              <tr style={{ height: '34px', background: 'var(--bg-surface-subtle)' }}>
                <th className="col-header" style={{ width: '45px', textAlign: 'center' }}>№</th>
                <th className="col-header" style={{ textAlign: 'left', paddingLeft: '16px' }}>Model nomi</th>
                <th className="col-header" style={{ textAlign: 'right', width: '160px', color: '#818cf8' }}>Partiya soni</th>
                <th className="col-header" style={{ textAlign: 'right', width: '160px', color: '#10b981' }}>Patta soni</th>
                <th className="col-header" style={{ textAlign: 'right', width: '200px', color: 'var(--primary)' }}>Jami Ish soni</th>
              </tr>
            </thead>
            <tbody>
              {summaryList.map((item, idx) => {
                const hasData = item.partyCount > 0
                return (
                  <tr
                    key={item.modelId}
                    style={{
                      height: '36px',
                      backgroundColor: idx % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-surface-subtle)'
                    }}
                  >
                    <td style={{ textAlign: 'center', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                      {idx + 1}
                    </td>
                    <td style={{ paddingLeft: '16px', fontWeight: 700, fontSize: '12.5px', color: 'var(--text-primary)' }}>
                      {item.modelName}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '12px', color: hasData ? '#818cf8' : 'var(--text-muted)' }}>
                      {hasData ? `${item.partyCount} ta` : '0 ta'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '12px', color: hasData ? '#10b981' : 'var(--text-muted)' }}>
                      {hasData ? `${item.pattaCount} ta` : '0 ta'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 800, fontSize: '12.5px', color: hasData ? 'var(--primary)' : 'var(--text-muted)' }}>
                      {hasData ? `${item.ishSoni.toLocaleString()} dona` : '0 dona'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ height: '38px', background: 'var(--bg-surface-subtle)', borderTop: '2px solid var(--border-subtle)', fontWeight: 800 }}>
                <td colSpan={2} style={{ paddingLeft: '16px', fontSize: '12.5px', color: 'var(--text-primary)' }}>
                  JAMI (Barcha modellar):
                </td>
                <td style={{ textAlign: 'right', fontSize: '12.5px', color: '#818cf8' }}>
                  {grandTotals.parties} ta
                </td>
                <td style={{ textAlign: 'right', fontSize: '12.5px', color: '#10b981' }}>
                  {grandTotals.pattas} ta
                </td>
                <td style={{ textAlign: 'right', fontSize: '13px', color: 'var(--primary)' }}>
                  {grandTotals.ishSoni.toLocaleString()} dona
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Print Preview Modal */}
      {savedBatch && isPreviewOpen && (
        <PattaPrintPreview
          batch={savedBatch}
          printing={isPrinting}
          onClose={closePreview}
          onPrint={() => void printSavedBatch()}
        />
      )}
    </div>
  )
}
