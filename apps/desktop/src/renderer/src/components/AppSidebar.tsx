import React, { useState, useEffect } from 'react'
import {
  LayoutDashboard,
  FileText,
  FileSpreadsheet,
  Layers,
  Trash2,
  Plus,
  Search,
  X,
  ChevronsRight,
  ChevronsLeft,
  Calculator
} from 'lucide-react'
import type { DesktopModelOption } from '../../../preload/erp-api'

export type FactoryScreen = 'print' | 'entry' | 'history' | 'trash' | 'conveyor' | 'account'

export interface AppSidebarItem {
  screen: FactoryScreen
  label: string
  mark: string
  group: 'Ishlab chiqarish' | 'Hisob'
  visible: boolean
}

export interface AppSidebarProps {
  activeScreen: FactoryScreen
  items: readonly AppSidebarItem[]
  onNavigate(screen: FactoryScreen): void
  onOpenNewModel?: () => void
}

export function AppSidebar({
  activeScreen,
  items,
  onNavigate,
  onOpenNewModel
}: AppSidebarProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(true)
  const [searchFilter, setSearchFilter] = useState('')
  const [models, setModels] = useState<readonly DesktopModelOption[]>([])

  useEffect(() => {
    let mounted = true
    if (window.erp?.pattaSheet?.models) {
      window.erp.pattaSheet.models()
        .then((result) => {
          if (mounted) setModels(result)
        })
        .catch(() => undefined)
    }
    return () => { mounted = false }
  }, [])

  // Listen for Ctrl+B shortcut and Escape to toggle/close sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false)
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setIsOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  const getScreenIcon = (screen: FactoryScreen, isActive: boolean): React.JSX.Element => {
    switch (screen) {
      case 'print':
        return <FileText size={15} color={isActive ? 'var(--primary)' : '#f59e0b'} />
      case 'entry':
        return <FileSpreadsheet size={15} color={isActive ? 'var(--primary)' : '#10b981'} />
      case 'history':
        return <FileSpreadsheet size={15} color={isActive ? 'var(--primary)' : '#06b6d4'} />
      case 'conveyor':
        return <Layers size={15} color={isActive ? 'var(--primary)' : '#8b5cf6'} />
      case 'account':
        return <Calculator size={15} color={isActive ? 'var(--primary)' : '#3b82f6'} />
      case 'trash':
        return <Trash2 size={15} color={isActive ? 'var(--primary)' : '#ef4444'} />
      default:
        return <FileText size={15} color="var(--primary)" />
    }
  }

  const filteredModels = models.filter((m) =>
    !searchFilter.trim() || m.name.toLowerCase().includes(searchFilter.toLowerCase().trim())
  )

  const visibleItems = items.filter((item) => item.visible)

  return (
    <>
      {/* 1. Toggle button when collapsed (>> on left edge) */}
      {!isOpen && (
        <button
          type="button"
          className="excel-sidebar-toggle-btn"
          onClick={() => setIsOpen(true)}
          title="Varaqlar menyusini ochish (>> / Ctrl+B)"
          aria-label="Varaqlar menyusini ochish"
          style={{
            position: 'absolute',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '24px',
            height: '56px',
            backgroundColor: 'var(--bg-surface, #ffffff)',
            border: '1px solid var(--border-subtle, #e2e8f0)',
            borderLeft: 'none',
            borderRadius: '0 8px 8px 0',
            color: 'var(--primary, #059669)',
            cursor: 'pointer',
            boxShadow: '2px 2px 10px rgba(15, 23, 42, 0.12)',
            padding: 0
          }}
        >
          <ChevronsRight size={18} strokeWidth={2.5} />
        </button>
      )}

      {/* 2. Backdrop overlay (click to close) */}
      <div
        className={`excel-sidebar-backdrop ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(false)}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(15, 23, 42, 0.25)',
          backdropFilter: 'blur(1.5px)',
          zIndex: 45,
          opacity: isOpen ? 1 : 0,
          visibility: isOpen ? 'visible' : 'hidden',
          pointerEvents: isOpen ? 'auto' : 'none',
          transition: 'opacity 0.22s ease, visibility 0.22s ease'
        }}
      />

      {/* 3. Main Sliding Sidebar Drawer */}
      <aside
        className={`app-sidebar excel-sidebar ${isOpen ? 'open' : ''}`}
        aria-label="Asosiy navigation"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: '260px',
          backgroundColor: 'var(--bg-surface, #ffffff)',
          borderRight: '1px solid var(--border-subtle, #e2e8f0)',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflow: 'visible',
          userSelect: 'none',
          zIndex: 50,
          boxShadow: '4px 0 24px rgba(15, 23, 42, 0.18)',
          transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.24s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        {/* Center edge close tab (<< attached to right edge of drawer) */}
        {isOpen && (
          <button
            type="button"
            className="excel-sidebar-close-tab"
            onClick={() => setIsOpen(false)}
            title="Varaqlar menyusini yopish (<< / Ctrl+B)"
            aria-label="Varaqlar menyusini yopish"
            style={{
              position: 'absolute',
              right: '-24px',
              top: '50%',
              transform: 'translateY(-50%)',
              width: '24px',
              height: '56px',
              backgroundColor: 'var(--bg-surface, #ffffff)',
              border: '1px solid var(--border-subtle, #e2e8f0)',
              borderLeft: 'none',
              borderRadius: '0 8px 8px 0',
              color: 'var(--text-muted, #64748b)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '3px 2px 10px rgba(15, 23, 42, 0.15)',
              zIndex: 51,
              padding: 0
            }}
          >
            <ChevronsLeft size={18} strokeWidth={2.5} />
          </button>
        )}

        {/* Header */}
        <div className="excel-sidebar-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <LayoutDashboard size={16} color="var(--primary)" />
            <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>
              Varaqlar
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {onOpenNewModel && (
              <button
                type="button"
                onClick={onOpenNewModel}
                className="soft-btn soft-btn-primary"
                style={{
                  padding: '3px 8px',
                  fontSize: '11px',
                  fontWeight: 700,
                  borderRadius: 'var(--radius-sm, 6px)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  backgroundColor: 'var(--primary-light, #ecfdf5)',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  color: 'var(--primary-dark, #065f46)',
                  cursor: 'pointer'
                }}
                title="Yangi model qo'shish (+)"
              >
                <Plus size={12} />
                <span>Model</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="soft-btn"
              style={{
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--radius-sm, 6px)',
                color: 'var(--text-muted, #64748b)',
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer'
              }}
              title="Yopish (Ctrl+B / Esc)"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div style={{ padding: '6px 8px 2px', flexShrink: 0 }}>
          <div style={{ position: 'relative' }}>
            <Search
              size={13}
              color="var(--text-muted)"
              style={{ position: 'absolute', left: '8px', top: '7px', pointerEvents: 'none' }}
            />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder="Model yoki varaq qidirish..."
              className="soft-input"
              style={{
                height: '28px',
                paddingLeft: '28px',
                paddingRight: searchFilter ? '24px' : '8px',
                fontSize: '11.5px',
                borderRadius: 'var(--radius-sm, 6px)',
                width: '100%',
                backgroundColor: 'var(--bg-surface, #ffffff)',
                border: '1px solid var(--border-default, #cbd5e1)',
                outline: 'none',
                color: 'var(--text-primary, #1e293b)'
              }}
            />
            {searchFilter && (
              <button
                type="button"
                onClick={() => setSearchFilter('')}
                style={{
                  position: 'absolute',
                  right: '6px',
                  top: '6px',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  padding: 0
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <nav className="excel-sidebar-content app-sidebar__nav">
          {/* Asosiy Section */}
          <div className="excel-sidebar-section-title app-sidebar__group-title">
            <span>Asosiy</span>
          </div>

          {visibleItems.map((item) => {
            const isActive = activeScreen === item.screen
            return (
              <button
                key={item.screen}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                className={`excel-sidebar-item app-sidebar__item ${isActive ? 'active is-active' : ''}`}
                onClick={() => onNavigate(item.screen)}
                type="button"
                title={item.label}
              >
                <span aria-hidden="true" style={{ display: 'flex', alignItems: 'center' }}>
                  {getScreenIcon(item.screen, isActive)}
                </span>
                <span style={{ flex: 1, fontWeight: isActive ? 700 : 500, fontSize: '12.5px' }}>
                  {item.label}
                </span>
                <span
                  aria-hidden="true"
                  className="app-sidebar__item-mark"
                  style={{
                    fontSize: '10.5px',
                    fontWeight: 700,
                    opacity: 0.6,
                    padding: '1px 5px',
                    borderRadius: 'var(--radius-xs)',
                    background: 'var(--bg-surface-subtle)'
                  }}
                >
                  {item.mark}
                </span>
              </button>
            )
          })}

          {/* Modellar Section */}
          {filteredModels.length > 0 && (
            <>
              <div className="excel-sidebar-section-title" style={{ marginTop: '10px' }}>
                <span>Modellar ({filteredModels.length})</span>
              </div>

              {filteredModels.map((m) => (
                <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                  <button
                    type="button"
                    className="excel-sidebar-item"
                    onClick={() => onNavigate('entry')}
                    style={{ paddingLeft: '14px', fontSize: '12px' }}
                    title={`${m.name} patta kiritish`}
                  >
                    <FileSpreadsheet size={13} color="#10b981" />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.name} (Patta)
                    </span>
                  </button>

                  <button
                    type="button"
                    className="excel-sidebar-item"
                    onClick={() => onNavigate('account')}
                    style={{ paddingLeft: '14px', fontSize: '12px', opacity: 0.85 }}
                    title={`${m.name} hisob varag'i`}
                  >
                    <Calculator size={13} color="#3b82f6" />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.name}-hisob
                    </span>
                  </button>
                </div>
              ))}
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="excel-sidebar-footer app-sidebar__footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span
              className="app-sidebar__footer-dot"
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: 'var(--status-success)'
              }}
            />
            <span>Mahalliy ma’lumotlar saqlanadi</span>
          </div>
          <span style={{ fontSize: '10px', opacity: 0.6 }}>Ctrl+B</span>
        </div>
      </aside>
    </>
  )
}
