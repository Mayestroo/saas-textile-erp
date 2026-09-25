# SaaS tekstil ERP — Architecture & Implementation Spec v2

Quyidagi tizimni noldan production darajasida qur.

Bu tekstil fabrikalari uchun **ishlab chiqarish hisobi SaaS ERP tizimi** bo‘ladi. Asosiy funksiyalar:

* Patta chiqarish
* Patta hisob
* Patta varag‘i
* Ishchilar
* Jeton tarixi
* Model va operatsiyalar
* Ishbay ish haqi
* Nuqson hisobi
* Oylik hisobot
* Rollar va ruxsatlar
* Qurilma litsenziyasi
* Offline-first desktop ishlash
* Database-per-tenant
* Superadmin SaaS boshqaruvi

Ushbu hujjatdagi barcha talablar majburiy.

Talablarni o‘zboshimchalik bilan soddalashtirma, birlashtirma yoki tashlab ketma.

Har bir modulni alohida **ishlaydigan, migratsiyasi, testlari va UI oqimi tugallangan holatda** yakunla. Keyingi modulga faqat oldingi modul ishlaydigan holatga kelgandan keyin o‘t.

---

# 0. QAT’IY ARXITEKTURA QOIDALARI

Quyidagi invariantlar butun loyiha davomida buzilmasligi kerak.

### 0.1 Tenant izolyatsiyasi

Har bir korxona uchun alohida PostgreSQL database bo‘ladi.

Bir korxonaning:

* Pattalari
* ishchilari
* ish haqi
* modellari
* operatsiyalari
* foydalanuvchilari
* hisobotlari

boshqa korxona bazasiga hech qachon aralashmasligi kerak.

Bitta umumiy **Master Database** faqat SaaS boshqaruvi uchun ishlatiladi.

Master Database ichida ishlab chiqarish ma’lumotlari saqlanmaydi.

---

### 0.2 Superadmin tenant ma’lumotlariga kira olmaydi

Superadmin:

* korxona yaratishi;
* korxonani faollashtirishi/bloklashi;
* litsenziyalarni boshqarishi;
* database provisioning holatini ko‘rishi;
* migratsiya holatini ko‘rishi mumkin.

Lekin Superadmin UI va API orqali:

* Patta;
* Patta varag‘i;
* ishchilar maoshi;
* ishlab chiqarish hisobotlari

kabi tenant operatsion ma’lumotlarini ko‘rmasligi kerak.

Platforma RBAC va Tenant RBAC butunlay ajratiladi.

---

### 0.3 `worker_id` tarixiy identifikator

`workers.id`:

* avtomatik raqam;
* `BIGINT`;
* hech qachon qayta ishlatilmaydi;
* ishchining butun tarix davomida asosiy identifikatori.

Hisobotlar va hisob-kitoblarda:

```text
GROUP BY worker_id
```

ishlatiladi.

Quyidagilar bo‘yicha hech qachon hisob-kitob qilinmaydi:

```text
full_name
badge_number
```

Ism-familiya faqat `JOIN` orqali ko‘rsatish uchun olinadi.

---

### 0.4 Jeton — worker ID emas

Jismoniy jeton qayta ishlatilishi mumkin.

Masalan:

```text
Jeton 125
2026-01-01 → 2026-05-15 = Worker 18
2026-05-16 → ...        = Worker 47
```

Eski yozuvlar Worker 18 da qolishi kerak.

Jeton yangi ishchiga berilgani sabab tarix o‘zgarmasligi kerak.

---

### 0.5 Tarixiy narx o‘zgarmaydi

Model operatsiyasining narxi keyinchalik o‘zgartirilsa:

```text
sentabr: 1 000 so‘m
noyabr:  1 200 so‘m
```

sentabrdagi ishlab chiqarish qayta ochilganda ham 1 000 so‘mlik tarix saqlanadi.

Eski ishlarni hozirgi `model_operations.price` orqali qayta hisoblash taqiqlanadi.

---

### 0.6 Offline operatsiyalar idempotent

Desktop bir sync eventni internet muammosi sabab:

```text
1 marta
5 marta
50 marta
```

serverga yuborsa ham server uni faqat bir marta qo‘llashi kerak.

Har bir sync operatsiyada global unique:

```text
event_id UUID
```

bo‘lishi shart.

---

### 0.7 Offline sync ikki tomonlama

Faqat:

```text
PC → Server
```

emas.

Majburiy:

```text
PC → Server
Server → PC
```

bo‘lishi kerak.

PC-1 yaratgan Patta serverga tushgandan so‘ng PC-2 internetda bo‘lsa uni o‘z SQLite bazasiga olib tushadi.

Shundan keyin PC-2 internet uzilganda ham Pattani topa oladi.

---

### 0.8 Redis source of truth emas

Redis faqat cache.

Haqiqiy ma’lumot manbalari:

```text
PostgreSQL
+
Desktop SQLite
```

Redis yo‘q bo‘lsa ham tizim to‘g‘ri ishlashi kerak.

---

# 1. TEXNOLOGIK STACK

Loyihani quyidagi baseline bilan boshlash.

## Backend

```text
Node.js:       24.21.0 LTS
NestJS:        12.1.0
TypeScript:    6.0.x
TypeORM:       1.1.1
PostgreSQL:    16.15
Redis:         8.10.2
jose:          6.2.12
@noble/ed25519: 3.2.0
```

TypeScript 7 alohida compatibility branch orqali tekshirilmaguncha production branchga o‘tkazilmasin.

## Desktop

```text
Electron:        44.4.3
React:           19.3.0
TypeScript:      6.0.x
better-sqlite3:  13.0.3
```

## Infrastructure

```text
Docker Compose
Nginx 1.30.5 stable
PostgreSQL
Redis
NestJS backend
```

Dependency versiyalarini `package-lock.json` yoki boshqa lockfile orqali pin qilish.

Production image uchun `latest` tag ishlatmaslik.

---

# 2. REPOSITORY STRUKTURASI

Monorepo ishlat.

Tavsiya qilingan struktura:

```text
/apps
    /api
    /desktop
    /platform-admin

/packages
    /shared-types
    /validation
    /sync-protocol
    /ui
    /eslint-config
    /tsconfig

/infrastructure
    /docker
    /nginx
    /postgres
    /redis

/database
    /master-migrations
    /tenant-migrations
    /seeds

/docs
    architecture.md
    sync-protocol.md
    permissions.md
    license.md
    deployment.md
```

`platform-admin` — Superadmin uchun web panel.

`desktop` — korxona ish stansiyasi va korxona admin paneli.

---

# 3. MASTER DATABASE

Master Database faqat platforma boshqaruvi uchun.

## `companies`

```text
id UUID PK
name VARCHAR NOT NULL
slug VARCHAR UNIQUE NOT NULL
status ENUM(
    PROVISIONING,
    ACTIVE,
    SUSPENDED,
    FAILED,
    ARCHIVED
)
db_name VARCHAR UNIQUE
db_connection_ciphertext TEXT
schema_version VARCHAR
timezone VARCHAR DEFAULT 'Asia/Tashkent'
provisioning_status VARCHAR
last_migration_at TIMESTAMPTZ
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

Raw PostgreSQL password yoki connection string oddiy matn ko‘rinishida saqlanmasin.

Connection information server secret orqali shifrlansin.

Desktopga database credentials hech qachon yuborilmasin.

---

## `platform_users`

```text
id UUID PK
email CITEXT UNIQUE
password_hash TEXT
status VARCHAR
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

---

## `platform_roles`

```text
id UUID PK
name VARCHAR UNIQUE
```

---

## `platform_permissions`

Masalan:

```text
companies.view
companies.create
companies.suspend
companies.migrate

licenses.view
licenses.create
licenses.revoke

platform_users.manage
```

Platform permission ichida:

```text
patta.*
workers.*
payroll.*
reports.*
```

bo‘lmasligi kerak.

---

## `platform_role_permissions`

```text
role_id FK
permission_id FK

UNIQUE(role_id, permission_id)
```

---

## `platform_user_roles`

```text
user_id FK
role_id FK
```

---

# 4. DEVICE VA LICENSE MASTER JADVALLARI

## `devices`

```text
id UUID PK
company_id UUID FK
installation_id UUID UNIQUE
hardware_fingerprint_hash TEXT
device_name VARCHAR
status ENUM(ACTIVE, BLOCKED, REPLACED)
first_seen_at TIMESTAMPTZ
last_seen_at TIMESTAMPTZ
created_at TIMESTAMPTZ
```

Hardware ID uchun faqat MAC address ishlatmaslik.

Fingerprint bir nechta barqaror hardware komponentlardan hisoblanishi kerak.

Raw hardware qiymatlarini imkon qadar serverda saqlamaslik, hash saqlash.

---

## `licenses`

```text
id UUID PK
company_id UUID FK
device_id UUID FK
signed_license TEXT
issued_at TIMESTAMPTZ
valid_until TIMESTAMPTZ
offline_grace_until TIMESTAMPTZ
status ENUM(ACTIVE, REVOKED, EXPIRED)
revoked_at TIMESTAMPTZ NULL
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

---

# 5. TENANT DATABASE PROVISIONING

Yangi korxona yaratilganda provisioning state machine ishlasin.

```text
REQUESTED
↓
CREATING_DATABASE
↓
RUNNING_MIGRATIONS
↓
SEEDING_PERMISSIONS
↓
CREATING_DEFAULT_ADMIN
↓
ACTIVE
```

Xato bo‘lsa:

```text
FAILED
```

holatida:

```text
failure_step
failure_reason
```

saqlansin.

Provisioning qayta ishga tushirilganda bajarilgan bosqichlarni buzmasdan davom eta olishi kerak.

---

## Yangi tenant yaratish algoritmi

1. Master `companies` row yarat.
2. Xavfsiz database nomi generatsiya qil.
3. PostgreSQL database yarat.
4. Tenant migrationlarni ishga tushir.
5. Permission katalogini seed qil.
6. Default `Korxona administratori` rolini yarat.
7. Birinchi administratorni yarat.
8. Schema versionni Master DBga yoz.
9. Company statusni `ACTIVE` qil.

Database yaratishda foydalanuvchi yuborgan nomni to‘g‘ridan-to‘g‘ri SQL identifier sifatida ishlatma.

---

# 6. TENANT CONNECTION MANAGER

Har HTTP request uchun yangi database connection ochma.

NestJS ichida:

```text
TenantConnectionManager
```

yarat.

U:

```text
company_id → TypeORM DataSource
```

poollarini boshqarsin.

Idle DataSource'lar TTL/LRU orqali yopilishi mumkin.

---

## Tenant aniqlash

Request:

```text
factory1.erp.example.com
```

bo‘lsa:

```text
factory1
```

slug olinadi.

Keyin:

1. Master DBdan company topiladi.
2. Company `ACTIVE` ekanligi tekshiriladi.
3. JWT ichidagi `company_id` tekshiriladi.
4. JWT kompaniyasi va subdomain kompaniyasi teng bo‘lishi shart.
5. To‘g‘ri tenant DataSource olinadi.

Mos kelmasa:

```text
403 Forbidden
```

---

## Qat’iy qoida

Client yuborgan:

```json
{
  "tenant_id": "..."
}
```

qiymatiga o‘z-o‘zidan ishonilmaydi.

Tenant identifikatsiyasi authenticated contextdan olinadi.

---

# 7. TENANT DATABASE — USERS VA RBAC

## `users`

```text
id UUID PK
email CITEXT UNIQUE NOT NULL
password_hash TEXT NOT NULL
role_id UUID FK
status ENUM(ACTIVE, BLOCKED)
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

Password uchun Argon2id ishlat.

---

## `roles`

```text
id UUID PK
company_id UUID NOT NULL
name VARCHAR NOT NULL
is_system BOOLEAN DEFAULT false
created_at TIMESTAMPTZ

UNIQUE(company_id, name)
```

Tenant DBda Superadmin role bo‘lmaydi.

---

## `permissions`

Permission katalogi system seed orqali yaratiladi.

Masalan:

```text
patta.chiqarish.view
patta.chiqarish.create

patta.hisob.view

patta_varaq.view
patta_varaq.create
patta_varaq.edit
patta_varaq.finalize
patta_varaq.reopen

models.view
models.manage

workers.view
workers.manage
workers.badge.manage

users.view
users.manage

roles.view
roles.manage

reports.view

payroll.view
payroll.adjust
payroll.close

license.view

audit.view
```

---

## `role_permissions`

```text
role_id UUID FK
permission_id UUID FK

UNIQUE(role_id, permission_id)
```

---

## Security qoidasi

Tenant admin faqat tenant-scope permissionlarni bera oladi.

Quyidagilar unga umuman mavjud bo‘lmasligi kerak:

```text
companies.create
companies.suspend
licenses.revoke
platform_users.manage
```

Backend bu qoidani UI'dan mustaqil tekshirishi shart.

---

# 8. AUTH VA OFFLINE AUTH

## Online authentication

Server:

```text
Access JWT
Refresh token
```

ishlatadi.

Access token qisqa muddatli.

Refresh token rotation qilinsin.

Refresh token reuse aniqlansa session revoke qilinsin.

JWT ichida kamida:

```text
sub = user_id
company_id
device_id
session_id
```

bo‘lsin.

Permissionlar serverda har requestda tekshiriladi.

---

## Offline authentication

Oddiy access JWT muddati tugagani sabab internet yo‘q paytda desktop ishlamay qolmasligi kerak.

Online login vaqtida server qurilmaga:

```text
offline capability token
```

beradi.

Token server tomonidan imzolangan bo‘ladi.

Ichida:

```text
user_id
company_id
device_id
permission_snapshot
issued_at
offline_auth_valid_until
```

bo‘ladi.

Desktop imzoni lokal tekshiradi.

Offline permission snapshot faqat lokal UI va operatsiyalar uchun.

Sync vaqtida server **joriy permissionlarni yana tekshiradi**.

Demak offline paytda permission bekor qilingan foydalanuvchi event yaratgan bo‘lsa, server uni qabul qilish yoki reject qilishni joriy security policy bo‘yicha hal qiladi.

---

# 9. WORKERS

## `workers`

```text
id BIGINT PK
full_name VARCHAR NOT NULL
status ENUM(ACTIVE, INACTIVE)
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

`id`:

* avtomatik;
* immutable;
* hech qachon qayta ishlatilmaydi.

Ishchini o‘chirib tashlash o‘rniga:

```text
status = INACTIVE
```

qilinadi.

Tarixiy FKlar saqlanadi.

---

## UI talabi

Ishchilar ro‘yxatida birinchi ustun:

```text
ID
```

bo‘ladi.

Masalan:

| ID | Ism-familiya       | Jeton | Holat |
| -: | ------------------ | ----- | ----- |
| 18 | Abdullayeva Nodira | 125   | Faol  |
| 47 | Karimov Jasur      | 214   | Faol  |

Bu jadvaldagi:

```text
18
47
```

row number emas.

Haqiqiy `workers.id`.

---

# 10. WORKER BADGE HISTORY

## `worker_badge_history`

```text
id UUID PK
badge_number VARCHAR NOT NULL
worker_id BIGINT FK NOT NULL
valid_from TIMESTAMPTZ NOT NULL
valid_to TIMESTAMPTZ NULL
created_by UUID
created_at TIMESTAMPTZ
```

Interval:

```text
[valid_from, valid_to)
```

shaklida ishlaydi.

`valid_to NULL` = hozir ham amalda.

---

## Bir jeton bir vaqtda ikki ishchida bo‘lishi mumkin emas

PostgreSQL darajasida overlap constraint qo‘yilsin.

`btree_gist` extensiondan foydalanish mumkin.

Mantiq:

```text
EXCLUDE:

badge_number teng
AND
vaqt intervali overlap
```

bo‘lsa INSERT/UPDATE rad qilinadi.

Bu tekshiruv faqat application kodida emas, database darajasida ham bo‘lsin.

---

# 11. MODEL

## `models`

```text
id UUID PK
name VARCHAR NOT NULL
status ENUM(ACTIVE, INACTIVE)
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
version BIGINT
```

---

# 12. MODEL OPERATSIYALARI

## `model_operations`

```text
id UUID PK
model_id UUID FK
name VARCHAR NOT NULL
price NUMERIC(14,2) NOT NULL
sort_order INTEGER
status ENUM(ACTIVE, INACTIVE)
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
version BIGINT
```

`price` faqat hozirgi narx.

Eski ishlab chiqarish shu maydondan qayta hisoblanmaydi.

---

# 13. OPERATSIYA NARX TARIXI

## `model_operation_prices`

```text
id UUID PK
operation_id UUID FK
price NUMERIC(14,2) NOT NULL
valid_from TIMESTAMPTZ NOT NULL
valid_to TIMESTAMPTZ NULL
created_by UUID
created_at TIMESTAMPTZ
```

Bir operatsiya uchun narx intervallari overlap qilmasligi kerak.

Narx o‘zgartirilganda:

1. eski price history yopiladi;
2. yangi history row ochiladi;
3. `model_operations.price` current price sifatida yangilanadi.

---

# 14. PATTA SHABLONLARI

## `patta_templates`

```text
id UUID PK
name VARCHAR
model_id UUID FK
konveyer VARCHAR NOT NULL
razmer VARCHAR
rang VARCHAR
status ENUM(ACTIVE, INACTIVE)
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

Patta chiqarish ekranida shablon tanlash mumkin.

---

# 15. PATTA RAQAM BLOKLARI

Bir nechta desktop bir vaqtda offline Patta generatsiya qilishi mumkin.

Shuning uchun raqamni oddiy:

```text
MAX(patta_number) + 1
```

orqali olish qat’iyan taqiqlanadi.

---

## `patta_number_sequences`

```text
id UUID PK
next_number BIGINT NOT NULL
updated_at TIMESTAMPTZ
```

Har tenantda allocator mavjud.

---

## `patta_number_blocks`

```text
id UUID PK
device_id UUID NOT NULL
range_start BIGINT NOT NULL
range_end BIGINT NOT NULL
next_local_number BIGINT
allocated_at TIMESTAMPTZ
exhausted_at TIMESTAMPTZ NULL
status ENUM(ACTIVE, EXHAUSTED, CANCELLED)

UNIQUE(range_start, range_end)
```

---

## Allocation

Masalan:

```text
PC-1 → 1000–1999
PC-2 → 2000–2999
PC-3 → 3000–3999
```

Server blokni PostgreSQL transaction ichida atomik ajratadi.

Ikki device bir xil blokni olishi mumkin emas.

---

## Desktop xulqi

Current block:

```text
1000–1999
```

bo‘lsa va 80% ishlatilgan bo‘lsa:

internet mavjud bo‘lganda avtomatik yangi blok so‘ralsin.

Desktop bir vaqtning o‘zida:

```text
current block
next block
```

saqlashi mumkin.

Ikkalasi ham tugasa va internet bo‘lmasa:

foydalanuvchiga aniq ogohlantirish chiqsin.

Yangi Patta yaratishga ruxsat berilmasin.

Oldingi Pattalar bilan ishlash davom etishi mumkin.

---

# 16. PATTA CHIQARISH

Foydalanuvchi:

```text
Konveyer
Partiya №
Model
Razmer
Rang
Patta soni
```

ni belgilaydi.

Shablondan avtomatik qiymatlar olinishi mumkin.

Patta raqamlari device'ning ajratilgan blokidan olinadi.

---

# 17. PATTA HISOB

## `patta_hisob`

```text
id UUID PK
partiya_number VARCHAR NOT NULL
patta_number BIGINT NOT NULL
model_id UUID FK NOT NULL
razmer VARCHAR
rang VARCHAR
ish_soni INTEGER NOT NULL
created_device_id UUID
created_by UUID
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
version BIGINT

UNIQUE(partiya_number, patta_number)
```

`partiya_number` string bo‘lsin, chunki kelajakda:

```text
125
A-125
25/09-3
```

kabi formatlar bo‘lishi mumkin.

Input trim va canonical normalization qilinsin.

---

# 18. PATTA OPERATSIYA SNAPSHOTI

Bu V2 uchun majburiy.

Patta yaratilganda model operatsiyalarining o‘sha paytdagi holati muzlatiladi.

## `patta_operation_snapshots`

```text
id UUID PK
patta_hisob_id UUID FK
operation_id UUID FK
operation_name_snapshot VARCHAR NOT NULL
unit_price_snapshot NUMERIC(14,2) NOT NULL
sort_order INTEGER
created_at TIMESTAMPTZ

UNIQUE(patta_hisob_id, operation_id)
```

Masalan Patta sentabrda yaratilgan paytda:

```text
Yeng tikish
1 000 so‘m
```

bo‘lsa snapshot:

```text
1 000 so‘m
```

bo‘lib qoladi.

Noyabrda operatsiya 1 200 so‘m qilinsa ham eski Pattaga ta’sir qilmaydi.

Operatsiya nomi keyinchalik o‘zgartirilsa ham eski Patta varag‘i tarixiy nomini saqlay oladi.

`patta_hisob.ish_soni`:

```text
COUNT(patta_operation_snapshots)
```

ga mos bo‘lishi kerak.

---

# 19. PATTA VARAG‘I

## `patta_sheets`

```text
id UUID PK
patta_hisob_id UUID FK NOT NULL
konveyer VARCHAR
work_date DATE NOT NULL
status ENUM(DRAFT, FINALIZED)
created_by UUID
finalized_by UUID NULL
created_device_id UUID
created_at TIMESTAMPTZ
finalized_at TIMESTAMPTZ NULL
updated_at TIMESTAMPTZ
version BIGINT
```

---

## Patta qidirish

Brigadir:

```text
Partiya №
Patta №
```

kiritadi.

Desktop qidirish tartibi:

```text
1. SQLite
2. topilmasa va internet bo‘lsa REST API
3. serverdan topilsa SQLite cache/mirrorga yozish
4. UI'ni avtomatik to‘ldirish
```

Avtomatik:

```text
Konveyer
Model
Razmer
Rang
Partiya №
Patta №
Operatsiyalar
```

to‘ldiriladi.

Ularni qayta qo‘lda kiritish taqiqlanadi.

---

# 20. PATTA SHEET ROWS

## `patta_sheet_rows`

```text
id UUID PK
patta_sheet_id UUID FK NOT NULL
patta_operation_snapshot_id UUID FK NOT NULL
operation_id UUID FK NOT NULL
worker_id BIGINT FK NOT NULL
soni NUMERIC(14,3) NOT NULL
nuqson BOOLEAN NOT NULL DEFAULT false
unit_price_snapshot NUMERIC(14,2) NOT NULL
operation_name_snapshot VARCHAR NOT NULL
performed_at TIMESTAMPTZ NOT NULL
created_device_id UUID
created_by UUID
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
version BIGINT
```

Row ichida hisob-kitob uchun `worker_id` saqlanadi.

Jeton asosiy worker FK sifatida saqlanmaydi.

---

# 21. JETON → WORKER RESOLUTION

Patta varag‘idagi har operatsiya qatorda foydalanuvchi faqat:

```text
Jeton
```

kiritadi.

Masalan:

```text
125
```

Desktop lokal `worker_badge_history` mirror bazasidan:

```text
performed_at
```

vaqtida 125 jeton kimga tegishli ekanini topadi.

Topilsa:

```text
125 → worker_id 18 → Abdullayeva Nodira
```

UI:

```text
Jeton: 125
Ishchi: Abdullayeva Nodira
```

ko‘rsatadi.

Ism faqat ko‘rsatish uchun.

---

## Topilmasa

Katak qizil bo‘lsin.

Matn:

```text
Topilmadi
```

Saqlashga ruxsat berilmasin.

---

# 22. OFFLINE BADGE SECURITY

Desktopdagi badge history stale bo‘lishi mumkin.

Shuning uchun sync payload ichida verification uchun:

```text
badge_number_input
performed_at
client_resolved_worker_id
```

yuborilishi mumkin.

Bu qiymatlar `patta_sheet_rows`ning hisob-kitob kaliti emas.

Server sync paytida `worker_badge_history`dan badge'ni qayta resolve qiladi.

Agar:

```text
client worker_id != server worker_id
```

bo‘lsa event avtomatik qabul qilinmasin.

Status:

```text
CONFLICT_BADGE_ASSIGNMENT
```

qaytarilsin.

Foydalanuvchiga o‘zbekcha tushunarli conflict UI ko‘rsatilsin.

---

# 23. PATTA VARAG‘I FINALIZATION

Patta varag‘i dastlab:

```text
DRAFT
```

bo‘ladi.

DRAFT paytida tegishli permission bo‘lsa tahrirlash mumkin.

Tugallanganda:

```text
FINALIZED
```

qilinadi.

FINALIZED sheet oddiy foydalanuvchi tomonidan o‘zgartirilmaydi.

Qayta ochish uchun:

```text
patta_varaq.reopen
```

permission talab qilinadi.

Har reopen audit logga yoziladi.

---

# 24. ISH HAQI DAVRLARI

## `payroll_periods`

```text
id UUID PK
year INTEGER
month INTEGER
date_from DATE
date_to DATE
status ENUM(OPEN, CLOSED)
closed_by UUID NULL
closed_at TIMESTAMPTZ NULL

UNIQUE(year, month)
```

Payroll period `CLOSED` bo‘lsa shu davrdagi ishlab chiqarish qiymatlarini bevosita o‘zgartirish taqiqlanadi.

Tarixiy hisobot o‘zgarmasligi kerak.

---

# 25. ISH HAQI HISOBI

Asosiy ishbay summa:

```text
SUM(
    patta_sheet_rows.soni
    *
    patta_sheet_rows.unit_price_snapshot
)
```

Yig‘ish:

```text
GROUP BY worker_id
```

bo‘yicha.

Hech qachon:

```text
GROUP BY full_name
GROUP BY badge_number
```

qilinmasin.

---

# 26. NUQSON

`nuqson` alohida business flag.

Nuqson va row delete bitta funksiya emas.

UI:

```text
| ... | Nuqson | O‘chirish |
```

ko‘rinishida ikkita alohida ustun bo‘ladi.

Nuqson avtomatik ravishda maoshdan pul ayirishini taxmin qilib implementatsiya qilma.

Jarima business rule alohida sozlanmaguncha:

* nuqson soni;
* nuqson qiymati

hisobotda alohida ko‘rsatiladi.

---

# 27. PAYROLL ADJUSTMENTS

Qo‘shimcha mukofot yoki jarima uchun alohida obyekt ishlat.

## `payroll_adjustments`

```text
id UUID PK
payroll_period_id UUID FK
worker_id BIGINT FK
type ENUM(BONUS, PENALTY)
amount NUMERIC(14,2)
reason TEXT NOT NULL
created_by UUID
created_at TIMESTAMPTZ
```

Jami:

```text
ishbay summa
+ bonus
- jarima
= jami
```

Tarixiy Patta rowlarini jarima berish uchun o‘zgartirma.

---

# 28. OFFLINE SQLITE ARXITEKTURASI

Desktopda barcha kerakli operatsion ma’lumotlarning lokal mirror'i bo‘ladi.

SQLite'da kamida:

```text
local_meta
users_cache
workers
worker_badge_history
models
model_operations
patta_templates
patta_hisob
patta_operation_snapshots
patta_sheets
patta_sheet_rows
patta_number_blocks
sync_queue
sync_state
sync_conflicts
```

bo‘ladi.

---

# 29. `sync_queue`

`sync_queue` birinchi navbatda **Desktop SQLite** jadvali.

Uni tenant PostgreSQLning asosiy biznes queue jadvali sifatida ishlatma.

## SQLite `sync_queue`

```text
id UUID PK
event_id UUID UNIQUE NOT NULL
entity_type VARCHAR NOT NULL
entity_id VARCHAR
operation ENUM(CREATE, UPDATE, DELETE, FINALIZE)
base_version BIGINT NULL
payload_json TEXT NOT NULL
created_at TEXT NOT NULL
attempt_count INTEGER DEFAULT 0
last_attempt_at TEXT NULL
last_error TEXT NULL
status ENUM(
    PENDING,
    SYNCING,
    SYNCED,
    CONFLICT,
    FAILED
)
```

---

# 30. PUSH SYNC

Endpoint:

```text
POST /api/v1/sync/push
```

Desktop batch yuboradi.

Masalan:

```json
{
  "device_id": "...",
  "events": [
    {
      "event_id": "...",
      "entity_type": "patta_sheet_row",
      "operation": "CREATE",
      "entity_id": "...",
      "base_version": 0,
      "occurred_at": "...",
      "payload": {}
    }
  ]
}
```

Server har eventni alohida validatsiya qiladi.

---

# 31. SERVER IDEMPOTENCY

Tenant PostgreSQLda:

## `processed_sync_events`

```text
event_id UUID PK
device_id UUID
user_id UUID
entity_type VARCHAR
entity_id VARCHAR
result_status VARCHAR
processed_at TIMESTAMPTZ
```

Event kelganda:

```text
event_id mavjudmi?
```

tekshiriladi.

Mavjud bo‘lsa business operation qayta bajarilmaydi.

Oldingi natija qaytariladi.

---

# 32. SERVER CHANGE LOG

Server → Desktop sync uchun tenant DBda:

## `server_change_log`

```text
sequence_id BIGSERIAL PK
entity_type VARCHAR NOT NULL
entity_id VARCHAR NOT NULL
operation ENUM(UPSERT, DELETE)
entity_version BIGINT
changed_at TIMESTAMPTZ
```

Business entity o‘zgarganda shu transaction ichida change log ham yozilishi kerak.

---

# 33. PULL SYNC

Endpoint:

```text
GET /api/v1/sync/pull?cursor=12345&limit=500
```

Server:

```json
{
  "changes": [],
  "next_cursor": 12840,
  "has_more": true
}
```

qaytaradi.

Desktop o‘zida:

```text
last_server_cursor
```

saqlaydi.

Changes:

```text
ORDER BY sequence_id ASC
```

qo‘llanadi.

SQLite update bir transaction ichida bajarilsin.

Hammasi muvaffaqiyatli bo‘lgandan keyingina cursor yangilansin.

---

# 34. SYNC LOOP

Internet mavjud bo‘lganda desktop background sync:

```text
1. PUSH pending events
2. server response process
3. conflicts ajratish
4. PULL server changes
5. SQLite transaction apply
6. cursor save
7. kerak bo‘lsa yana batch
```

qilsin.

Foreground data entry sync tugashini kutmasin.

---

# 35. RETRY

Network error:

```text
retry with exponential backoff
```

Masalan:

```text
5 s
15 s
30 s
60 s
...
```

Lekin foydalanuvchi yangi lokal operatsiyalarni davom ettira oladi.

---

# 36. CONFLICT STRATEGIYASI

Barcha entity uchun avtomatik `last write wins` ishlatma.

Bu ERP uchun xavfli.

---

## Reference data

Masalan:

```text
models
model_operations
workers
```

uchun optimistic locking.

Har entity:

```text
version BIGINT
```

saqlaydi.

Update:

```text
base_version
```

bilan keladi.

Server versiya o‘zgargan bo‘lsa:

```text
409 CONFLICT
```

qaytaradi.

---

## Patta

`UNIQUE(partiya_number, patta_number)` collision bo‘lsa avtomatik merge qilinmaydi.

Conflict.

---

## Badge

Badge mapping mismatch:

```text
CONFLICT_BADGE_ASSIGNMENT
```

---

## Finalized sheet

FINALIZED sheetga ruxsatsiz edit:

```text
SHEET_FINALIZED
```

---

## Closed payroll

Closed davrga edit:

```text
PAYROLL_PERIOD_CLOSED
```

---

# 37. DELETE STRATEGIYASI

Tarixiy business ma’lumotlar uchun hard delete imkon qadar ishlatilmasin.

Masalan:

```text
workers
models
operations
```

uchun:

```text
status = INACTIVE
```

ishlat.

Sync qilinadigan mutable obyektlarda kerak bo‘lsa:

```text
deleted_at
```

tombstone ishlat.

Server → client pull sync delete eventni yo‘qotmasligi kerak.

---

# 38. AUDIT LOG

Har tenant database uchun majburiy.

## `audit_log`

```text
id BIGSERIAL PK
actor_user_id UUID
device_id UUID NULL
action VARCHAR NOT NULL
entity_type VARCHAR NOT NULL
entity_id VARCHAR NOT NULL
before_json JSONB NULL
after_json JSONB NULL
request_id UUID
created_at TIMESTAMPTZ NOT NULL
```

Audit qilinishi shart:

* worker yaratish/o‘zgartirish;
* jeton berish;
* jeton yopish;
* model o‘zgartirish;
* operatsiya narxi o‘zgartirish;
* Patta delete/cancel;
* Patta sheet reopen;
* nuqson o‘zgartirish;
* payroll adjustment;
* payroll close;
* role o‘zgartirish;
* permission berish/olish.

Audit logni oddiy UI orqali tahrirlash/o‘chirish taqiqlanadi.

---

# 39. REDIS

Redis quyidagilar uchun ishlatilishi mumkin:

* tenant metadata cache;
* Patta quick lookup;
* permission cache;
* rate limit;
* qisqa muddatli distributed lock.

Misol key:

```text
tenant:{companyId}:patta:{partiya}:{patta}
```

Har tenant key namespace bilan ajratiladi.

---

## Patta cache

Lookup:

```text
Redis
↓ miss
PostgreSQL
↓
Redis SET
```

Patta o‘zgarsa cache invalidate qilinsin.

Cache buzilgan yoki Redis ishlamay qolgan taqdirda PostgreSQLdan to‘g‘ri natija olinishi kerak.

---

# 40. LICENSE — ED25519

Server Ed25519 private key bilan license payloadni imzolaydi.

Desktop ichida faqat public key bo‘ladi.

Private key:

* Git repository ichida bo‘lmasin;
* Electron package ichida bo‘lmasin;
* Docker image ichiga hard-code qilinmasin.

Docker secret yoki production secret store orqali berilsin.

---

# 41. LICENSE PAYLOAD

Canonical payload ichida:

```text
license_id
company_id
device_id
hardware_fingerprint_hash
issued_at
valid_until
offline_grace_until
recheck_interval_days = 7
license_version
```

bo‘lsin.

Keyin Ed25519 signature generatsiya qilinadi.

---

# 42. DESKTOP LICENSE CHECK

Desktop start:

```text
1. license faylini o‘qi
2. canonical payload hosil qil
3. public key bilan Ed25519 signature verify qil
4. device fingerprintni tekshir
5. valid_until tekshir
6. offline grace tekshir
7. clock rollback tekshir
```

Internet bo‘lishi shart emas.

---

# 43. ONLINE LICENSE REVALIDATION

Internet mavjud bo‘lsa kamida 7 kunda bir marta server bilan revalidation qilinsin.

Server:

```text
ACTIVE
REVOKED
EXPIRED
```

status qaytaradi.

Server yangi trusted UTC time ham qaytaradi.

Desktop:

```text
last_successful_validation
last_trusted_server_time
```

saqlaydi.

---

# 44. CLOCK ROLLBACK

Foydalanuvchi Windows vaqtini ortga surib license muddatini uzaytira olmasligi kerak.

Agar lokal vaqt oldingi trusted server vaqtiga nisbatan g‘ayritabiiy ortga ketgan bo‘lsa:

* warning;
* online verification talab qilish

mexanizmi ishlasin.

Clock securityni faqat lokal `Date.now()`ga bog‘lama.

---

# 45. DEVICE REBIND

SSD yoki boshqa hardware komponent almashtirilgani sabab foydalanuvchi butunlay bloklanib qolmasligi uchun Superadmin boshqaradigan:

```text
device rebind
```

jarayoni bo‘lsin.

Eski device:

```text
REPLACED
```

qilinadi.

Yangi license yangi device'ga chiqariladi.

Eski license auditda qoladi.

---

# 46. ELECTRON SECURITY

Majburiy:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

React renderer PostgreSQL yoki SQLite fayliga to‘g‘ridan-to‘g‘ri kira olmasin.

`better-sqlite3`:

```text
Electron main process
yoki dedicated worker
```

ichida ishlasin.

Renderer faqat qat’iy typed preload IPC API orqali murojaat qilsin.

`ipcRenderer`ni to‘liq rendererga expose qilma.

---

# 47. LOCAL TOKEN SECURITY

Refresh token, device secret yoki boshqa maxfiy tokenlarni oddiy SQLite TEXT ustuniga yozma.

Electron/OS secure storage imkoniyatidan foydalan.

SQLite ichida faqat zarur business cache saqlansin.

---

# 48. UI TILI

Barcha foydalanuvchi ko‘radigan interfeys:

```text
o‘zbek lotin
```

bo‘lishi shart.

Bir ekranda:

```text
o‘zbek + rus
o‘zbek + kirill
```

aralashmasin.

Texnik developer loglari bundan mustasno.

---

# 49. SPREADSHEET UI

Quyidagi ekranlar Excel uslubida:

* Patta chiqarish
* Patta hisob
* Patta varag‘i
* Hisobotlar

Tab/Enter navigatsiyasi majburiy.

Foydalanuvchi sichqonchasiz tez ishlashi kerak.

---

# 50. AVTOMATIK MAYDONLAR

Avtomatik maydonlar:

```text
Konveyer
Model
Razmer
Rang
Partiya №
Patta №
Ism-familiya
```

tegishli holatda:

```text
Avtomatik
```

deb belgilanadi.

Read-only bo‘lsin.

Vizual ravishda edit qilinadigan kataklardan farq qilsin.

---

# 51. KATAK HOLATLARI

Bo‘sh value:

```text
—
```

ko‘rsatsin.

To‘ldirilgan edit katak vizual ajratilsin.

Validation xato:

```text
qizil
```

Musbat natija:

```text
yashil
```

Nuqson/kamomad/jarima:

```text
qizil
```

Rang semantikasi barcha ekranlarda bir xil.

---

# 52. BIRLIK

Sonlar context bilan ko‘rsatiladi.

Noto‘g‘ri:

```text
140
50000
```

To‘g‘ri:

```text
140 kun
50 000 so‘m
```

Pul formatter:

```text
1 250 000 so‘m
```

---

# 53. ISM FORMAT

Ism-familiya:

```text
Abdullayeva Nodira
```

ko‘rinishida.

BOSH HARFLI:

```text
ABDULLAYEVA NODIRA
```

ko‘rinishidan foydalanma.

---

# 54. `JAMI` USTUNI

Hisob va hisobot jadvallarida `Jami` doim ko‘rinadigan bo‘lsin.

Horizontal scroll sabab yo‘qolib ketmasin.

Kerak bo‘lsa:

```text
position: sticky;
right: 0;
```

uslubida ishlat.

---

# 55. PATTA VARAG‘I UI

Tavsiya:

```text
┌─────────────────────────────────────────────────────────────┐
│ Partiya № [123]      Patta № [1057]                         │
├─────────────────────────────────────────────────────────────┤
│ Konveyer: 2       [Avtomatik]                               │
│ Model: Futbolka   [Avtomatik]                               │
│ Razmer: XL        [Avtomatik]                               │
│ Rang: Qora        [Avtomatik]                               │
├────┬──────────────┬───────┬────────────────────┬─────┬──────┤
│ №  │ Operatsiya   │ Jeton │ Ishchi             │ Soni│Nuqson│
├────┼──────────────┼───────┼────────────────────┼─────┼──────┤
│ 1  │ Yeng tikish  │ 125   │ Abdullayeva Nodira │ 10  │  ☐   │
└────┴──────────────┴───────┴────────────────────┴─────┴──────┘
```

`O‘chirish` uchun alohida ustun bo‘ladi.

`Nuqson` va `O‘chirish` hech qachon bitta tugmaga birlashtirilmaydi.

---

# 56. KORXONA ADMIN PANEL

Desktop ichida korxona admin tegishli permission bilan boshqaradi:

### Model va operatsiyalar

* model yaratish;
* deaktiv qilish;
* operatsiya qo‘shish;
* operatsiya narxini o‘zgartirish;
* price history ko‘rish.

### Ishchilar

* ishchi yaratish;
* deaktiv qilish;
* jeton berish;
* jeton tarixini ko‘rish.

### Shablonlar

* Patta shabloni yaratish;
* model;
* konveyer;
* razmer;
* rang.

### Rollar

* rol yaratish;
* permission tanlash;
* foydalanuvchiga rol biriktirish.

### License

Faqat o‘z korxonasi device va license holatini ko‘rish.

Revoke qilish huquqi platformaga tegishli.

---

# 57. SUPERADMIN PANEL

Alohida `platform-admin` React web ilova.

Ko‘rsatiladi:

* korxonalar;
* korxona holati;
* database schema version;
* provisioning holati;
* device soni;
* license holati;
* license muddati;
* oxirgi online validation;
* migratsiya holati.

Superadmin yangi korxona yaratganda:

```text
Company
↓
Database
↓
Migrations
↓
Permission seeds
↓
Admin
↓
License
```

jarayoni avtomatik bajariladi.

---

# 58. HISOBOTLAR

Kamida quyidagi hisobotlar:

### Ishchi oylik hisoboti

```text
Worker ID
Ism-familiya
Ish soni
Ishbay summa
Nuqson
Bonus
Jarima
Jami
```

### Model hisoboti

```text
Model
Patta soni
Operatsiya soni
Ish hajmi
Jami
```

### Partiya hisoboti

```text
Partiya №
Patta soni
Model
Razmer
Rang
Ish hajmi
Jami
```

### Nuqson hisoboti

```text
Worker ID
Ism-familiya
Model
Operatsiya
Nuqson soni
Qiymati
```

---

# 59. HISOBOT QOIDASI

Hisobot querylarida identifikatsiya:

```sql
GROUP BY worker_id
```

bo‘yicha.

Keyin:

```sql
JOIN workers
```

orqali full_name olinadi.

Full name ma’lumotni bog‘lash kaliti emas.

---

# 60. API STRUKTURASI

API versioned bo‘lsin:

```text
/api/v1
```

Masalan:

```text
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh

GET    /api/v1/models
POST   /api/v1/models
PATCH  /api/v1/models/:id

GET    /api/v1/workers
POST   /api/v1/workers

POST   /api/v1/workers/:id/badges
GET    /api/v1/workers/:id/badges

POST   /api/v1/patta/number-blocks/allocate
POST   /api/v1/patta/generate
GET    /api/v1/patta/:partiya/:number

POST   /api/v1/patta-sheets
POST   /api/v1/patta-sheets/:id/finalize

POST   /api/v1/sync/push
GET    /api/v1/sync/pull

GET    /api/v1/reports/payroll

POST   /api/v1/license/validate
```

---

# 61. VALIDATION

Backend barcha DTOlarni qat’iy validatsiya qilsin.

Frontend validationga ishonma.

Masalan:

```text
soni > 0
price >= 0
valid_to > valid_from
patta_number > 0
```

Server qayta tekshiradi.

---

# 62. DATABASE TRANSACTIONS

Quyidagi operatsiyalar transaction bo‘lishi shart:

* Patta raqam blokini ajratish;
* Patta batch generatsiya;
* operation price change;
* badge reassignment;
* Patta sheet finalize;
* payroll close;
* sync event apply;
* provisioning muhim bosqichlari.

Partial business write qolmasligi kerak.

---

# 63. INDEXLAR

Asosiy indexlar:

```text
patta_hisob(partiya_number, patta_number)

worker_badge_history(badge_number)

patta_sheet_rows(worker_id)

patta_sheet_rows(patta_sheet_id)

patta_sheets(work_date)

model_operations(model_id)

server_change_log(sequence_id)

processed_sync_events(event_id)

audit_log(entity_type, entity_id)

audit_log(created_at)
```

Real query profiling asosida qo‘shimcha indexlar qo‘sh.

---

# 64. BACKUP

Database-per-tenant bo‘lgani uchun restore ham tenant bo‘yicha qilina olishi kerak.

Majburiy:

* Master DB backup;
* tenant DB backup;
* backup retention policy;
* restore test;
* backup encryption;
* production backup monitoring.

Backup mavjudligi yetarli emas.

Restore ishlashi test qilinsin.

---

# 65. LOGGING

Structured JSON log ishlat.

Har API request uchun:

```text
request_id
```

generatsiya qil.

Log context:

```text
request_id
company_id
user_id
device_id
route
status_code
duration_ms
```

Sensitive business payload yoki password logga yozilmasin.

---

# 66. HEALTH CHECK

Backend:

```text
/health/live
/health/ready
```

endpointlarga ega bo‘lsin.

Ready check:

* Master PostgreSQL;
* Redis;
* backend holati

tekshirishi mumkin.

Tenant bazalarining hammasini har health requestda tekshirma.

---

# 67. NGINX

Nginx:

* HTTPS termination;
* reverse proxy;
* request size limits;
* security headers;
* rate limits

uchun ishlatiladi.

Backend public portini internetga bevosita ochma.

---

# 68. DOCKER COMPOSE

Productionga yaqin local environment:

```text
nginx
api
postgres
redis
platform-admin
```

servislaridan iborat bo‘lsin.

Desktop Docker ichida ishlamaydi.

Environmentlar:

```text
.env.example
.env.development
production secrets
```

ajratilsin.

Real secrets repositoryga commit qilinmasin.

---

# 69. MIGRATION STRATEGIYASI

Master va Tenant migrationlari alohida.

```text
master-migrations/*
tenant-migrations/*
```

Har tenantda schema version kuzatilsin.

Release vaqtida migration orchestrator:

```text
tenant 1
tenant 2
tenant 3
...
```

bazalarini yangilaydi.

Bir tenant migrationda xato bersa qolganlari haqida aniq holat saqlanadi.

Migration:

```text
RUNNING
SUCCESS
FAILED
```

statusga ega bo‘lsin.

---

# 70. ZERO-DOWNTIME MIGRATION PRINSIPI

Mumkin bo‘lgan joylarda:

1. yangi nullable column qo‘sh;
2. kodni deploy qil;
3. ma’lumotni backfill qil;
4. keyin constraintni kuchaytir.

Bitta katta breaking migration orqali barcha tenantlarni xavfga qo‘yma.

---

# 71. TEST TALABLARI

Har modul uchun:

```text
Unit tests
Integration tests
Database tests
E2E tests
```

bo‘lsin.

---

# 72. MAJBURIY SYNC TESTLARI

Test:

### Duplicate event

Bir eventni 10 marta yubor.

Natija:

```text
1 business write
```

---

### Offline two-PC Patta generation

PC-1 va PC-2 offline.

Ikkalasi 500 tadan Patta yaratsin.

Natija:

```text
0 collision
```

---

### Pull sync

PC-1 Patta yaratadi → serverga sync.

PC-2 pull qiladi.

Internet uziladi.

PC-2 shu Pattani lokal topishi kerak.

---

### Badge reassignment

Jeton 125:

```text
Yanvar → Worker 18
Iyun   → Worker 47
```

Yanvar hisobotida Worker 18 qolishi shart.

---

### Price change

Sentabr:

```text
1 000 so‘m
```

Noyabr:

```text
1 200 so‘m
```

Sentabr report qayta ishga tushirilganda:

```text
1 000 so‘m
```

qolishi shart.

---

### License offline

Internet o‘chiriladi.

Valid signed license mavjud.

Desktop offline policy doirasida ishlashi kerak.

---

### License tamper

License payloaddagi bitta belgi o‘zgartiriladi.

Natija:

```text
signature invalid
```

va dastur protected modega o‘tadi.

---

# 73. UX PERFORMANCE

Patta varag‘ida jeton kiritilganda local lookup sabab foydalanuvchi network requestni kutmasligi kerak.

Badge lookup:

```text
SQLite local
```

dan bo‘lsin.

Pattani lokal topish ham tez bajarilsin.

Production operatorning asosiy ish jarayoni internet latencyga bog‘lanmasligi kerak.

---

# 74. OFFLINE HOLAT INDIKATORI

Desktop yuqori qismida doim:

```text
Onlayn
```

yoki:

```text
Oflayn
```

holati ko‘rinsin.

Qo‘shimcha:

```text
Sinxronlanmagan: 14 ta
```

ko‘rsatish mumkin.

Sync muammo bo‘lsa yashirmaslik.

---

# 75. SYNC CONFLICT UI

Conflict kelganda foydalanuvchiga texnik JSON ko‘rsatma.

Masalan:

```text
Jeton ma’lumoti o‘zgargan.

Jeton: 125
Lokal ishchi: Abdullayeva Nodira
Serverdagi ishchi: Karimov Jasur

Yozuv avtomatik saqlanmadi.
```

Admin tegishli qaror qila olishi kerak.

---

# 76. API ERROR FORMAT

Barcha API xatolari yagona formatda:

```json
{
  "code": "BADGE_NOT_FOUND",
  "message": "Jeton topilmadi",
  "request_id": "...",
  "details": {}
}
```

UI `code` bo‘yicha Uzbek matn ko‘rsatishi mumkin.

Raw SQL errorni foydalanuvchiga bermang.

---

# 77. TIMEZONE

Database timestamp:

```text
TIMESTAMPTZ
```

bilan UTC semantikasida saqlansin.

Tenant timezone:

```text
companies.timezone
```

orqali presentation qatlamida ishlatiladi.

Default:

```text
Asia/Tashkent
```

lekin hard-code qilinmasin.

Payroll `work_date` tenant timezone asosida aniqlanadi.

---

# 78. DECIMAL QOIDASI

Pul uchun JavaScript floating-point arithmetic ishlatma.

Database:

```text
NUMERIC
```

Frontend/backend calculation uchun decimal-safe kutubxona yoki integer minor-unit strategiyasi ishlat.

Masalan:

```text
0.1 + 0.2
```

tipidagi floating error payrollga tushmasligi kerak.

---

# 79. HARD DELETE CHEKLOVI

Quyidagi entitylar production UI orqali hard delete qilinmasin:

```text
worker
badge history
patta
finalized patta sheet
payroll adjustment
audit log
license
```

Kerak bo‘lsa cancel/inactive/tombstone.

---

# 80. DEVELOPMENT BOSQICHLARI

## 0-bosqich — Foundation

Birinchi bo‘lib:

* monorepo;
* Docker Compose;
* coding standards;
* TypeScript config;
* environment config;
* Master/Tenant migration infra;
* shared types;
* API error standard;
* logging

tayyorla.

Bu bosqich tugamasdan business UI boshlama.

---

## 1-bosqich — Master DB va Tenant Provisioning

Tugallanish mezoni:

1. Superadmin company yaratadi.
2. Yangi PostgreSQL DB avtomatik yaratiladi.
3. Tenant migrations ishlaydi.
4. Permission seed ishlaydi.
5. Tenant admin yaratiladi.
6. Company `ACTIVE`.
7. Backend tenant DBga request bo‘yicha ulanadi.
8. Ikki tenant ma’lumotlari izolyatsiya testi o‘tadi.

---

## 2-bosqich — Auth va RBAC

Tugallanish mezoni:

* login;
* refresh;
* JWT;
* offline capability;
* roles;
* permissions;
* guards;
* tenant admin platform permission bera olmaydi;
* API permission testlari mavjud.

---

## 3-bosqich — Models, operations, price history

Tugallanish mezoni:

* model CRUD;
* operation CRUD;
* current price;
* price history;
* overlap himoyasi;
* audit.

---

## 4-bosqich — Workers va badge history

Tugallanish mezoni:

* worker;
* immutable worker ID;
* badge assignment;
* badge reassignment;
* overlap constraint;
* historical lookup;
* audit.

---

## 5-bosqich — Patta chiqarish va Patta hisob

Tugallanish mezoni:

* templates;
* number block allocation;
* offline generation;
* unique Patta;
* operation snapshots;
* Patta hisob spreadsheet;
* Redis lookup.

---

## 6-bosqich — Desktop Offline Engine

Tugallanish mezoni:

* SQLite migrations;
* local repositories;
* sync_queue;
* push;
* idempotency;
* server change log;
* pull;
* cursor;
* retries;
* conflict store;
* network status;
* two-PC automated tests.

Bu bosqich to‘liq tugamasdan Patta varag‘ini production-ready deb hisoblama.

---

## 7-bosqich — Patta varag‘i

Tugallanish mezoni:

* partiya + Patta lookup;
* local-first;
* server fallback;
* operation snapshot rows;
* jeton input;
* worker auto display;
* Topilmadi validation;
* nuqson;
* o‘chirish alohida;
* Tab/Enter;
* finalization;
* offline ishlash;
* sync.

---

## 8-bosqich — License

Tugallanish mezoni:

* Ed25519 keys;
* signed license;
* local verification;
* hardware bind;
* online revalidation;
* revoke;
* grace;
* clock rollback detection;
* device rebind.

---

## 9-bosqich — Admin panellar

Tugallanish mezoni:

### Tenant

* models;
* operations;
* prices;
* workers;
* badges;
* roles;
* permissions;
* templates;
* license status;
* audit.

### Platform

* companies;
* provisioning;
* migrations;
* devices;
* licenses.

---

## 10-bosqich — Payroll va hisobot

Tugallanish mezoni:

* worker report;
* model report;
* partiya report;
* defect report;
* payroll period;
* bonus;
* penalty;
* close;
* historical immutable totals;
* Excel-style tables;
* sticky Jami.

---

# 81. HAR BOSQICH UCHUN DEFINITION OF DONE

Modul “tayyor” hisoblanishi uchun:

```text
[ ] Database migration bor
[ ] Entity/model bor
[ ] Service ishlaydi
[ ] REST API ishlaydi
[ ] Permission guard ishlaydi
[ ] Validation ishlaydi
[ ] Audit kerak bo‘lsa yoziladi
[ ] Unit testlar bor
[ ] Integration testlar bor
[ ] UI ishlaydi
[ ] Offline talabi bo‘lsa ishlaydi
[ ] Sync talabi bo‘lsa ishlaydi
[ ] Error holatlar implementatsiya qilingan
[ ] TypeScript error yo‘q
[ ] Build muvaffaqiyatli
[ ] TODO bilan yarim qoldirilmagan
```

Shundan keyingina keyingi modulga o‘t.

---

# 82. CODING QOIDALARI

Quyidagilarni qilma:

```text
any
```

ni sababsiz ishlatish;

business logicni controller ichiga yozish;

raw SQL stringlarni foydalanuvchi inputi bilan birlashtirish;

frontend permissionni security sifatida qabul qilish;

tenant IDni client inputidan ishonchli deb olish;

current operation price orqali eski payrollni qayta hisoblash;

badge_numberni worker identity qilish;

full_name bo‘yicha payroll GROUP BY qilish;

MAX(patta_number)+1 ishlatish;

syncda blindly last-write-wins ishlatish;

audit talab qilinadigan entityni hard delete qilish.

---

# 83. DOMAIN SERVICE AJRATISH

Kamida:

```text
TenantResolverService
TenantConnectionManager

AuthService
PermissionService

WorkerService
BadgeService

ModelService
OperationService
OperationPriceService

PattaNumberAllocatorService
PattaGenerationService
PattaLookupService

PattaSheetService

SyncPushService
SyncPullService
SyncConflictService

PayrollService
ReportService

LicenseSigningService
LicenseValidationService

AuditService

ProvisioningService
TenantMigrationService
```

alohida responsibility bilan qurilsin.

---

# 84. ASOSIY BUSINESS INVARIANTLAR UCHUN DATABASE HIMOYASI

Faqat TypeScript kodiga suyanma.

Database constraint ishlat:

```text
Patta unique
Badge interval overlap
Operation price interval overlap
Unique email
Unique event_id
FK integrity
CHECK price >= 0
CHECK soni > 0
CHECK range_end >= range_start
```

Business critical invariant imkon qadar PostgreSQL darajasida ham himoyalansin.

---

# 85. YAKUNIY MAQSAD

Tizim quyidagi real holatni ishonchli bajara olishi kerak:

Fabrikada:

```text
PC-1
PC-2
PC-3
PC-4
```

bor.

LAN yo‘q.

Lokal server yo‘q.

Internet vaqt-vaqti bilan uziladi.

Har PC o‘z SQLite bazasi bilan ishlaydi.

Internet uzilganda operator ishlab chiqarishni davom ettiradi.

PC'lar oldindan olingan Patta raqam bloklari sabab bir-biriga to‘qnashmaydi.

Internet qaytganda:

```text
local changes → VPS
VPS changes → local PCs
```

sinxronlanadi.

Bir xil event qayta yuborilsa dublikat yaratilmaydi.

Jeton keyinchalik boshqa odamga berilsa eski ish haqi o‘zgarmaydi.

Operatsiya narxi keyinchalik o‘zgartirilsa eski ish haqi o‘zgarmaydi.

Korxona A hech qachon Korxona B ma’lumotini ko‘ra olmaydi.

Superadmin platformani boshqaradi, lekin fabrika ishlab chiqarish yozuvlarini ko‘rmaydi.

Litsenziya internet yo‘q paytda lokal Ed25519 imzo orqali tekshiriladi.

Hisobotlarda barcha hisob-kitoblar haqiqiy immutable:

```text
worker_id
```

bo‘yicha amalga oshiriladi.

Bu invariantlarning birortasini buzadigan implementation qabul qilinmaydi.
