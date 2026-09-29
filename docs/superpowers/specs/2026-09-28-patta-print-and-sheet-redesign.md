# Patta print va kiritish oqimi

## Holat

**Tasdiqlangan design; implementation and acceptance verified** on `feature/patta-sheet`.

Ushbu design authoritative Patta print → ishlab chiqarish → Patta kiritish oqimini,
`ish_soni` semantikasini, offline sync va SQLite ta’sirini birgalikda belgilaydi.
U eski, mahsulot miqdorini operatsiyalar soni bilan aralashtirgan talqinni
almashtiradi. Model hisob query va offline read-only grid shu scope’da; payroll
pul hisoblashlari scope’dan tashqarida.

## Authoritative biznes tushunchalari

```text
ish_soni             = bitta bosma Pattadagi mahsulot/dona soni
operation_count      = shu Patta uchun operation snapshotlar soni
razmer_count         = shu razmer uchun chiqariladigan alohida Patta/pachkalar soni
quantity_snapshot    = shu operationni bajargan workerga yoziladigan Patta ish_soni
worker_id            = permanent worker identity
badge_number         = qayta ishlatilishi mumkin bo‘lgan jeton; faqat input/evidence
entered_at           = Patta Sheet tizimga kiritilgan vaqt
printed_at           = Patta batch fizik chop etilgan vaqt
business_date        = entered_at ning tenant timezone’dagi local calendar date’i
```

Misol: modelda 13 ta operation, Patta `ish_soni = 125` bo‘lishi mumkin.
`operation_count=13`; `ish_soni=125`. S razmer uchun `razmer_count=2` bo‘lsa,
ikkita alohida Patta yaratiladi va har birida `ish_soni=125` bo‘ladi.

Worker identity faqat `workers.id` / `worker_id`. Ism display; badge raqami
Sheet yaratilgan immutable `entered_at` vaqtida yechiladi. Biznes qoidaga ko‘ra
Patta tizimga kiritilgan paytda ish bajarilgan hisoblanadi. Jeton va yuborilgan
`worker_id` server tomonidan qayta solishtiriladi.

## Mavjud repository tekshiruvi

Branch tekshiruvi:

- Branch: `feature/patta-sheet`.
- Design yozilishidan oldingi repository auditda ishchi daraxt toza va Patta Sheet
  implementation yo‘q edi. Keyingi implementation worktree holati git statusda
  tekshiriladi; ushbu audit faqat tarixiy kontekst sifatida saqlanadi.
- Patta Sheet uchun backend modul, jadvallar, renderer screen yoki local
  repository hozircha yo‘q. Oldingi dizayn muhokamasi faqat tashqi temp mockup
  edi, repo kodiga yozilmagan.

### A. `ish_soni` hozir qayerda operation count?

- Eski API online generation va offline registration kod yo‘llari Patta
  operatsiyalari sonini mahsulot miqdori sifatida saqlagan. Ushbu v1 yo‘llar endi
  yangi Patta generation/read uchun structured upgrade error qaytaradi.
- Eski Desktop single-Patta generator ham mahsulot miqdorini mustaqil qabul
  qilmagan. Yangi Desktop print path actual mahsulot miqdorini talab qiladi va
  aynan shu qiymatni har bir Patta’da saqlaydi.
- `database/tenant-migrations/20260926000500-AddPattaFoundation.js`da
  `ish_soni INTEGER NOT NULL CHECK (ish_soni > 0)`.
- `apps/desktop/src/main/database/migrations/001-sync-foundation.ts`da ham
  `ish_soni INTEGER NOT NULL CHECK (ish_soni > 0)`.
- Eski `docs/database.md`, `docs/IMPLEMENTATION.md` va old Patta design/plan
  hujjatlari ham shu noto‘g‘ri talqinni normativ deb ko‘rsatgan; ular yangi
  contract bilan yangilanadi.

Bu ma’no authoritative talablarga zid va o‘zgartirilishi kerak.

### B. Sync projection semantikasi

- `packages/sync-protocol/src/index.ts`: `SyncPattaProjection.ish_soni`
  oddiy `number`, `null`/legacy holat ifodalanmaydi.
- Online va offline Patta service’lari `ish_soni`ni `patta_hisob` projectioniga
  qo‘shadi; bootstrap SQL ham DB qiymatini aynan shu nom bilan jo‘natadi.
- `apps/desktop/src/main/sync/sync-protocol.validation.ts` strict Zod schema
  `ish_soni`ni positive integer deb talab qiladi.
- Desktop pull/bootstrap mirror `ish_soni`ni local `patta_hisob`ga UPSERT
  qiladi. Hozirgi contractda operation soni bilan dona soni ajratilmagan.
- `SyncEventProcessor` handler registry hozir faqat `patta/CREATE`ni qo‘llaydi.
  Pull/bootstrap entity allowlist’lari print batch, size, print event, Sheet
  operation snapshot va row’larni hali bilmaydi.

### C. SQLite/offline Patta yaratish

- `OfflinePattaService.create()` bitta Patta yaratadi va snapshot sonini
  `ish_soni`ga yozadi.
- `SyncPattaCreatePayload` `ish_soni`ni umuman olib yurmaydi; server uni
  operation array uzunligidan chiqaradi.
- Local Patta mirror ushbu noto‘g‘ri semantikani saqlaydi; server echo
  tekshiruvi ham local va server `ish_soni`ni shu semantika bilan solishtiradi.
- `PattaLocalRepository`/IPC faqat SQLite lookup qiladi; online API fallback
  hozirgi desktop lookup oqimida mavjud emas. Main process’dagi authenticated
  HTTP boundary qayta ishlatilishi kerak.
- Hozirgi Patta offline `occurred_at` Patta yaratish/effective-price vaqtidir;
  `client_created_at` esa Patta entry/device timestamp. Sheet uchun alohida
  `entered_at` capture qilinadi va aynan shu qiymat badge resolutionga ishlatiladi.
- Additive SQLite migration kerak; tenant DB’ni o‘chirish/qayta yaratish
  mumkin emas.
- SQLite migration v1 `sync_queue` CHECK’i faqat `patta/CREATE`ga ruxsat beradi.
  Additive migration queue operation/entity contractini kengaytirib,
  mavjud queue/conflict/FK ma’lumotlarini transaction ichida saqlashi kerak;
  SyncEngine almashtirilmaydi.

### D. Patta Sheet row’dagi miqdor

- Hozirgi branchda sheet row implementatsiyasi yo‘q.
- Oldingi design va mockupda per-row editable `soni` ko‘rsatilgan. Bu noto‘g‘ri:
  worker har operation uchun `125`ni qayta kiritmaydi.
- Sheet service `quantity_snapshot = patta_hisob.ish_soni`ni server va local
  transaction ichida avtomatik yozishi, sync/accounting query’da parent qiymat bilan
  tengligini tekshirishi kerak.

### E. Konveyer

- `GeneratePattaDto`da `konveyer` optional bo‘lsa-da, template conveyor
  mavjud bo‘lmaganda `PattaService.generate()` `PATTA_KONVEYER_REQUIRED` bilan
  reject qiladi.
- `ModelLocalRepository.snapshotAt()` ham conveyor topilmasa reject qiladi.
- Migration 005 `patta_hisob.konveyer_snapshot NOT NULL` va non-empty canonical
  CHECK qo‘ygan.
- Yangi oqimda Patta chiqarish uchun conveyor majburiy emas; Patta Sheetda esa
  ish bajarilgan conveyor qog‘ozdan ixtiyoriy/manual kiritiladi. Uni Patta
  identity sifatida ishlatmaslik kerak.

### F. Operation reference va UI mavjudligi

- Asl `patta_operation_snapshots` Patta bilan bir transactionda yaratiladi va
  UPDATE/DELETE trigger bilan immutable.
- `PattaService.lookup()` Patta UUID qaytaradi, lekin operation snapshot
  summary’sida snapshot UUID yo‘q. Desktop `DesktopPattaLookup`/`publicPatta()`
  esa Patta UUID va operation snapshot UUID’larini renderer boundary’dan ham
  olib tashlaydi. Sheet source FK’larini qurish uchun bu UUIDlar main-process
  typed local lookup resultida bo‘lishi va zarur display ma’lumoti rendererga
  xavfsiz projection bilan uzatilishi kerak.
- Entry lookup API response’da Patta `ish_soni=NULL` legacy holatini buzmasdan
  qaytarishi, parent print batch’ning alohida `printed_at` qiymatini va operation
  snapshot UUID/model operation ID’larini typed shartnoma orqali berishi kerak.
- Sheet operation snapshot/row table va renderer ekran hozircha yo‘q.
- Avvalgi sheet designda tasdiqlangan yagona snapshot modeli yangi oqimga mos:
  Patta snapshotlari sheet snapshotiga copy qilinadi; custom operation sheet
  scope’da name/price oladi; row faqat
  `patta_sheet_operation_snapshot_id`ga FK qiladi.
- `apps/desktop/src/renderer/src/App.tsx` hozir login/session/sync sahifasigina.
  Apps ichida print layout (`window.print`, `printToPDF`, `@page`, `A4`) topilmadi.
  Patta print page, two-up A4 va batch summary alohida yangi UI bo‘ladi.

## Taklif etilayotgan oqim

### 1. Patta chiqarish va print

1. Operator active Model tanlaydi.
2. Batch common fields: `partiya_number`, majburiy positive `ish_soni` va
   `rang`; har bir Patta uchun razmer distribution item’i majburiy.
3. `razmer_distribution[]` har birida razmer va nechta alohida Patta chiqarilishi
   bor. Count mahsulot soni emas; 0 count item’lar yuborilmaydi. Umumiy Patta
   soni amaldagi max batch/number-block limitlaridan oshmaydi.
4. Har razmer count’i uchun alohida Patta yaratiladi. Har birida bir xil
   `ish_soni`, rang va partiya; o‘z razmeri hamda unique Patta raqami bo‘ladi.
5. Har Patta uchun o‘sha vaqtdagi operation name/price/order snapshotlari
   yaratiladi. `operation_count` snapshotlardan sanaladi va `ish_soni`ga ta’sir
   qilmaydi.
6. `patta_print_batches` parent, normalized size rows, har bir Patta, uning
    operation snapshotlari, audit va local queue bitta transactionda yoziladi.
    `patta_hisob.print_batch_id` batchga ulanadi. Offline’da stable UUIDlar va
    number-block’lardan foydalaniladi. Bitta batch aggregate event existing
    sync_queue/SyncEngine orqali yuboriladi; parallel sync tizimi yo‘q.
7. Faqat persisted Pattalar print qilinadi. Bitta A4 sahifaga ikkita Patta;
   batch summary’da jami pachka va razmerlar bo‘yicha Patta soni chiqadi.
   `printed_at` batchning birinchi muvaffaqiyatli print vaqtini saqlaydi;
   har print attempt append-only `patta_print_events`da qayd etiladi.
8. Oddiy reprint mavjud persisted Pattalarni aynan o‘sha raqam/qiymatlar bilan
    chop etadi; DB’dagi Patta business fields va number allocation o‘zgarmaydi.
    `Sana` Patta print/issue sanasi. U keyinchalik Sheet’ning `entered_at`iga
    almashtirilmaydi. `konveyer` blank/optional display field; generation uchun
    shart emas.

### 1.1 Partiya va Patta collision-safe allocation

- Batch uchun `partiya_number` operator input emas; tenant ichida global numeric
  sequence’dan olinadi. Model almashishi Partiya yoki Patta sequence’ni reset
  qilmaydi.
- Har print batch bitta yangi Partiya raqami oladi; batchdagi barcha Pattalar shu
  Partiya’dan foydalanadi. Har individual Patta esa existing tenant-wide Patta
  number sequence’dan alohida raqam oladi.
- Existing `patta_number_sequence`/`patta_number_blocks` Pattaga qoladi. Partiya
  uchun additive companion `patta_partiya_number_sequence` singleton va
  `patta_partiya_number_blocks` device range jadvallari qo‘shiladi. Inclusive
  BIGINT range, overlap exclusion, device owner, ACTIVE/EXHAUSTED/CANCELLED va
  monotonic usage semantics mavjud Patta block architecture bilan bir xil.
- `patta_print_batches.partiya_block_id` nullable reference bo‘ladi: online batch
  global sequence’dan bevosita oladi; offline batch o‘z device’iga tegishli
  reserved Partiya block’ni ko‘rsatadi. Har Patta item alohida existing Patta
  block ID’ni ko‘rsatadi; batch bir Patta block tugab boshqasiga o‘tishi mumkin.
  V2 projections/bootstrap/pull’da Partiya blocks o‘z entity type’i bilan mirror
  qilinadi. API online reserve/monotonic usage routes existing block controller
  patternini reuse qiladi.
- API route’lar `/api/v2/patta-partiya-number-blocks/allocate` va
  `/api/v2/patta-partiya-number-blocks/:id/usage` tenant/device validation bilan
  bo‘ladi. Offline aggregate’da `partiya_block_id` va har Patta `block_id` bor;
  server Partiya raqami/device/block membership’ni har birini qayta tekshiradi.
- Provisioning ikkala sequence’ni idempotent initialize qiladi. Partiya start
  `PARTIYA_NUMBER_START=1`; block size/max active block settings mavjud Patta
  config’ni qayta ishlatadi. Online batch create lock order `partiya sequence` then
  `Patta sequence`; batch/sizes/Pattas/snapshots/number increments one DB
  transaction.
- `patta_hisob.partiya_number` automatic Partiya decimal string bo‘lib qoladi;
  Partiya sequences/block ranges positive PostgreSQL BIGINT, API/SQLite’da
  canonical decimal string. Partiya allocation yo‘lida `MAX()+1` yo‘q.
- Offline print batch only consumes its device-reserved Partiya block and Patta
  block, saved together in one SQLite transaction. Partiya block missing or
  exhausted disables new batch print; existing Patta Entry remains available.
  Two PCs’ ranges cannot overlap.
- `UNIQUE(partiya_number, patta_number)` remains; `patta_print_batches` also has
  `UNIQUE(partiya_number)`. Successful/printed/VOID numbers never reallocate.
  A DB transaction that fails before print rolls back both sequence increments
  and no issued number exists; printer failure after commit does not release any
  number. Correction/reprint keeps the batch’s Partiya; replacement batch uses
  fresh Partiya + Patta numbers.

### 1.2 Print correction

- Plain reprint bilan correction ikki alohida action va endpoint/service flow.
- Correction `expected_version` talab qiladi, `patta.chiqarish.correct`
  permission bilan tekshiriladi, batch version/revision/audit/change-log va Patta
  updates bir transactionda commit bo‘ladi.
- `ish_soni`, rang va size distribution tuzatilishi mumkin. Bir xil razmerdagi
  mavjud Patta identity/numberlar deterministic preserve qilinadi:
  1. Har razmerda target count ichidagi Pattalar patta number ascending tartibda
     o‘z razmerida qoladi.
  2. Qolgan ACTIVE Pattalar number ascending tartibda tuzatilgan size rows’ning
     `sort_order` bo‘yicha hali to‘lmagan joylariga biriktiriladi.
   3. Target distribution’dan ortib qolgan Pattalar `VOID` qilinadi.
  4. Target distribution’da hali joy yetishmasa allocator’dan yangi numberlar
     olinadi.
  Shu algoritm re-run’da bir xil mapping beradi.
- Hech qachon Patta number bo‘shatilmaydi yoki qayta ishlatilmaydi. Partiya/Patta
  business key unique qoladi; VOID Pattalar DB/history’da qoladi.
- `patta_hisob` bugun blanket immutable trigger bilan himoyalangan. Yangi
  migration trigger policy’ni versioned correction service bilan toraytirib,
  correction revisioni/auditi bo‘lmagan UPDATE’ni rad etishi kerak.
- `patta_sheets` entry mavjud bo‘lmasa batch `ish_soni`/rang correction’i batch
  revisionida saqlanadi. Entry mavjud bo‘lsa (ACTIVE yoki TRASHED) quantity/rang
  faqat controlled entry-aware correction orqali qilinadi: Patta parent va
  `ish_soni` o‘zgarsa barcha non-deleted row quantity snapshotlar bir transactionda
  o‘zgaradi; `entered_at`/worker IDs saqlanadi; `patta.chiqarish.correct` hamda
  `patta_varaq.edit` ruxsatlari va version/audit/change-log tekshiriladi.
- Size distribution correction old Patta’ni aynan shu razmerda qoldirib faqat
  yangi Patta qo‘shsa mumkin. Mavjud Patta’ni boshqa razmerga remap yoki VOID
  qilish talab qilinsa va unga ACTIVE/TRASHED entry bog‘langan bo‘lsa
  `PATTA_ALREADY_IN_USE`. Model/Partiya identity correction ham entry borida
  bloklanadi; entry yo‘q bo‘lsa eski batch/Pattalar VOID/SUPERSEDED va replacement
  batch yangi raqamlar bilan yaratiladi. Trashed entry restore mumkin, shu sabab
  in-use hisoblanadi.
- Legacy `ish_soni=NULL`ni bir martalik audited correction actor/reason/before/
  after/version/change-log bilan to‘ldirish mumkin; assignment rowlari mavjud
  bo‘lsa shu entry-aware correction transactionida row quantity’lari ham
  birga yangilanadi.

### 2. Patta Sheet entry

1. Operator Partiya № + Patta № bilan lookup qiladi. SQLite birinchi; topilmasa
   internetda authenticated API. Lookup faqat Patta va operation metadata’ni
   ko‘rsatadi; Sheet, entered_at, queue yoki accounting row yaratmaydi.
2. Existing Patta operationlari gridda ko‘rsatiladi. Barcha badges kiritilguncha
   faqat local `entry_buffer` ishlaydi: crash recovery uchun SQLite’da raw badge,
   provisional name, Nuqson, custom operation reference/conveyor saqlanadi.
   Buffer parent/rows business Entry emas, sync qilinmaydi, accountingga
   kirmaydi va `Kiritilgan Pattalar`da ko‘rinmaydi. Custom model operation’ning
   o‘zi esa normal model mutation sifatida alohida persist/queue qilinadi.
3. Operator Jetonlarni string sifatida yuqoridan pastga kiritadi; provisional
   preview worker local badge history’dan ko‘rsatiladi. Oxirgi required
   operation Jetonida valid raqam kiritilib Enter bosilganda validation va final
   write bitta SQLite transactionda bajariladi: transaction ichida current
   `entered_at` bir marta olinadi, barcha badges shu timestamp bo‘yicha qayta
   resolve qilinadi. Unknown badge bo‘lsa transaction rollback, xato qatoriga
   focus va business Entry yo‘q. Final resolve provisional worker’dan farq qilsa
   yangi ism ko‘rsatiladi va operator qayta Enter bilan tasdiqlaydi; saqlangan
   `entered_at` original final-validation timestamp bo‘lib qoladi.
4. Hammasi valid bo‘lsa bitta SQLite transactionda Entry UUID, `entered_at`,
   tenant timezone’dagi `business_date`, optional conveyor, sheet operation
   snapshots, assigned rows va aggregate sync event yoziladi. Server ham
   business rows, audit, change-log va processed result’ni bitta transactionda
   commit qiladi. Faqat shu commit’dan keyin Model hisob contributioni bor.
5. Har resolved assignment row’da `worker_id` va
   `quantity_snapshot = patta_hisob.ish_soni`; operator quantity kiritmaydi.
   `Nuqson` rowni saqlaydi. Grid O‘chirish faqat assignment row’ni
   `deleted_at/deleted_by` bilan soft-delete qilib contributionni olib tashlaydi;
   snapshot qoladi, reassign yangi row UUID oladi.
6. Custom operation creation normal Model operation event. Sheet modeli uchun
   existing active canonical name topilsa model_operation_id reuse qilinadi; yangi
   name/price bo‘lsa `patta_varaq.custom_operation` bilan stable UUID, ACTIVE
   model operation va price history yaratiladi. Sheet operation snapshot name/
   price’ni immutable saqlaydi; keyingi shu model Patta print’lari operation’ni
   avtomatik oladi, boshqa modeldagi shu nom alohida ID.
7. New operation event ID’ga tayanadigan Sheet update va keyingi print batch
   event’lari `sync_event_dependencies` bilan bog‘lanadi. SyncEngine prerequisite
   eventni yuborib, reference pull/cursori yangilangandan keyin dependent Patta
   eventining faqat yuborilmagan reference_cursor’ini yangilaydi; stable event ID
   va business snapshot o‘zgarmaydi. Conflict’da barcha local work qoladi.
8. Har business create/edit/row-clear/whole-entry delete/restore/purge local
   queue bilan bitta transaction. “Kiritilgan Pattalar” history’da Edit
   `expected_version` bilan; `entered_at` o‘zgarmaydi, badge worker original
   entered_at bo‘yicha qayta yechiladi.
9. Whole-entry Delete `deleted_at/deleted_by` bilan Korzinkaga o‘tkazadi;
   restore metadata’ni tozalab ayni entry contributionini qaytaradi. Permanent
   purge faqat trashed parent’da: Sheet rows/snapshots/parent business data
   physical delete, printed `patta_hisob` qoladi, purge audit/tombstones qoladi.
   Purged Patta qayta kiritilsa yangi Sheet UUID va entered_at oladi.

### Print page va entry page alohida

- **Patta Print**: Model, Partiya №, `ish_soni`, Rang, razmer distribution;
  `Pechat qilish`, `Qayta pechat`, `Tuzatish va qayta pechat` actions. Batch
  summary shu sahifada.
- **Patta Entry / Patta Sheet**: `Sana` = auto `entered_at`; `business_date` shu
  timestampning tenant-timezone sanasi; `Pechat sanasi` alohida field;
  `Konveyer` optional/manual; Partiya № + Patta № lookup; Model, `ish_soni`, Rang,
  Razmer va operation snapshotlar read-only.
- **Kiritilgan Pattalar** history’da Sana, Partiya №, Patta №, Model, Razmer,
  Rang, Ish soni, Konveyer, Edit va Delete ko‘rinadi. Delete confirmation:
  `Korzinkaga yuborilsinmi?`. **Korzinka** esa Sana,
  Partiya/Patta, Model, Ish soni, O‘chirilgan sana, O‘chirgan foydalanuvchi bilan
  Restore va alohida Butunlay o‘chirish actionlarini ko‘rsatadi. Purge oldidan
  Uzbek confirmation `Bu amalni ortga qaytarib bo‘lmaydi` ko‘rsatiladi.
- Bu alohida navigation/screens; Patta print forma entry badge grid bilan
  qo‘shilmaydi.

## Tenant timezone contract

Repositoryda company-level IANA timezone allaqachon Master
`companies.timezone`da bor; `CompaniesService` uni validate qiladi va default
`Asia/Tashkent`. Yangi timezone column yoki global hard-code qo‘shilmaydi.

Master lookup timezone’ni hozir select qilmaydi; resolver/auth context, login/
refresh response va Desktop encrypted session ham hozircha timezone olib yurmaydi.
Additive auth/session contract existing Master `companies.timezone`ni trusted
context va Electron main runtime’ga uzatadi. UTC `entered_at` canonical ISO
timestamp; `business_date = (entered_at AT TIME ZONE companies.timezone)::date`.
Desktop cached trusted tenant timezone’dan offline sana hisoblaydi.
Sync server Master timezone bilan `business_date`ni tekshiradi, lekin persisted
`entered_at` va locally derived date’ni sync receipt time bilan almashtirmaydi.
Eski secure session timezone’siz bo‘lsa timezone online refresh bo‘lguncha
unknown; new Sheet create `TENANT_TIMEZONE_UNAVAILABLE` structured error bilan
bloklanadi, mavjud local entries read-only ko‘rilishi mumkin.

### 3. Model hisob va payroll-ready ma’lumot

Model hisob manbasi alohida saqlanadigan manual total emas; query
`patta_hisob.status='ACTIVE'`, `patta_sheets.deleted_at IS NULL` va
`patta_sheet_rows.deleted_at IS NULL` bo‘lgan assignment rows’dan darhol
chiqariladi:

```text
GROUP BY model_id, model_operation_id, worker_id
SUM(quantity_snapshot)
```

Operation identity `model_id + model_operation_id`. Har bir modelning o‘z
`model_operations.id`si bor; bir xil nomli operation boshqa modelda boshqa
identity hisoblanadi. Original Sheet snapshot `source_patta_operation_snapshot_id`
orqali Patta tarixini ham saqlaydi. Custom operation esa yangi/reused stable
`model_operation_id` orqali shu modelning kelajakdagi hisobi bilan birlashadi;
display name hech qachon operation identity bo‘lmaydi.

Model hisob UI payroll emas: rows=worker identity (`worker_id`), columns=shu
modelning `model_operation_id`lari, cells=`SUM(quantity_snapshot)`. Ism faqat
join/display. Aggregation API query, offline local counterpart va read-only grid
shu feature scope’da; payroll money calculation scope’dan tashqarida.

## Additive schema va legacy ma’lumot

### PostgreSQL tenant DB

Committed migrationlar o‘zgartirilmaydi. Ketma-ket yangi tenant migrationlarda:

- `patta_print_batches`: `id`, `model_id`, `model_name_snapshot`,
  `partiya_number`, positive `ish_soni`, rang, `status ACTIVE/VOID/SUPERSEDED`,
  `version`, `revision`, nullable `corrected_from_batch_id`, created/updated
  actor/device/timestamps va `printed_at` (birinchi muvaffaqiyatli print) saqlaydi.
  `patta_print_batch_sizes` normalized child rows bo‘lib, har razmer uchun
  `patta_count`, `sort_order`, CHECK `patta_count > 0`, unique
  `(print_batch_id, canonical_razmer)` saqlaydi. Pattalarda nullable
  `print_batch_id` qo‘shiladi; old legacy Pattalarda NULL.
- `patta_hisob.status ACTIVE/VOID` va `print_batch_id` bo‘ladi. `patta_print_events`
  append-only physical attempt (`batch_id`, batch revision, INITIAL/REPRINT/
  CORRECTED_REPRINT, requested/succeeded/failed, `printed_at`, actor/device)
  qayd qiladi. Batch correction revisioni `version/revision` increment va
  AuditService before/after’da old/new size child rows bilan saqlanadi; current
  distribution JSONB field’da emas, `patta_print_batch_sizes`da qoladi.
- `patta_hisob`ga `status ACTIVE/VOID` qo‘shiladi. VOID Patta, unique business key
  va number history saqlanadi; allocator hech qachon VOID raqamni qaytarmaydi.
  `print_batch_id` va status yangi projection/mirror’larda aks etadi.
- Eski `patta_hisob.ish_soni` column’i
  `legacy_operation_count` nomiga rename qilinadi; eski qiymat aynan saqlanadi.
- Yangi `ish_soni INTEGER NULL` qo‘shiladi; `NULL` = eski Pattada haqiqiy dona soni
  noma’lum. CHECK: NULL yoki `> 0`.
- `patta_hisob` yozish service invarianti yangi Pattalarda `ish_soni > 0`
  talab qiladi. Keyinchalik legacy backfill tugagach NOT NULL alohida migrationda
  kiritilishi mumkin.
- Legacy actual quantity ma’lum bo‘lsa, bir martalik audited correction
  `patta.chiqarish.correct` bilan bajariladi: actor, reason, before/after, version,
  audit va change-log saqlanadi. Oddiy entry operatoriga override berilmaydi;
  bulk backfill alohida privileged migration/admin path.
- `konveyer_snapshot` nullable qilinadi; canonical CHECK null’ni qabul qiladi.
- Sheet tables: `patta_sheets` (one per Patta unique),
  `entered_at TIMESTAMPTZ NOT NULL` (create’da set qilinadi, keyin immutable),
  `business_date DATE NOT NULL`, version, optional/manual conveyor, `created_by`,
  `created_at`, `updated_at`, `deleted_at`, `deleted_by`; lifecycle faqat
  non-deleted yoki soft-deleted metadata bilan ifodalanadi, workflow status yo‘q.
  UI `Sana` immutable `entered_at`ni ko‘rsatadi.
  `business_date = entered_at`ning company timezone’dagi local calendar date’i.
  `patta_sheet_operation_snapshots`,
  `patta_sheet_rows`. Har operation snapshotda `model_operation_id FK NOT NULL`
  bo‘ladi; custom/original farqi `source_type` va nullable source Patta snapshot
  orqali ajratiladi. Operation snapshot immutable; unique
  `(patta_sheet_id, model_operation_id)` bo‘ladi. Snapshot price
  `NUMERIC(14,2) >= 0`, nom canonical/non-empty. Row operation FK faqat sheet
  snapshotga; worker FK `BIGINT workers.id`; `quantity_snapshot INTEGER > 0`;
  `nuqson BOOLEAN`; row-level `deleted_at/deleted_by` assignment contributionini
  hisobdan chiqaradi. Active assignment uchun partial unique
  `(patta_sheet_id, patta_sheet_operation_snapshot_id)` index qo‘yiladi.
- `patta_sheets.entered_at` update trigger bilan immutable; entry edit faqat
  optional conveyor/version/updated metadata kabi ruxsat etilgan maydonlarni
  o‘zgartiradi. Parent `deleted_at/by` faqat trash/restore lifecycle’da o‘zgaradi.
  Sheet operation snapshots ordinary UPDATE’dan immutable; custom operation
  rename/price change yangi snapshot yozuvini yaratmaydi. Snapshot/row hard DELETE
  faqat parent TRASHED purge service transactionida ruxsat etiladi; boshqa
   DELETE’lar DB trigger bilan reject.
- Legacy Patta lookup’da `ish_soni=NULL` noma’lum ko‘rsatiladi; normal entry row
  yaratish quantity correction/backfill bo‘lmaguncha bloklanadi. Actual donani
  operation count’dan hech qachon taxmin qilmaymiz.
- `patta_hisob` blanket immutable triggeri correction guard’ga almashtiriladi:
  no-entry batch correction `expected_version` va append-only revision audit bilan
  ruxsat etiladi. Kiritilgan entry bilan controlled update parent Patta va barcha
  row quantities’ni bitta transactionda yangilaydi; model/partiya identity change
  replacement batch talab qiladi. Original va sheet operation snapshots immutable.
- Down migration actual quantity, batch correction history, VOID Pattalar yoki
  sheet/audit/sync rows bor bo‘lsa old semantikaga data loss bilan qaytmaydi;
  fail-safe bloklaydi.
- Audit migration `patta_print_batch`, `patta_print_event`, `patta_entry` va
  custom model operation action/entity codes’ni append-only audit CHECK’lariga
  qo‘shadi: kamida `patta_entry.create/update/trash/restore/purge`. Purge
  `before` snapshotida entry/Patta/Partiya IDs, actor, vaqt va korxona identiteti
  yoziladi; child payloadni auditga nusxalash shart emas.
   `TenantDatabaseManager.grantRuntimePrivileges()` batch, size, print-event,
   Sheet, Sheet operation snapshot, row va yangi operation reference DML grants beradi.
- New permissions `patta_varaq.delete`, `patta_varaq.restore`,
  `patta_varaq.purge`, `patta_varaq.custom_operation` seed/migration orqali
  mavjud tenantlarga qo‘shiladi va system admin role’ga biriktiriladi.

### SQLite

Additive numbered migration (mavjud migrationlarni tahrir qilmasdan) eski
`ish_soni`ni `legacy_operation_count` sifatida saqlab, yangi nullable actual
`ish_soni` ochadi. SQLite v1 mirror, local offline Patta batch create,
lookup, echo comparison, bootstrap/pull UPSERT va tombstones yangi contractga
mos yangilanadi. `patta_partiya_number_blocks`, `patta_print_batches`, normalized
batch sizes, Patta status/batch FK va Patta Sheet operation snapshots/rows local
mirrorga qo‘shiladi. Partiya/Patta block consumption batch transactionida birga
ishlaydi; allocated ranges local’da `MAX()+1` bilan hosil qilinmaydi.
`entry_buffer` alohida local working table: lookup/grid badge typing buffer’ni
yaratadi/yangilaydi; entry business table, queue, history va account query’da
chiqmaydi. Final Enter transaction’da validate bo‘lgach parent/rows/queue yozilib,
buffer o‘chiriladi. Crash recovery buffer’ni tiklaydi; buffer hech qachon
serverga sync qilinmaydi.
Print-batch aggregate correction queue event stable event ID/version bilan
coalesce qilinadi; `SYNCING` payload o‘zgarmaydi. Optional local print events ham
sync/audit lifecycle’da saqlanadi. `entered_badge_number` faqat local/sync
evidence, identity emas. DB hech qachon delete/recreate qilinmaydi.

## Sync contract va compatibility

- New print flow batch aggregate event’da har Patta/snapshot stable UUID va
  required positive `ish_soni` yuboradi; server snapshot sonidan quantity
  chiqarmaydi. Existing `patta/CREATE` handler migratsion v2 recovery’da qolishi
  mumkin, lekin v1 envelope’dan yangi Patta yaratishga ruxsat berilmaydi.
- Yangi print flow `patta_print_batch CREATE/UPDATE` aggregate event ishlatadi:
  batch metadata, normalized size distribution, client-generated Patta IDs,
  Pattalarning `ish_soni`/rang/razmeri va operation snapshots. Server bir event
  transactionida block membership, unique business key, legacy quantity policy,
  Patta/snapshot writes, audit/change log va batch state’ni commit qiladi.
- Patta print correction `base_version`/`expected_version` bilan boradi;
  correction audit va Patta number lifecycle bir transactionda.
- Sheet mutation operations CRUD’da qoladi: `CREATE`, `UPDATE`, `DELETE`.
  `UPDATE` worker/custom operation/conveyor/nuqson editi, row soft-delete, parent
  TRASH va RESTORE’ni `deleted_at/deleted_by` orqali ifodalaydi. `DELETE` faqat
  TRASHED entry PURGE qiladi. Barcha mutationlar expected/base version bilan;
  mismatch `VERSION_CONFLICT`.
- Shared `SyncMutationOperation`, API event parser/registry va Desktop local
  `sync_queue` entity tables yangilanadi; mutation enum CRUD’da qoladi.
  `sync_event_dependencies(event_id, prerequisite_event_id)` sync dependency’ni
  durable saqlaydi; SyncEngine faqat prerequisites `SYNCED` bo‘lgan eventlarni
  topological tartibda push qiladi. Existing sync engine/idempotency/transport
  ishlatiladi.
- Batch status, size child rows, VOID Pattalar, Patta snapshots va print events
  mavjud `SyncEventProcessor`, `SyncChangeRecorder`, pull/bootstrap va
  `SyncEngine` orqali mirror qilinadi. Batch-size/Patta count va event payload
  hajmi server config bilan bounded bo‘ladi.
- Desktop yangi normal model operation uchun stable UUID va `model_operation/CREATE`
  event ID’ni local transactionda yaratadi. Sheet UPDATE va shu operation ID’ga
  tayanadigan keyingi Patta print aggregate’lari operation event’ga explicit
  dependency oladi. SyncEngine prerequisite SYNCED bo‘lib, pull/bootstrap cursor
  ref projectionni qamrab olmaguncha Sheet/print eventni push qilmaydi. Birinchi
  marta yuborilishidan oldin PENDING dependent event’ning reference cursori shu
  yangi ref cursorga yangilanadi; event UUID saqlanadi, event hali serverga
  yuborilmaganligi uchun fingerprint yangilangan payload bilan birinchi bor
  yaratiladi. Dependency permission conflict bo‘lsa local operation/Sheet/Patta
  ishlari saqlanadi va Uzbek conflict ko‘rsatiladi. Queue prerequisite eventini
  barcha dependents tugamaguncha retention cleanup’dan chiqarib tashlaydi.
- Historical Patta migrationda `ish_soni=NULL` va `legacy_operation_count` alohida
  qoladi. V1 REST yoki Sync projectionda actual `ish_soni` noma’lum bo‘lsa server
  `SYNC_PROTOCOL_UPGRADE_REQUIRED` / `PATTA_QUANTITY_UNKNOWN` qaytaradi; operation
  countni hech qachon `ish_soni` nomida yubormaydi.
- V1 `patta/CREATE` payloadida positive product `ish_soni` bo‘lmasa create
  `SYNC_PROTOCOL_UPGRADE_REQUIRED` bilan rad etiladi. Legacy eventni noma’lum
  `ish_soni` bilan yozish fallback’i tanlanmaydi.
- Strict v1 schemas o‘zgartirilmaydi. V1 Patta generation/read/push/pull/bootstrap
  yangilangan quantity/batch semanticsini ifodalay olmaydi, shuning uchun Patta
  create yoki Patta projection talab qilingan v1 request’ga
  `SYNC_PROTOCOL_UPGRADE_REQUIRED` qaytariladi. V1 boshqa mos entitylarni davom
  ettirishi mumkin; Patta quantity yoki Purge tombstone jim tashlab ketilmaydi.
- New desktop protocol v2 capability bilan pull/bootstrap qiladi. V2 projection
  `ish_soni: number|null` va `legacy_operation_count`ni alohida ifodalaydi.
  Mavjud v1 `server_change_log` Patta payloadida operation soni `ish_soni` bo‘lib
  qolgan bo‘lsa, v2 adapter uni `legacy_operation_count`ga map qilib actual
  `ish_soni=null` beradi; stored append-only result/change log o‘zgartirilmaydi.
- Custom normal operation alohida `model_operation CREATE` event bo‘ladi; server
  OperationsService create/history/audit logicini `patta_varaq.custom_operation`
  bilan chaqiradi, stable model-scoped ID’ni preserve qiladi va
  `effective_from=Sheet.entered_at`ni faqat brand-new operationning birinchi
  price history entry’sida ishlatadi. Existing operation price intervalini
  backdate qilmaydi.
- Patta Sheet `CREATE/UPDATE` aggregate operation ID’ni reference qiladi. Server
  badge history’ni immutable `entered_at`da qayta yechadi, quantity va timezone
  date’ni tekshiradi, audit/change-log va idempotent resultni commit qiladi.
  `UPDATE` ichida sheet/row `deleted_at` o‘zgartirish TRASH/RESTORE; `DELETE`
  faqat TRASHED sheet uchun purge. `patta_varaq.delete/restore/purge` permission
  tekshiriladi. PURGE transactionida row/snapshot/parent child-to-parent tartibda
  fizik o‘chadi va har entity uchun change-log DELETE tombstone yoziladi; audit
  va processed event history qoladi.
- Offline event `entered_at`ni Sheet yaratishdagi local timestamp bilan yuboradi;
  SyncEvent envelope’dagi `occurred_at` ham shu `entered_at`ga teng. API server
  receipt timestamp’ni alohida audit/change-log time sifatida saqlaydi, lekin
  Sheet `entered_at`ni hech qachon almashtirmaydi.
- Pull/bootstrap entity set includes the existing Patta blocks plus
  `patta_partiya_number_blocks`, `patta_print_batches`,
  `patta_print_batch_sizes`, `patta_print_events`, `patta_sheets`,
  `patta_sheet_operation_snapshots`, `patta_sheet_rows`. Client-generated sheet,
  batch, size, snapshot va row UUIDs serverda saqlanadi. Pattalar va ularning
  immutable original operation snapshots existing mirror/projectionlar orqali
  olinadi.
- Sync PUSH DELETE outcome `projection=null` va parent sequence’dan keyingi final
  `change_sequence` qabul qiladi; push result handler parent va barcha children’ni
  local SQLite’dan child-to-parent fizik purge qiladi. Pull DELETE ham parent
  TRASHED ekanini tekshirib, children + parent + tombstones + cursorni bitta local
  transactionda qo‘llaydi. Old queued UPDATE version/purge’dan keyin
  `ENTRY_PURGED` conflict bo‘ladi; stale row reappear qilmaydi.
<!-- The following note is superseded by the clear tombstone policy below.
- Desktop DELETE pull apply, agar change entity `patta_sheets` bo‘lsa va local
  Sheet TRASHED bo‘lsa, rows → Sheet operation snapshots → Sheet physical delete
  qiladi, tombstones yozadi va cursorni shu SQLite transactionda ilгээнэ. Server
  stale UPDATE-ийг `ENTRY_PURGED` conflict болгоно. Local purge echo-д ч ижил
  safe child delete хийгдэнэ; original Patta mirror-д untouched.
- Canonical purge apply: a server DELETE for a previously TRASHED `patta_sheets`
  aggregate physically removes local rows, operation snapshots and parent in
  child-to-parent order, stores tombstones and advances the cursor in one SQLite
  transaction. A stale UPDATE returns `ENTRY_PURGED`; printed Patta data remains.
-->
- For a PURGE DELETE change, Desktop physically deletes local rows, Sheet operation snapshots, and the TRASHED parent in FK-safe child-to-parent order inside the same pull/cursor transaction, and retains tombstones. A stale UPDATE after purge returns `ENTRY_PURGED`; the original printed Patta and snapshots are untouched.
- Badge mismatch `CONFLICT_BADGE_ASSIGNMENT`, purged entry stale update
  `ENTRY_PURGED`, correction-in-use `PATTA_ALREADY_IN_USE`. Conflict local
  `sync_conflicts`da saqlanadi; silent overwrite yo‘q.

## REST boundary

Eski clientlar bilan response semanticsni ajratish uchun Patta product/print
contract v2 route’larda bo‘ladi:

```text
POST /api/v2/patta-print-batches
PATCH /api/v2/patta-print-batches/:id
GET /api/v2/patta/lookup?partiya_number=...&patta_number=...
```

`/api/v1/patta/*` eski clients uchun structured upgrade error qaytaradi;
quantity semanticsni aralashtirgan Patta response bermaydi. V1 generate payload’da
mahsulot miqdori bo‘lmasa Patta yaratish `SYNC_PROTOCOL_UPGRADE_REQUIRED` bilan
rad etiladi. V2 lookup parent UUID,
actual nullable `ish_soni`,
`legacy_operation_count`, batch `printed_at`, Patta operation snapshot UUID va
model operation ID’larini typed response’da qaytaradi.

Yangi Sheet routes ham v2’da:

```text
GET  /api/v2/patta-sheets/by-patta?partiya_number=...&patta_number=...
GET  /api/v2/patta-sheets
GET  /api/v2/patta-sheets/trash
POST /api/v2/patta-sheets
PATCH /api/v2/patta-sheets/:id
PATCH /api/v2/patta-sheets/:id/rows/:rowId
DELETE /api/v2/patta-sheets/:id/rows/:rowId
DELETE /api/v2/patta-sheets/:id
POST /api/v2/patta-sheets/:id/restore
POST /api/v2/patta-sheets/:id/purge
GET  /api/v2/models/:modelId/account-sheet
```

Sheet `POST` darhol non-deleted accounting entry yaratadi. `DELETE` soft trash,
`restore` Korzinkadan qaytaradi, `purge` faqat TRASHED entry’ni hard-delete qiladi.
Controllerlar thin qoladi; print batch correction, Patta lookup/quantity,
Sheet edit/trash/restore/purge va sync bitta domain service’larning
transactional seam’larini ishlatadi.
`account-sheet` active rows’ni model operation va worker ID bo‘yicha agregatsiya
qiladi, worker name’ni faqat join/display qiladi; permission `patta_varaq.view`.

## Audit, RBAC va API boundary

Tenant permissions `patta_varaq.view/create/edit/delete/restore/purge/custom_operation`
ishlatiladi. Print correction `patta.chiqarish.correct` bilan, normal Print
`patta.chiqarish.create` bilan. Platform token tenant guardsda rad qilinadi. Sync push route
`sync.push`ni tekshiradi; hozirgi static `patta.chiqarish.create` requirement
Sheet va boshqa operationlar uchun generic ishlatilmaydi. Event handler entity
va transition bo‘yicha biznes ruxsatini serverda tekshiradi:
`patta/CREATE` va print-batch CREATE — `patta.chiqarish.create`;
batch correction/legacy quantity fix — `patta.chiqarish.correct`; Sheet create/edit
— `patta_varaq.create/edit`; trash/restore/purge — alohida permission; custom
same-model operation create — `patta_varaq.custom_operation`.
SyncController push route’ining static RBAC talabi faqat `sync.push` bo‘ladi;
`patta.chiqarish.create` barcha push events uchun AND qilib talab qilinmaydi.
Sync event transaction handler’i authenticated actor’ning tenant permissions’ini
event entity/action bo‘yicha qayta tekshiradi; platform token tenant sync’ga
hech qachon kira olmaydi.

Sheet create/update/trash/restore/purge auditlari biznes transactioni bilan birga
yoziladi. Existing AuditService, SyncChangeRecorder, SyncEventProcessor,
authenticated transport, SyncEngine va sync queue qayta ishlatiladi; parallel
sync engine yaratilmaydi.

## PostgreSQL / SQLite verification scope

PostgreSQL acceptance:

- Migration up/down/reapply; legacy `ish_soni` qiymati
  `legacy_operation_count`da o‘zgarmas; new `ish_soni` unknown/null.
- Batch create/size rows/Pattalar/snapshots all-or-nothing; repeated size count
  unique Patta numbers beradi, physical print retry number allocation qilmaydi.
- Batch correction version conflict, append-only before/after audit, deterministic
  identity matching, extra Patta VOID va new Patta allocation; VOID raqam qayta
  berilmaydi.
- Batch correction eligibility: entry yo‘q, Kiritilgan, Trashed va Purged Patta.
  Kiritilgan/Trashed entry’da explicit correction parent va barcha row quantities’ni
  atomik yangilaydi; distribution replacement esa Patta’ni band qilgan Sheet
  mavjud bo‘lsa reject.
- Oddiy reprint batch/Pattalar/raqamlarni o‘zgartirmaydi; correction va corrected
  reprint yangi revision/print event saqlaydi.
- Modelda 13 operation, Patta’da `ish_soni=125` →
  `patta_operation_count=13`, `ish_soni=125`.
- Shu modelga 14-chi model operation qo‘shilganda eski Patta operation snapshot
  count’i va `ish_soni=125` o‘zgarmaydi; keyingi Patta yangi snapshotni oladi.
- Ikki modelda bir xil nomli operation’lar turli `model_operation_id` oladi;
  model hisobi cross-model name collision bilan aralashmaydi.
- XS=1, S=1 distribution → ikkita Patta, ikkalasida `ish_soni=125`; unique
  partiya/Patta va raqam block invariants saqlanadi.
- Custom sheet operation name/price snapshot; original Patta operation
  snapshots va Patta `ish_soni` o‘zgarmas; custom model operation stable ID
  oladi, boshqa modeldagi shu nomli operationdan ajraladi, sheet narxi immutable.
- Har active entry row `quantity_snapshot=125`; quantity mismatch server reject.
- Entry Create/row assignment commit’i bilan Model hisob contribution darhol
  paydo bo‘ladi; worker Edit 18→47 aggregationni shu transactionda ko‘chiradi.
- Badge 018 old intervalda worker 18, yangi intervalda worker 47; Sheet
  `entered_at` eski intervalda bo‘lsa 18, yangi intervalda bo‘lsa 47. Keyingi
  reassignment old row’dagi `worker_id`ni o‘zgartirmaydi.
- Offline Sheet `entered_at=10:30`, sync receipt `17:00`: server original
  `entered_at`ni saqlaydi va 10:30 bo‘yicha badge history’ni qayta yechadi.
  `business_date` midnight/offset scenario’da tenant timezone bo‘yicha chiqadi.
- Expected-version Edit, row O‘chirish, whole-entry TRASH/RESTORE/PURGE permission,
  audit, tenant isolation, change-log/bootstrap/pull. PURGE faqat TRASHED’da va
  hard-delete’dan keyin audit/tombstone qoladi.

SQLite/Electron acceptance:

- Additive migration eski DB/business rows/queue/conflictsni saqlaydi.
- Offline multi-size Patta batch: number blocks, positive `ish_soni`, snapshots,
  local Pattas va stable queue events bitta SQLite transactionda.
- Offline batch correction/reprint, batch aggregate push/pull, deterministic
  Patta number retention/void/no-reuse, two-PC batch and correction echo.
- Offline Patta lookup, entered_at badge resolve, auto quantity, `Topilmadi`,
  active entry restart/edit va later sync.
- Offline TRASH/RESTORE/PURGE va two-PC propagation; PURGE boshqa PC local business
  rowlarini ham physical o‘chiradi, audit/tombstone bilan reappearance bo‘lmaydi.
- Concurrent stale Edit `VERSION_CONFLICT`; echo UUID preserve. Patta Entry create
  darhol accountingga kiradi; alohida lifecycle status transitioni yo‘q.
- Keyboard Jeton→Enter→keyingi Jeton; Nuqson/O‘chirish alohida.
- Print acceptance: A4’da 2 Patta, size/partiya batch summary, persisted Patta’dan
  reprint; page-break/odd-count 13→7.

Existing infrastructure: API `npm run test:patta`, `npm run test:sync`, workspace
lint/typecheck/test:e2e/build; desktop tests Electron-compatible SQLite runner
orqali `npm run test --workspace=apps/desktop`; real PostgreSQL faqat dedicated
`TEST_MASTER_DB_*` `_test` database va generated tenant DBlar bilan. Missing
credentials DB test pass hisoblanmaydi.

## Tasdiq va joriy holat

User belgilagan biznes qarorlari spec’ga kiritildi; alohida operational
timestamp field yoki biznes qarori ochiq qolmadi. Tenant timezone mavjud Master
`companies.timezone`dan olinadi; default `Asia/Tashkent`. Patta Sheet `Sana`,
badge resolution va `business_date` barchasi immutable `entered_at`ga bog‘langan.

Quyidagilar design’da hal qilingan va implementation plan’da alohida testlanadi:

- Eski `ish_soni` value faqat `legacy_operation_count`; actual dona unknown.
- Haqiqiy legacy quantity faqat bir martalik permission/audit/reason/version/
  change-log correction yoki bulk backfill bilan qo‘shiladi.
- Patta Entry create darhol Model hisob source’iga kiradi; Edit, row clear,
  whole-entry Trash/Restore/Purge versioned va auditable.
- Partiya/model identity correction old batch/Pattalarni supersede/VOID qilib
  yangi Patta raqamlar bilan replacement batch yaratadi; raqamlar qayta
  ishlatilmaydi.
- Custom operation stable same-model `model_operation_id` oladi; yangi
  operation `patta_varaq.custom_operation` permission bilan yaratiladi; offline
  local work saqlanadi, server ruxsati yo‘q bo‘lsa structured conflict chiqadi.

Model hisob read-only grid ham shu feature scope’iga kiritildi; u worker rows,
model operation columns va active non-deleted rowlardan hisoblangan quantities’ni
ko‘rsatadi. Payroll pul hisoblashlari scope’dan tashqarida.

User spec va implementation plan’ni tasdiqlagan; implementation ushbu scope
bo‘yicha davom etmoqda. Qaror o‘zgarsa, design hujjatlari va bajarilmagan tasklar
birga yangilanadi.
