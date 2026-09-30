import React, { useEffect, useState } from 'react'
import {
  Calendar,
  Users,
  Download,
  Database,
  Save,
  Sun,
  Moon,
  Building2,
  ShieldCheck
} from 'lucide-react'
import { Button } from './ui/Button'
import { StatusBadge } from './ui/StatusBadge'
import { RoleBadge } from './RoleBadge'

export type HeaderConnectivity = 'ONLINE' | 'OFFLINE' | 'AUTH_REQUIRED' | 'DEVICE_NOT_CONFIGURED' | null

export interface AppHeaderProps {
  pageTitle: string
  companyName: string
  userName: string
  connectivity: HeaderConnectivity
  unsyncedCount: number
  conflictCount: number
  syncing: boolean
  onSync(): void
  onLogout(): void
}

function connectivityPresentation(connectivity: HeaderConnectivity): { label: string; tone: 'success' | 'warning' | 'danger' } {
  if (connectivity === null) return { label: 'Holat aniqlanmoqda', tone: 'warning' }
  if (connectivity === 'ONLINE') return { label: 'Onlayn', tone: 'success' }
  if (connectivity === 'AUTH_REQUIRED' || connectivity === 'DEVICE_NOT_CONFIGURED') {
    return { label: connectivity === 'AUTH_REQUIRED' ? 'Kirish kerak' : 'Qurilma sozlanmagan', tone: 'danger' }
  }
  return { label: 'Oflayn', tone: 'warning' }
}

export function AppHeader({
  pageTitle,
  companyName,
  userName,
  connectivity,
  unsyncedCount,
  conflictCount,
  syncing,
  onSync,
  onLogout
}: AppHeaderProps): React.JSX.Element {
  const status = connectivityPresentation(connectivity)
  const syncLabel = syncing ? 'Sinxronlanmoqda…' : unsyncedCount > 0 ? `Sinxronlanmagan: ${unsyncedCount}` : 'Sinxronlandi'

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('textile_theme') as 'light' | 'dark') || 'light'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('textile_theme', theme)
  }, [theme])

  const toggleTheme = (): void => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
  }

  return (
    <header className="excel-titlebar app-header">
      {/* Left Quick Actions */}
      <div className="excel-title-left">
        <div className="quick-actions">
          {/* Period Button */}
          <button
            type="button"
            className="quick-btn"
            title="Oylik davri va oylik hisobot"
          >
            <Calendar size={14} color="#a7f3d0" />
            <span>Joriy Oylik</span>
          </button>

          {/* Workers Button */}
          <button
            type="button"
            className="quick-btn"
            title="Ishchilar ro'yxati"
          >
            <Users size={14} color="#a7f3d0" />
            <span>Ishchilar</span>
          </button>

          {/* Excel Export Button */}
          <button
            type="button"
            className="quick-btn"
            title="Excel (.xlsx) eksport qilish"
          >
            <Download size={14} />
          </button>

          {/* Database / Backup Button */}
          <button
            type="button"
            className="quick-btn"
            title="Zaxiralar va Baza holati"
          >
            <Database size={14} />
          </button>

          {/* Save / Sync Button */}
          <Button
            className="quick-btn"
            disabled={syncing || connectivity !== 'ONLINE'}
            onClick={onSync}
            type="button"
            style={{
              background: 'rgba(16, 185, 129, 0.22)',
              borderColor: 'rgba(52, 211, 153, 0.4)',
              color: '#6ee7b7'
            }}
            title="Server bilan sinxronlash (Ctrl+S)"
          >
            <Save size={14} color="#6ee7b7" />
            <span>{syncing ? 'Kuting…' : 'Sinxronlash'}</span>
          </Button>
        </div>
      </div>

      {/* Center Brand & Page Title */}
      <div className="excel-title-center">
        <Building2 size={15} color="#34d399" />
        <span className="app-header__company">{companyName}</span>
        <span style={{ opacity: 0.4, fontSize: '11px' }}>|</span>
        <span className="app-header__title" style={{ fontSize: '12px', color: '#a7f3d0', fontWeight: 600 }}>
          {pageTitle}
        </span>
      </div>

      {/* Right User & System Badges */}
      <div className="excel-title-right">
        {/* Dark / Light Toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          className="quick-btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '28px',
            height: '28px',
            background: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid rgba(255, 255, 255, 0.18)',
            borderRadius: 'var(--radius-full)',
            padding: 0,
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
            transition: 'all 0.2s'
          }}
          title={theme === 'dark' ? "Yorug' (Light) rejimga o'tish" : "Tungi (Dark) rejimga o'tish"}
        >
          {theme === 'dark' ? <Sun size={14} color="#fde047" /> : <Moon size={14} color="#cbd5e1" />}
        </button>

        {/* Role Badge */}
        <RoleBadge role="admin" />

        {/* Strict / Free Mode Indicator Badge */}
        <div
          title="Qat'iy tekshiruv rejimi: Model va partiya tekshiriladi"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            fontSize: '11px',
            fontWeight: 600,
            padding: '3px 9px',
            borderRadius: 'var(--radius-full)',
            background: 'rgba(16, 185, 129, 0.12)',
            border: '1px solid rgba(52, 211, 153, 0.3)',
            color: '#34d399',
            cursor: 'default',
            userSelect: 'none'
          }}
        >
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: '#10b981'
            }}
          />
          <span>Qat’iy</span>
        </div>

        {/* Real-time Connection Status */}
        <div className="app-header__status" style={{ display: 'flex', alignItems: 'center', gap: '6px' }} aria-live="polite">
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          <span className="app-header__sync-label" style={{ fontSize: '11px', fontWeight: 600, color: '#e2e8f0' }}>
            {syncLabel}
          </span>
          {conflictCount > 0 ? <StatusBadge tone="danger">Ziddiyat: {conflictCount}</StatusBadge> : null}
        </div>

        {/* License Badge */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '11.5px',
            background: 'rgba(16, 185, 129, 0.15)',
            border: '1px solid rgba(52, 211, 153, 0.35)',
            padding: '3px 9px',
            borderRadius: 'var(--radius-full)',
            cursor: 'default',
            fontWeight: 600,
            color: '#6ee7b7',
            backdropFilter: 'blur(8px)',
            userSelect: 'none'
          }}
          title="Litsenziya holati: Faol"
        >
          <ShieldCheck size={13} color="#6ee7b7" />
          <span>Litsenziya: Faol</span>
        </div>

        {/* User and Logout */}
        <div className="app-header__user" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '4px' }}>
          <span className="app-header__user-name" style={{ fontWeight: 600, fontSize: '12px', color: '#f8fafc' }}>
            {userName}
          </span>
          <Button
            className="app-header__logout"
            onClick={onLogout}
            type="button"
            variant="quiet"
            style={{
              fontSize: '11.5px',
              padding: '3px 10px',
              color: '#fca5a5',
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: 'var(--radius-full)'
            }}
          >
            Chiqish
          </Button>
        </div>
      </div>
    </header>
  )
}
