SAAS TEKSTIL ERP — ASCII ARCHITECTURE / WORKTREE
================================================


                         ┌─────────────────────────────┐
                         │        INTERNET / HTTPS      │
                         └──────────────┬──────────────┘
                                        │
                                        ▼
                         ┌─────────────────────────────┐
                         │            NGINX             │
                         │  TLS / Proxy / Rate Limit   │
                         └──────────────┬──────────────┘
                                        │
                ┌───────────────────────┴────────────────────────┐
                │                                                │
                ▼                                                ▼
┌──────────────────────────────┐                  ┌──────────────────────────────┐
│      PLATFORM ADMIN WEB      │                  │        NESTJS REST API       │
│ React + TypeScript           │                  │ NestJS + TypeScript          │
│                              │                  │                              │
│ Superadmin uchun             │                  │ /api/v1/...                  │
└───────────────┬──────────────┘                  └───────────────┬──────────────┘
                │                                                 │
                │                                                 │
                │                                  ┌──────────────┴──────────────┐
                │                                  │                             │
                │                                  ▼                             ▼
                │                     ┌───────────────────────┐       ┌─────────────────────┐
                │                     │   TENANT RESOLVER     │       │        REDIS        │
                │                     │                       │       │                     │
                │                     │ subdomain             │       │ Patta cache         │
                │                     │ + JWT company_id      │       │ optional perm cache │
                 │                     │ + company status      │       │ optional rate cache  │
                │                     └───────────┬───────────┘       └─────────────────────┘
                │                                 │
                │                                 ▼
                │                     ┌───────────────────────────┐
                │                     │ TENANT CONNECTION MANAGER │
                │                     │                           │
                │                     │ company_id                │
                │                     │      ↓                    │
                │                     │ TypeORM DataSource Pool   │
                │                     └────────────┬──────────────┘
                │                                  │
                ▼                                  │
┌──────────────────────────────┐                    │
│        MASTER DATABASE       │                    │
│        PostgreSQL 16         │                    │
│                              │                    │
│ companies                    │                    │
│ platform_users               │                    │
│ platform_roles               │                    │
│ platform_permissions         │                    │
│ devices                      │                    │
│ licenses                     │                    │
│ provisioning                 │                    │
│ migration status             │                    │
│                              │                    │
│ !!! PATTA YO'Q               │                    │
│ !!! WORKER YO'Q              │                    │
│ !!! PAYROLL YO'Q             │                    │
└──────────────────────────────┘                    │
                                                   │
                      ┌────────────────────────────┼────────────────────────────┐
                      │                            │                            │
                      ▼                            ▼                            ▼
          ┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
          │ TENANT DB — FACTORY A│    │ TENANT DB — FACTORY B│    │ TENANT DB — FACTORY C│
          │ PostgreSQL 16        │    │ PostgreSQL 16        │    │ PostgreSQL 16        │
          │                      │    │                      │    │                      │
          │ users                │    │ users                │    │ users                │
          │ roles                │    │ roles                │    │ roles                │
          │ permissions          │    │ permissions          │    │ permissions          │
          │ workers              │    │ workers              │    │ workers              │
          │ badge_history        │    │ badge_history        │    │ badge_history        │
          │ models               │    │ models               │    │ models               │
          │ operations           │    │ operations           │    │ operations           │
          │ operation_prices     │    │ operation_prices     │    │ operation_prices     │
          │ patta_templates      │    │ patta_templates      │    │ patta_templates      │
          │ patta_hisob          │    │ patta_hisob          │    │ patta_hisob          │
          │ patta_snapshots      │    │ patta_snapshots      │    │ patta_snapshots      │
          │ patta_sheets         │    │ patta_sheets         │    │ patta_sheets         │
          │ patta_sheet_rows     │    │ patta_sheet_rows     │    │ patta_sheet_rows     │
          │ number_blocks        │    │ number_blocks        │    │ number_blocks        │
          │ payroll_periods      │    │ payroll_periods      │    │ payroll_periods      │
          │ payroll_adjustments  │    │ payroll_adjustments  │    │ payroll_adjustments  │
          │ processed_events     │    │ processed_events     │    │ processed_events     │
          │ server_change_log    │    │ server_change_log    │    │ server_change_log    │
          │ audit_log            │    │ audit_log            │    │ audit_log            │
          └──────────────────────┘    └──────────────────────┘    └──────────────────────┘



DESKTOP WORKSTATIONS
====================

                 FACTORY A
                    │
       ┌────────────┼────────────┐
       │            │            │
       ▼            ▼            ▼

┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│     PC-1     │ │     PC-2     │ │     PC-3     │
│              │ │              │ │              │
│ Electron     │ │ Electron     │ │ Electron     │
│ React        │ │ React        │ │ React        │
│ TypeScript   │ │ TypeScript   │ │ TypeScript   │
│ SQLite       │ │ SQLite       │ │ SQLite       │
│              │ │              │ │              │
│ NO LAN       │ │ NO LAN       │ │ NO LAN       │
│ NO SERVER    │ │ NO SERVER    │ │ NO SERVER    │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                 │                 │
       │ HTTPS           │ HTTPS           │ HTTPS
       └─────────────────┼─────────────────┘
                         │
                         ▼
                  ┌──────────────┐
                  │  NGINX/API   │
                  └──────┬───────┘
                         │
                         ▼
                 TENANT DB FACTORY A



EACH DESKTOP
============

┌──────────────────────────────────────────────────────────────────┐
│                         ELECTRON DESKTOP                          │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    REACT RENDERER                           │  │
│  │                                                            │  │
│  │  Login                                                     │  │
│  │  Bosh sahifa                                               │  │
│  │  Patta chiqarish                                           │  │
│  │  Patta hisob                                               │  │
│  │  Patta varag'i                                             │  │
│  │  Ishchilar                                                 │  │
│  │  Jeton tarixi                                              │  │
│  │  Model / operatsiyalar                                     │  │
│  │  Hisobot                                                   │  │
│  │  Sozlamalar                                                │  │
│  │                                                            │  │
│  │  nodeIntegration = false                                   │  │
│  └─────────────────────────┬──────────────────────────────────┘  │
│                            │ typed IPC                            │
│                            ▼                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                 PRELOAD SAFE API                           │  │
│  └─────────────────────────┬──────────────────────────────────┘  │
│                            │                                      │
│                            ▼                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                  ELECTRON MAIN                             │  │
│  │                                                            │  │
│  │  SQLiteService                                             │  │
│  │  SyncService                                               │  │
│  │  LicenseService                                            │  │
│  │  DeviceService                                             │  │
│  │  NetworkService                                            │  │
│  │  SecureStorageService                                      │  │
│  └─────────────────────────┬──────────────────────────────────┘  │
│                            │                                      │
│             ┌──────────────┴──────────────┐                      │
│             │                             │                      │
│             ▼                             ▼                      │
│  ┌───────────────────────┐    ┌─────────────────────────────┐   │
│  │        SQLITE         │    │       OS SECURE STORE       │   │
│  │                       │    │                             │   │
│  │ workers               │    │ refresh token               │   │
│  │ badge_history         │    │ device secret               │   │
│  │ models                │    │ sensitive credentials       │   │
│  │ operations            │    └─────────────────────────────┘   │
│  │ patta_hisob           │                                      │
│  │ patta_snapshots       │                                      │
│  │ patta_sheets          │                                      │
│  │ patta_sheet_rows      │                                      │
│  │ number_blocks         │                                      │
│  │ sync_queue            │                                      │
│  │ sync_state            │                                      │
│  │ sync_conflicts        │                                      │
│  └───────────────────────┘                                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘



OFFLINE-FIRST DATA FLOW
=======================

             USER
               │
               ▼
      ┌─────────────────────┐
      │ Desktop operatsiya  │
      │                     │
      │ Patta / Sheet / Row │
      └──────────┬──────────┘
                 │
                 ▼
      ┌─────────────────────┐
      │   SQLite WRITE      │
      └──────────┬──────────┘
                 │
                 ├─────────────────────────┐
                 │                         │
                 ▼                         ▼
      ┌─────────────────────┐   ┌──────────────────────┐
      │ Business local data │   │      sync_queue      │
      │ saqlanadi           │   │                      │
      │                     │   │ event_id UUID        │
      └─────────────────────┘   │ PENDING              │
                                └──────────┬───────────┘
                                           │
                              Internet bormi?
                                  │       │
                               YO'Q       HA
                                  │       │
                                  │       ▼
                                  │  ┌─────────────────┐
                                  │  │    PUSH SYNC    │
                                  │  │                 │
                                  │  │ Desktop → VPS   │
                                  │  └────────┬────────┘
                                  │           │
                                  │           ▼
                                  │  ┌──────────────────────┐
                                  │  │ processed_sync_events│
                                  │  │                      │
                                  │  │ event_id mavjudmi?   │
                                  │  └────────┬───────┬─────┘
                                  │           │       │
                                  │          HA      YO'Q
                                  │           │       │
                                  │           │       ▼
                                  │           │  Business write
                                  │           │       │
                                  │           │       ▼
                                  │           │ server_change_log
                                  │           │
                                  │           ▼
                                  │      oldingi natija
                                  │
                                  └── operator ishni davom ettiradi



TWO-WAY SYNC
============

                ┌───────────────────────┐
                │      DESKTOP PC       │
                └───────────┬───────────┘
                            │
                  ┌─────────┴─────────┐
                  │                   │
                  ▼                   ▼
             PUSH SYNC            PULL SYNC
                  │                   │
                  ▼                   │
        ┌──────────────────┐          │
        │ Pending events   │          │
        │ PC → SERVER      │          │
        └────────┬─────────┘          │
                 │                    │
                 ▼                    │
        ┌──────────────────┐          │
        │ Tenant PostgreSQL│          │
        └────────┬─────────┘          │
                 │                    │
                 ▼                    │
        ┌──────────────────┐          │
        │server_change_log │──────────┘
        └──────────────────┘

Pull:

    cursor=1520
        │
        ▼
    sequence_id > 1520
        │
        ▼
    batch 500
        │
        ▼
    SQLite transaction
        │
        ▼
    SUCCESS
        │
        ▼
    cursor = last sequence_id



EXAMPLE — PC-1 → PC-2
=====================

PC-1
 │
 │ Patta 1057 yaratadi
 ▼
SQLite
 │
 ▼
sync_queue
 │
 │ internet qaytdi
 ▼
VPS / Tenant DB
 │
 │ server_change_log
 ▼
sequence_id = 5011
 │
 │
 │                     PC-2
 │                       │
 └───────────────────────┤ PULL cursor > 5000
                         │
                         ▼
                    Patta 1057
                         │
                         ▼
                       SQLite
                         │
                     internet
                      uziladi
                         │
                         ▼
                Patta 1057 baribir
                   lokal topiladi



PATTA NUMBER BLOCK FLOW
=======================

                    SERVER
                      │
              ┌───────┴───────┐
              │ Number        │
              │ Allocator     │
              └───────┬───────┘
                      │
        PostgreSQL transaction / lock
                      │
          ┌───────────┼───────────┐
          │           │           │
          ▼           ▼           ▼
       PC-1         PC-2         PC-3
    1000-1999    2000-2999    3000-3999


PC-1 OFFLINE:

    current block
       │
       ▼
  1000 ........ 1799
                   │
                   │ 80%
                   ▼
        internet mavjudmi?
            │          │
           HA         YO'Q
            │          │
            ▼          │
       next block      │
       so'raladi       │
                       │
                       ▼
              current block bilan
              ishlash davom etadi


CURRENT + NEXT:

    current = 1000-1999
    next    = 4000-4999

Current tugasa:

    next → current

Ikkalasi tugasa + internet yo'q:

    YANGI PATTA YARATISH = BLOK

Lekin mavjud Pattalar bilan ishlash = DAVOM ETADI



BADGE / WORKER HISTORY
======================

                 JISMONIY JETON 125
                        │
              ┌─────────┴─────────┐
              │                   │
              ▼                   ▼

      2026-01-01            2026-05-16
          │                     │
          ▼                     ▼
      Worker 18              Worker 47
  Abdullayeva Nodira       Karimov Jasur
          │
          │
          ▼
  eski Patta rows
  worker_id = 18
          │
          │ Jeton keyin Worker 47 ga berilsa ham
          ▼
     O'ZGARMAYDI


Resolution:

  badge_number
       +
  performed_at
       │
       ▼
 worker_badge_history
       │
       ▼
   worker_id
       │
       ▼
 patta_sheet_rows.worker_id



OFFLINE BADGE VALIDATION
========================

DESKTOP:

 Jeton = 125
 performed_at = 2026-04-10
       │
       ▼
 Local badge history
       │
       ▼
 worker_id = 18
       │
       ▼
 UI:
 Abdullayeva Nodira


SYNC PAYLOAD:

 badge_number_input      = 125
 performed_at            = 2026-04-10
 client_resolved_worker  = 18
                │
                ▼
             SERVER
                │
                ▼
 server badge history resolve
                │
          ┌─────┴─────┐
          │           │
        = 18        != 18
          │           │
          ▼           ▼
       ACCEPT      CONFLICT
                    │
                    ▼
          CONFLICT_BADGE_ASSIGNMENT



PRICE HISTORY
=============

Model operation:

       "Yeng tikish"
             │
     ┌───────┴─────────┐
     │                 │
     ▼                 ▼
 Sentabr             Noyabr
1 000 so'm          1 200 so'm
     │
     ▼
Patta 1057 yaratiladi
     │
     ▼
patta_operation_snapshot

 operation_name_snapshot = "Yeng tikish"
 unit_price_snapshot      = 1 000 so'm

     │
     │ Noyabrda narx o'zgarsa
     ▼

ESKI PATTA:
1 000 so'm

YANGI PATTA:
1 200 so'm



PATTA SHEET LIFECYCLE
=====================

                ┌────────────┐
                │   CREATE   │
                └─────┬──────┘
                      │
                      ▼
                ┌────────────┐
                │   DRAFT    │
                └─────┬──────┘
                      │
              edit / rows / defect
                      │
                      ▼
                ┌────────────┐
                │ FINALIZE   │
                └─────┬──────┘
                      │
                      ▼
                ┌────────────┐
                │ FINALIZED  │
                └─────┬──────┘
                      │
          ordinary edit = BLOCKED
                      │
          patta_varaq.reopen
                      │
                      ▼
                ┌────────────┐
                │   DRAFT    │
                └────────────┘

Every reopen:
        │
        ▼
    audit_log



PAYROLL FLOW
============

patta_sheet_rows
       │
       │
       │ worker_id
       │ soni
       │ unit_price_snapshot
       ▼

   row amount
       =
     soni
       ×
 unit_price_snapshot
       │
       ▼
┌──────────────────────┐
│ GROUP BY worker_id   │
└──────────┬───────────┘
           │
           ▼
   Ishbay summa
           │
           ├──────── + BONUS
           │
           └──────── - PENALTY
           │
           ▼
          JAMI


NOT ALLOWED:

 GROUP BY full_name       X
 GROUP BY badge_number    X



PAYROLL PERIOD
==============

      2026 / SENTABR
            │
            ▼
       ┌──────────┐
       │   OPEN   │
       └────┬─────┘
            │
        hisob-kitob
            │
            ▼
       ┌──────────┐
       │  CLOSE   │
       └────┬─────┘
            │
            ▼
       ┌──────────┐
       │  CLOSED  │
       └──────────┘
            │
            ▼
 tarixiy ma'lumotni
 oddiy edit qilish
      TAQIQLANADI



LICENSE FLOW
============

                      SERVER
                        │
                        ▼
              ┌──────────────────┐
              │ License payload  │
              └────────┬─────────┘
                       │
                  Ed25519 sign
                       │
                       ▼
              ┌──────────────────┐
              │ Signed license   │
              └────────┬─────────┘
                       │
                       ▼
                    DESKTOP
                       │
         ┌─────────────┴──────────────┐
         │                            │
         ▼                            ▼
    Public key                 Hardware fingerprint
         │                            │
         └─────────────┬──────────────┘
                       │
                       ▼
                Local verification
                       │
          ┌────────────┴────────────┐
          │                         │
        valid                     invalid
          │                         │
          ▼                         ▼
      APP OPEN                 PROTECTED/BLOCKED


Internet bo'lsa har 7 kunda:

Desktop
   │
   ▼
VPS license validation
   │
   ├── ACTIVE
   ├── REVOKED
   └── EXPIRED



RBAC BOUNDARY
=============

┌──────────────────────── PLATFORM ────────────────────────────┐

 Superadmin
     │
     ├── companies.view
     ├── companies.create
     ├── companies.suspend
     ├── companies.migrate
     ├── licenses.view
     ├── licenses.create
     ├── licenses.revoke
     └── platform_users.manage

                         X

     patta.*
     workers.*
     payroll.*
     reports.*

└──────────────────────────────────────────────────────────────┘


┌──────────────────────── TENANT ──────────────────────────────┐

 Korxona admin
     │
     ├── models.manage
     ├── workers.manage
     ├── workers.badge.manage
     ├── roles.manage
     ├── users.manage
     ├── reports.view
     └── license.view

                         X

     companies.create
     companies.suspend
     licenses.revoke
     platform_users.manage

└──────────────────────────────────────────────────────────────┘



TENANT SECURITY REQUEST FLOW
============================

Request:
factory-a.erp.example.com
        │
        ▼
 subdomain = factory-a
        │
        ▼
Master DB lookup
        │
        ▼
company_id = A
        │
        ▼
JWT
 company_id = ?
        │
   ┌────┴────┐
   │         │
   A         B
   │         │
   ▼         ▼
 ACCEPT    403
   │
   ▼
TenantConnectionManager
   │
   ▼
Factory A PostgreSQL



NEW COMPANY PROVISIONING
========================

Superadmin
    │
    ▼
"Yangi korxona"
    │
    ▼
┌──────────────┐
│  REQUESTED   │
└──────┬───────┘
       ▼
┌────────────────────┐
│ CREATING_DATABASE  │
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ RUNNING_MIGRATIONS │
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ SEEDING_PERMISSIONS│
└─────────┬──────────┘
          ▼
┌────────────────────────┐
│ CREATING_DEFAULT_ADMIN │
└───────────┬────────────┘
            ▼
      ┌────────────┐
      │   ACTIVE   │
      └────────────┘


Any step fails:

       ▼
┌────────────┐
│   FAILED   │
├────────────┤
│ step       │
│ reason     │
└────────────┘



PROJECT WORKTREE
================

saas-textile-erp/
│
├── apps/
│   │
│   ├── api/
│   │   │
│   │   ├── src/
│   │   │   │
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   │
│   │   │   ├── config/
│   │   │   │   ├── app.config.ts
│   │   │   │   ├── database.config.ts
│   │   │   │   ├── redis.config.ts
│   │   │   │   └── license.config.ts
│   │   │   │
│   │   │   ├── common/
│   │   │   │   ├── decorators/
│   │   │   │   ├── guards/
│   │   │   │   ├── filters/
│   │   │   │   ├── interceptors/
│   │   │   │   ├── pipes/
│   │   │   │   └── errors/
│   │   │   │
│   │   │   ├── master/
│   │   │   │   │
│   │   │   │   ├── companies/
│   │   │   │   ├── platform-auth/
│   │   │   │   ├── platform-users/
│   │   │   │   ├── platform-rbac/
│   │   │   │   ├── devices/
│   │   │   │   ├── licenses/
│   │   │   │   ├── provisioning/
│   │   │   │   └── migrations/
│   │   │   │
│   │   │   ├── tenant/
│   │   │   │   │
│   │   │   │   ├── tenant-resolver/
│   │   │   │   ├── tenant-connection/
│   │   │   │   │
│   │   │   │   ├── auth/
│   │   │   │   ├── rbac/
│   │   │   │   ├── users/
│   │   │   │   ├── workers/
│   │   │   │   ├── badges/
│   │   │   │   ├── models/
│   │   │   │   ├── operations/
│   │   │   │   ├── operation-prices/
│   │   │   │   ├── patta-templates/
│   │   │   │   ├── patta-number-blocks/
│   │   │   │   ├── patta/
│   │   │   │   ├── patta-sheets/
│   │   │   │   ├── sync/
│   │   │   │   │   ├── push/
│   │   │   │   │   ├── pull/
│   │   │   │   │   ├── idempotency/
│   │   │   │   │   └── conflicts/
│   │   │   │   ├── payroll/
│   │   │   │   ├── reports/
│   │   │   │   └── audit/
│   │   │   │
│   │   │   └── infrastructure/
│   │   │       ├── redis/
│   │   │       ├── logging/
│   │   │       └── health/
│   │   │
│   │   └── test/
│   │
│   │
│   ├── desktop/
│   │   │
│   │   ├── src/
│   │   │   │
│   │   │   ├── main/
│   │   │   │   ├── main.ts
│   │   │   │   ├── database/
│   │   │   │   │   ├── sqlite.ts
│   │   │   │   │   ├── migrations/
│   │   │   │   │   └── repositories/
│   │   │   │   │
│   │   │   │   ├── sync/
│   │   │   │   │   ├── sync-engine.ts
│   │   │   │   │   ├── push.ts
│   │   │   │   │   ├── pull.ts
│   │   │   │   │   ├── queue.ts
│   │   │   │   │   ├── conflict.ts
│   │   │   │   │   └── retry.ts
│   │   │   │   │
│   │   │   │   ├── license/
│   │   │   │   │   ├── verifier.ts
│   │   │   │   │   ├── device.ts
│   │   │   │   │   └── trusted-time.ts
│   │   │   │   │
│   │   │   │   ├── secure-storage/
│   │   │   │   ├── network/
│   │   │   │   └── ipc/
│   │   │   │
│   │   │   ├── preload/
│   │   │   │   └── index.ts
│   │   │   │
│   │   │   └── renderer/
│   │   │       │
│   │   │       ├── app/
│   │   │       ├── pages/
│   │   │       │   ├── login/
│   │   │       │   ├── dashboard/
│   │   │       │   ├── patta-chiqarish/
│   │   │       │   ├── patta-hisob/
│   │   │       │   ├── patta-varaq/
│   │   │       │   ├── workers/
│   │   │       │   ├── badges/
│   │   │       │   ├── models/
│   │   │       │   ├── roles/
│   │   │       │   ├── reports/
│   │   │       │   └── license/
│   │   │       │
│   │   │       ├── components/
│   │   │       │   ├── spreadsheet/
│   │   │       │   ├── sync-status/
│   │   │       │   └── form/
│   │   │       │
│   │   │       ├── hooks/
│   │   │       ├── state/
│   │   │       └── utils/
│   │   │
│   │   └── test/
│   │
│   │
│   └── platform-admin/
│       │
│       └── src/
│           ├── pages/
│           │   ├── login/
│           │   ├── companies/
│           │   ├── provisioning/
│           │   ├── migrations/
│           │   ├── devices/
│           │   └── licenses/
│           │
│           ├── components/
│           └── api/
│
│
├── packages/
│   │
│   ├── shared-types/
│   │   ├── auth/
│   │   ├── patta/
│   │   ├── workers/
│   │   ├── sync/
│   │   └── license/
│   │
│   ├── validation/
│   │
│   ├── sync-protocol/
│   │   ├── events.ts
│   │   ├── conflicts.ts
│   │   └── schemas.ts
│   │
│   ├── ui/
│   │
│   ├── eslint-config/
│   │
│   └── tsconfig/
│
│
├── database/
│   │
│   ├── master-migrations/
│   │
│   ├── tenant-migrations/
│   │
│   ├── seeds/
│   │   ├── platform-permissions/
│   │   └── tenant-permissions/
│   │
│   └── tests/
│
│
├── infrastructure/
│   │
│   ├── docker/
│   │   ├── api.Dockerfile
│   │   └── platform-admin.Dockerfile
│   │
│   ├── nginx/
│   │   └── nginx.conf
│   │
│   ├── postgres/
│   │
│   ├── redis/
│   │
│   └── docker-compose.yml
│
│
├── docs/
│   ├── architecture.md
│   ├── database.md
│   ├── tenant-provisioning.md
│   ├── sync-protocol.md
│   ├── rbac.md
│   ├── license.md
│   ├── deployment.md
│   ├── backup-restore.md
│   └── testing.md
│
│
├── scripts/
│   ├── provision-tenant.ts
│   ├── migrate-tenants.ts
│   ├── seed-permissions.ts
│   └── backup-tenant.ts
│
├── .env.example
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md



DEVELOPMENT WORKTREE / ROADMAP
==============================

[0] FOUNDATION
 │
 ├── Monorepo
 ├── Docker
 ├── Config
 ├── Logging
 ├── Error format
 ├── Master migration infra
 └── Tenant migration infra
 │
 ▼
[1] MASTER + PROVISIONING
 │
 ├── Companies
 ├── New tenant DB
 ├── Migration
 ├── Seed
 ├── Default admin
 └── Tenant connection manager
 │
 ▼
[2] AUTH + RBAC
 │
 ├── JWT
 ├── Refresh
 ├── Offline capability
 ├── Roles
 ├── Permissions
 └── Guards
 │
 ▼
[3] MODEL + OPERATIONS
 │
 ├── Models
 ├── Operations
 └── Price history
 │
 ▼
[4] WORKERS + BADGES
 │
 ├── Worker ID
 ├── Badge history
 └── Interval constraints
 │
 ▼
[5] PATTA
 │
 ├── Templates
 ├── Number blocks
 ├── Patta chiqarish
 ├── Patta hisob
 └── Operation snapshots
 │
 ▼
[6] OFFLINE ENGINE
 │
 ├── SQLite
 ├── sync_queue
 ├── PUSH
 ├── Idempotency
 ├── Change log
 ├── PULL
 ├── Cursor
 ├── Retry
 └── Conflict
 │
 ▼
[7] PATTA VARAG'I
 │
 ├── Local-first lookup
 ├── Badge → Worker
 ├── Excel keyboard flow
 ├── Defect
 ├── Delete
 ├── Finalize
 └── Offline sync
 │
 ▼
[8] LICENSE
 │
 ├── Ed25519
 ├── Hardware bind
 ├── Local verify
 ├── 7-day revalidation
 ├── Revoke
 ├── Grace
 └── Device rebind
 │
 ▼
[9] ADMIN
 │
 ├── Tenant admin
 └── Platform admin
 │
 ▼
[10] PAYROLL + REPORTS
     │
     ├── Payroll periods
     ├── Worker payroll
     ├── Bonus
     ├── Penalty
     ├── Model report
     ├── Partiya report
     ├── Defect report
     └── Period close



FINAL SYSTEM PRINCIPLE
======================


                         MASTER
                           │
                 SaaS boshqaruvi
                           │
       ┌───────────────────┴───────────────────┐
       │                                       │
       ▼                                       ▼
 Tenant A DB                              Tenant B DB
       │                                       │
 ┌─────┼─────┐                           ┌─────┼─────┐
 │     │     │                           │     │     │
PC1   PC2   PC3                         PC1   PC2   PC3
 │     │     │                           │     │     │
SQLite SQLite SQLite                    SQLite SQLite SQLite
 │     │     │                           │     │     │
 └─────┼─────┘                           └─────┼─────┘
       │                                       │
       ▼                                       ▼
    HTTPS                                   HTTPS
       │                                       │
       └──────────────── API ──────────────────┘


          NO LAN
          NO LOCAL SERVER
          OFFLINE-FIRST
          DATABASE-PER-TENANT
          TWO-WAY SYNC
          IMMUTABLE WORKER HISTORY
          IMMUTABLE PRICE HISTORY
          DEVICE LICENSE
          STRICT RBAC
