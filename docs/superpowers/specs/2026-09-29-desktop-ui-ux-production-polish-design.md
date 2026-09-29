# Desktop UI/UX — Production polish

## Holat

Design yo‘nalishi foydalanuvchi bilan kelishildi; yozma spec foydalanuvchi review’ini kutmoqda.

Ish `feature/desktop-ui-ux` branchida bajariladi. Mavjud Patta-linked oqimni saqlagan holda, foydalanuvchi alohida tasdiqlagan **Standalone Entry** va permission projection kontrakt kengaytmalari qo‘shiladi. Bu kengaytmalar UI uchun zarur bo‘lgan aniq scope; boshqa domain invariantlari o‘zgarmaydi.

## Maqsad

Electron desktop operator dasturini zavod ish jarayoni uchun sodda, zich, keyboard-first va offline holatda ham tushunarli UI’ga olib chiqish. Asosiy qo‘llanma Patta kiritish bo‘lib, foydalanuvchi yuborgan oq fonli, sokin yashil aksentli jadval ko‘rinishi asos qilib olinadi. Visual companion’dagi B — “Sokin ishlab chiqarish” yo‘nalishi tanlandi; foydalanuvchi screenshot’i grid tafsilotlarida ustuvor.

UI faqat taqdimot qatlamidir. SQLite, typed preload IPC va mavjud main-process servislar biznes amallarining manbasi bo‘lib qoladi. To‘g‘ridan-to‘g‘ri HTTP, SQLite yoki umumiy IPC renderer’ga ochilmaydi.

## Repo konteksti va aniq kontrakt kengaytmalari

Hozir renderer `App.tsx`da login/sync va beshta ekran (`Patta chiqarish`, `Patta kiritish`, `Kiritilgan Pattalar`, `Korzinka`, `Model hisob`) state-based navigation bilan birlashgan. Umumiy komponentlar/design system hamda renderer UI testlari yo‘q; `main.css` esa starter va har sahifaga xos CSS’ni bitta katta faylda jamlagan.

Patta Sheet hozir faqat Patta bilan bog‘langan:

- `patta_sheets.patta_hisob_id` SQLite va PostgreSQL’da `NOT NULL`, unique FK.
- `PattaSheetProjection` va sync payload `patta_hisob_id`ni majburiy talab qiladi.
- Create faqat `Partiya + Patta` juftligini qidiradi, har qator quantity’sini Patta `ish_soni`ga tenglashtiradi.
- Model hisob Patta join’i orqali model identity va active holatni oladi.

Shu sabab Standalone Entry uchun additive kontrakt zarur: Entry turi, model/quantity/header metadata snapshotlari, nullable Patta FK, standalone operatsiya snapshot manbasi, offline queue/sync projection, query va accounting join’lari. Mavjud Patta-linked ma’lumotlar `PATTA_LINKED` bo‘lib qoladi; eski ma’lumotlar o‘chirilmaydi yoki sun’iy Patta bilan to‘ldirilmaydi.

Permission-aware navigation uchun hozir API login faqat user ID/email/ism hamda company’ni qaytaradi; refresh permission bermaydi. `DesktopSafeSession` va `window.erp.auth.session()`da permission ro‘yxati yo‘q. Tor, authenticated permission-projection endpoint hamda typed main/preload oqimi qo‘shiladi. Renderer permissionlarni faqat ko‘rinish va amallarni filtrlash uchun ishlatadi; serverdagi har bir biznes ruxsat tekshiruvi authoritative bo‘lib qoladi.

Korzinka’dagi o‘chirgan foydalanuvchi hozir faqat UUID bilan ifodalangan. Foydalanuvchi tasdig‘iga ko‘ra o‘chirish vaqtida actor nomi snapshot qilinib sync qilinadi; snapshot mavjud bo‘lmagan eski yozuv “Noma’lum” deb ko‘rsatiladi.

Header’da korxonaning Master’dagi haqiqiy nomi ko‘rsatiladi. Desktop auth/session contract hozir faqat slug uzatadi; login/refresh va cached safe session’ga additive company name qo‘shiladi. Slug tenant host identifikatori bo‘lib qoladi.

Yangi screenshotlar qo‘shimcha live UI talablarini berdi: Model yaratish va operation narx/holatini `models`/`operations` API’lari orqali boshqarish, Model hisobda operation narxini o‘zgartirish, hamda `Konveyer` bo‘yicha ishlab chiqarish hisobi. Model create/operation/price/template CRUD API’lari bor, ammo ularning desktop IPC/UI yo‘q. Model account IPC hozir faqat read-only miqdorlarni qaytaradi va operation pricesiz; Konveyer hisob query’si yo‘q. Foydalanuvchi Konveyer sahifasi alohida qolip CRUD emas, Patta Entry’lardan tuziladigan production report ekanini aniqlashtirdi; `patta_templates` CRUD bu route uchun ishlatilmaydi.

## Tasdiqlangan domain qarorlari

### Patta kiritish rejimlari

Formaning yuqori qismida Partiya va Patta maydonlari chapida bitta switch bo‘ladi. Switch default holati ON:

- **ON — Patta bilan bog‘langan:** Partiya № va Patta № majburiy. Mavjud lokal-first Patta lookup bajariladi; Patta topilgandan keyin Model, Ish soni, Rang, Razmer, Pechat sanasi va mavjud operation snapshotlari avtomatik/read-only ko‘rinadi.
- **OFF — mustaqil Entry:** Patta lookup umuman bajarilmaydi, hatto ikkala raqam yozilgan bo‘lsa ham. Partiya/Patta’ning kiritilgan qiymatlari faqat axborot snapshotidir; bo‘sh qiymat DB’da `null` bo‘ladi va UI’da `Noma’lum` ko‘rsatiladi. Keyinchalik Patta bilan bog‘lash yo‘q.

Standalone holatda Model majburiy tanlanadi, Ish soni musbat butun son sifatida operator tomonidan kiritiladi, Rang/Razmer va Konveyer ixtiyoriy kiritiladi. Sana operator tomonidan o‘zgartirilmaydi: `entered_at` main/domain qatlamda bir marta olinadi, read-only sana shu timestamp’dan ko‘rsatiladi.

Entry header’dagi `ish_soni` har bir faol operation row’ning `quantity_snapshot` qiymati bo‘lib qoladi. Patta-linked rejimda u Patta’dan olinadi; standalone rejimda validatsiyalangan operator qiymatidan olinadi. Worker identity hanuz `worker_id`; badge qiymati faqat timestamp bo‘yicha local resolve qilinadigan input/evidence. Operation narxi timestamp bo‘yicha snapshot qilinadi va keyingi narx o‘zgarishi tarixiy Entry’ni o‘zgartirmaydi.

Patta-linked yozuvlarda mavjud bir-Patta-bir-Entry unique/duplicate qoidalari o‘zgarmaydi. Standalone yozuvning identity’si UUID; ixtiyoriy Partiya/Patta qiymatlari Patta business key bo‘lmagani sababli ular bo‘yicha avtomatik deduplikatsiya qilinmaydi.

Standalone Entry edit qilinganda `entry_kind` o‘zgarmaydi. Entry’ni keyinchalik Patta’ya link qilish ushbu design scope’ida yo‘q. `entered_at`, worker ID attribution, Patta allocator, Partiya allocator, badge history, Entry version/conflict, trash/restore/purge lifecycle, sync idempotency va historical price invariants saqlanadi.

### Oylik yopish chegarasi

`business_date` existing Entry’da saqlanadi. Oylik yopish talabi kelajakdagi `Umumiy Oylik Hisobot`/Payroll oqimiga tegishli; bu UI polish branchida period lifecycle yo‘q. Pattalar, Partiya/Patta raqam bloklari, modellar, ishchilar, Patta Entry’lar va manual adjustments tozalanmaydi yoki yangi oy boshlanishida qayta yaratilmaydi. Model hisob barcha active/non-deleted Patta contribution’larini va manual additions’ni jamlaydi; Konveyer hisobi ham saqlangan production Entry’larini sanaydi.

Foydalanuvchi haqiqiy `Oyni yopish` lifecycle’ini ham talab qildi. U period status, lock/permission, audit, oldindan offline navbatga tushgan mutation’lar uchun conflict va close/reopen siyosatini talab qiladi. Bu repo delivery order’dagi keyingi Payroll/period-accounting bosqichi va avvalgi UI scope’dagi out-of-scope band bo‘lgani uchun ushbu desktop polish branchida close/lock tugmasi va period lifecycle implement qilinmaydi. Hozirgi Model hisob barcha history’ni, Konveyer hisobi esa saqlangan production Entry’larni ko‘rsatadi; eski yozuvlar mavjud permission bilan edit/trash qilinishi mumkin. Hisobotdagi oylik daromad/ish haqi formulalari ham ushbu scope’da yo‘q.

### Operatsiyalar va Model hisob

Patta-linked Entry mavjud Patta snapshotlarini va qo‘shimcha normal/custom model operation’larni ishlatadi. Standalone Entry uchun main process tanlangan modelning local mirror’dagi faol operationlarini va `entered_at` vaqtiga mos narxlarini beradi; renderer katalogni o‘zi hisoblamaydi. Qo‘shimcha operation mavjud model operation domain service orqali yaratiladi/reuse qilinadi va normal sync dependency’siga ega bo‘ladi.

Standalone va linked qatorlar Model hisobga shu modelning operation va haqiqiy `worker_id`si bo‘yicha qo‘shiladi. Aggregatsiya hanuz `SUM(quantity_snapshot)` bo‘lib qoladi. Screenshot’dagi operation price qatori **bugungi effective narx** sifatida ko‘rsatiladi va `models.manage` huquqi bilan aynan Model hisob sahifasidan o‘zgartiriladi. O‘zgartirish existing price endpoint/service’ga version bilan boradi; `effective_from` yuborilmaganda server transaction time’dan boshlanadi, audit/history yoziladi, kelajakdagi/scheduled price existing contractga muvofiq qoladi. Oflayn holatda narx o‘qiladi, o‘zgartirish internetga qadar bloklanadi. Narx o‘zgarishi eski Entry operation snapshotlariga tegmaydi.

#### Manual added contributions

Model hisobdagi editable `Soni` manual qo‘shimchani kiritadi; u hech qachon Patta `ish_soni` yoki mavjud `patta_sheet_rows.quantity_snapshot`ni update qilmaydi. Yakuniy cell qiymati model/worker/operation scope’da **Patta-derived quantity + faol manual adjustment quantity** yig‘indisi.

Har bir manual qo‘shimcha alohida `model_account_adjustment` yozuvi: UUID, `model_id`, `model_operation_id`, permanent `worker_id`, musbat butun `quantity`, `entered_at`/tenant-timezone `business_date`, `unit_price_snapshot`, version, actor/device, create/update/trash metadata. Narx `entered_at` vaqtidagi effective operation price’dan server/main domain’da resolve qilinadi. Saqlangandan keyingi Narx o‘zgarishi adjustment summasini qayta hisoblamaydi. Quantity tahriri original `entered_at` va `unit_price_snapshot`ni saqlaydi; yangi qo‘shimcha esa yangi timestamp va narx snapshotini oladi.

Manual adjustment local SQLite transaction + sync queue event bilan atomic yoziladi; edit/trash/restore expected version, audit va stable event ID bilan ishlaydi. Trash jami qiymatdan chiqaradi, restore qaytaradi; manual adjustment’ni fizik purge qiluvchi UI bo‘lmaydi. Event two-way sync/idempotency va tenant permission tekshiruviga ega. Bu yangi qo‘shimcha source Patta yozuvlari va linked duplicate qoidalarini o‘zgartirmaydi.

`Jami dona` — yuqoridagi quantity yig‘indisi. `Jami so‘m` — har Patta contribution’i `quantity_snapshot × o‘sha Patta Sheet operation snapshot narxi` va har manual adjustment’i `quantity × uning narx snapshoti` yig‘indisi. Hisob `Decimal` bilan bajariladi; amaldagi narx hech qachon tarixiy yozuvlarga qo‘llanmaydi. Bu gross operation qiymati: `Nuqson`, avans, jarima yoki ish haqi net formulasi qo‘llanmaydi. Operation’dagi trash icon hard delete emas, `INACTIVE` holatiga o‘tkazish (`models.manage`) va confirm’dagi `Faolsizlantirish` amalidir; tarixiy Entry va snapshotlar qoladi. Worker ID birinchi identity ustuni; sun’iy ketma-ket row number ko‘rsatilmaydi.

### O‘chirgan foydalanuvchi

Entry trash qilinganda actor UUID bilan birga `deleted_by_name_snapshot` maydonida actor’ning sentence-case full name’i saqlanadi va sync projectionda uzatiladi. Eski Entry yoki nomi mavjud bo‘lmagan actor uchun `Noma’lum` ko‘rsatiladi. Restore/purge semantikasi o‘zgarmaydi; purge oldidan “Bu amalni ortga qaytarib bo‘lmaydi.” tasdig‘i beriladi.

## Manual adjustment contract

Mavjud tenant catalog’da `patta.hisob.view` bor, lekin manual contribution write permission yoki model-account adjustment jadvali yo‘q. Additive PostgreSQL/SQLite migration va sync projection/event existing sync engine’ni qayta ishlatadi. `patta.hisob.manual_manage` yangi permission add/edit/trash/restore mutation’larini gate qiladi; `patta.hisob.view` report read’ni gate qiladi.

Manual record model va operation bir modelga tegishli, worker identity `workers.id`ga FK, quantity `> 0`, unit price `NUMERIC(14,2) >= 0` bilan saqlanadi. Active adjustment’lar worker/model/operation bo‘yicha Patta-derived source’dan alohida agregatsiya qilinadi; `business_date` kelajakdagi oylik report uchun saqlanadi. API sync handler price snapshotni effective price history bilan solishtiradi; duplicate `event_id` takror yozuv yaratmaydi. Tahrir `expected_version` bilan; conflict’da old state saqlanadi. Add/edit/trash/restore sync mutation’lari `patta.hisob.manual_manage` talab qiladi; Model hesap query read uchun `patta.hisob.view` ishlatadi.

Mavjud `/api/v2/patta-sheets` va `/api/v2/models/:modelId/account-sheet` contractlari o‘zgarmaydi, linked Entry/V2 account shape uchun saqlanadi. Standalone-capable Patta Sheet REST create/read/edit routes `/api/v3/patta-sheets` namespace’da, manual-inclusive account read projection esa `/api/v3/models/:modelId/account-sheet` namespace’da bo‘ladi. V2 account query model’da manual adjustment bor bo‘lsa incomplete total qaytarmay `SYNC_PROTOCOL_UPGRADE_REQUIRED` beradi. Desktop mutatsiyalari renderer’dan REST’ga bormaydi: main-process local-first SQLite + SyncProtocolVersion 3 queue ishlatadi.

## Tavsiya etilgan arxitektura

### Bitta versioned Entry aggregate

Tasdiqlangan yondashuv — bitta Entry lifecycle ichida `PATTA_LINKED` va `STANDALONE` turlarini qo‘llash. Bu history, assignment rows, optimistic version, audit, trash/restore/purge, two-way sync va accounting lifecycle’ini bo‘lib yubormaydi.

Additive PostgreSQL/SQLite migrations va `SyncProtocolVersion = 3` quyidagilarni ifodalaydi. V3 hozirgi V2 entity’lari va flows’ni olib yuradi hamda Standalone Entry va `model_account_adjustments` payload/projection’larini qo‘shadi. V1/V2 contractlari qayta talqin qilinmaydi:

- Entry turi va nullable `patta_hisob_id`; Patta-linked yozuv uchun FK va unique qoidalar saqlanadi.
- Model ID/name snapshot, musbat `ish_soni` snapshoti va Rang/Razmer/Partiya/Patta informational snapshotlari.
- Operation snapshot manbasi `PATTA`, mavjud model `MODEL` yoki `CUSTOM` ekanini ajratadi; linked original Patta snapshotlari immutable qoladi.
- Row quantity barcha rejimlarda header `ish_soni`ga teng; DB constraint va service validation bir xil invariantni tekshiradi.
- Entry create/update/trash/restore/purge oldingi local mutation + sync queue + stable event ID atomikligini va duplicate delivery idempotency’ni saqlaydi.

Eski linked projectionlar migratsiyada linked turi bilan map qilinadi. Yangi optional fieldlar eski ma’lumotdan taxminan to‘ldirilmaydi; haqiqiy source mavjud bo‘lmagan joyda `null` qoladi. Doimiy protocol compatibility uchun projection versioning va API adapterlar aniq ajratiladi.

Yangi desktop V3 push/pull/bootstrap ishlatadi. Sync V1/V2 type/projection contractlari unchanged qoladi; server V2 linked Sheet event/REST input’ni internal V3 linked record’ga map qiladi va linked projectionni V2 clientga eski shaklda qaytaradi. V2 client Standalone/manual V3-only data’ni o‘qishi yoki yozishi mumkin bo‘lmaydi; V2 cursor/bootstrap V3-only change’ga duch kelsa server cursor’ni advance qilmasdan `SYNC_PROTOCOL_UPGRADE_REQUIRED` beradi. V2-only tenant data’da oldingi client ishlashda davom etadi. Bu strict parserli ikki-PC sync’da yangi entity’larni jim tashlab ketishning oldini oladi.

Separate standalone tables/services approach’i lifecycle/accounting/sync logic’ni takrorlagani sababli tanlanmadi. Fake Patta yozuvi allocator, raqamlar va Patta historical identity’ni buzishi sababli qabul qilinmaydi.

### Permission projection va IPC

Authenticated tenant API `GET /api/v1/auth/permissions` orqali effective permission code’larining kichik, read-only ro‘yxatini qaytaradi. Electron main process uni login/refresh yoki online refresh vaqtida oladi, offline ko‘rsatish uchun oxirgi tasdiqlangan projection’ni versioned secure session’da saqlaydi va narrow typed preload method orqali renderer’ga beradi. Renderer token olmaydi va IPC channel/raw HTTP/database API olmaydi. Auth company projection’iga Master’dagi `company.name` ham qo‘shiladi; slug host validation uchun saqlanadi.

Permission cache mavjud bo‘lmaganda permission-gated write/action yashiriladi. Oflayn holatda oxirgi saqlangan projection UI visibility’ni boshqaradi; sync/API baribir server permission’ni qayta tekshiradi va ruxsatsiz mutation’ni conflict/error qiladi. Model hisob ko‘rish `patta.hisob.view`, manual adjustment add/edit/trash/restore `patta.hisob.manual_manage` bilan gate qilinadi. Permission ma’lumotlari har Jeton keystroke’da olinmaydi.

Sidebar screenshot’iga mos, yig‘iladigan navigation:

- **Patta:** `Patta chiqarish`, `Patta kiritish`, `Patta-Hisob (Jurnal)` (mavjud Kiritilgan Pattalar history route’i), `Korzinka`.
- **Konveyer:** `Konveyer hisobi` report route’i.
- **Modellar:** faol model ro‘yxati; model tanlanganda uning hisob varag‘i; `Model qo‘shish` action/page.
- `Umumiy Oylik Hisobot` bu fazada route/menu olmaydi. Payroll/oylik report hali ishlab chiqish ketma-ketligidagi keyingi bosqich.

`Model qo‘shish` page mavjud online `POST /api/v1/models` contractini `models.manage` bilan chaqiradi; model nomini yaratgach yangi model ro‘yxatga olinadi va uning hisob varag‘iga o‘tadi. Operationlar model hisob sahifasidagi `+ Operatsiya qo‘shish` orqali existing `POST /api/v1/models/:modelId/operations` ishlatadi. Model/operation CRUD va effective price o‘zgartirish online bo‘lishi shart; typed main-process IPC ishlatiladi, renderer generic HTTP olmaydi, muvaffaqiyatli mutation’dan keyin sync pull local mirror’ni yangilaydi.

`Konveyer hisobi` alohida editable business entity yaratmaydi. U local Patta Entry projection va manual adjustment’larni o‘qib, active records’ni conveyor/model bo‘yicha grouping qiladi. `conveyor_snapshot IS NULL` Entry’lar hamda conveyor snapshot’i bo‘lmagan manual adjustment’lar `Noma’lum` guruhiga kiradi. `Patta soni` faqat linked Entry/Patta’larni, `Mustaqil Entry soni` standalone yozuvlarni, `Qo‘lda qo‘shilgan` manual adjustment’larni alohida sanaydi. `Ish soni` har unique Patta/Entry/manual adjustment quantity’sini bir marta qo‘shadi — operation row’lar bo‘yicha ko‘paytirilmaydi. Trashed/removed records hisobga kirmaydi. Bu hisobot offline local SQLite’dan ishlaydi.

### Renderer component boundaries

Yengil internal design system CSS custom properties va typed React primitives’dan tuziladi; katta UI dependency qo‘shilmaydi. Markaziy semantic tokens: spacing, radius, type scale/weight, page/surface, border, muted text, success, warning, danger va focus ring.

Qayta ishlatiladigan primitives:

`Button`, `IconButton`, `Input`, `SearchInput`, `Select`, `Checkbox`, `Badge`, `StatusBadge`, `Dialog`, `ConfirmDialog`, `Table`/grid, `EmptyState`, `ErrorState`, `LoadingState`, `Toast`, `Tooltip`, `Tabs`, `PageHeader`, `SectionHeader`, `Toolbar`, `Card`, `FormField`.

`App.tsx` authentication/session ownershipini va shell state’ini boshqaradi. Sahifalar screen-specific form/grid state’ini ushlab turadi, persistent mutation faqat narrow `window.erp.*` method bilan main process’ga boradi. Umumiy renderer error formatter operatorga Uzbek Latin fallback beradi; SQL, stack trace, SQLite code yoki raw JSON ko‘rsatilmaydi.

## Ekranlar va operator oqimi

### App shell va login

- Chap sidebar: ishlab chiqarish va hisob guruhlari; permission bo‘yicha sahifa/action ko‘rsatish.
- Yupqa header: page title, korxona nomi, `Onlayn`/`Internet yo‘q`, sync holati, user va `Chiqish`.
- Sync matnlari: `Sinxronlandi`, `Sinxronlanmoqda`, `Internet yo‘q`, `Ziddiyat mavjud`; pending count bo‘lsa `3 ta yozuv yuborilmoqda` kabi qisqa status. Oflayn normal holat, global xavfli qizil banner emas.
- Login: `Korxona`, `Email`, `Parol`, `Kirish`; submit paytida parol memory/formdan tozalanishi mavjud auth contractiga mos qoladi. Known auth result/error’lari `Internet bilan aloqa yo‘q`, `Email yoki parol noto‘g‘ri`, `Korxona topilmadi`, `Qurilma ro‘yxatdan o‘tkazilmagan` kabi Uzbek Latin’ga map qilinadi.

### Patta chiqarish va print

Patta chiqarish Model, `Ish soni`, Rang va razmer taqsimotini kompakt form/griddan oladi. Partiya va Patta raqamlari editable emas, allocator’dan avtomatik keladi. Batch summary jami pachka va razmer taqsimotini ko‘rsatadi. Saqlangan Pattalar preview/reprint’da ishlatiladi; qayta print yangi raqam yaratmaydi.

Saqlangan batch uchun alohida accessible preview ochiladi; preview A4 portrait formatda 2 Patta/page ko‘rsatadi: Model, Partiya №, Patta №, Ish soni, Rang, Razmer, Sana, operatsiyalar va Jeton yozish joylari. Batch summary jami pachka va razmer distribution’ni beradi. Preview faqat saqlangan batch data’sidan tuziladi, allocator yoki batch state’ni o‘zgartirmaydi. `Pechat qilish` esa mavjud typed main-process print action’dan foydalanadi; main-process print document/print action authoritative qoladi va UI chrome chop etilmaydi. Oddiy printer va qora-oq chopda kontrast saqlanadi.

### Patta kiritish

Grid ustunlari: `№`, `Operatsiya nomi`, `Narx`, `Jeton`, `Ishchi`, `Nuqson`, `O‘chirish`. Quantity editable ustun yo‘q. Automatic Patta fields linked rejimda read-only va `Avtomatik` label bilan ajraladi.

Jeton Enter’i local badge resolution qiladi; valid worker name’ni ko‘rsatib keyingi Jeton inputga focus beradi. Invalid badge `Topilmadi` deb o‘sha qatorda qoladi, row’ga qizil semantic + matn signalini beradi va focus’ni keyingi qatorga o‘tkazmaydi. Worker ID topilmagan qator bilan final save bloklanadi. Oxirgi valid Jeton Enter’i full validation va local transaction save’ni bajaradi, `Patta kiritildi` status/toast ko‘rsatadi va Partiya lookup/input’ga focus qaytaradi. Modal success flow ishlatilmaydi.

`Nuqson` checkbox/flag row assignment’ni saqlaydi; u `O‘chirish` amaliga qo‘shilmaydi. `O‘chirish` faqat assignment’ni alohida clear/soft-delete qiladi; worker/quantity/Patta identity o‘chmaydi. Icon’lar accessible name/tooltip bilan keladi.

`+ Operatsiya qo‘shish` nom va narx form/modalini ochadi; validatsiya mavjud model operation domain service’ga boradi. Saqlangan/reused operation grid’da normal model operation sifatida chiqadi.

### Kiritilgan Pattalar, edit va Korzinka

Kiritilgan Pattalar kompakt data table: Kiritilgan sana, Partiya №, Patta №, Model, Razmer, Rang, Ish soni, Konveyer, Holat/Sync, Amallar. Standalone’da bo‘sh identifier `Noma’lum`; foydalanuvchi kiritgan identifier’lar informational qiymat sifatida ko‘rsatiladi. Qidiruv Partiya/Patta/Model/Ishchi bo‘yicha, Sana/Model/Sync filterlari hamda pagination mavjud dataset query’lariga mos bo‘ladi. Action’lar `Ko‘rish`, `Tahrirlash`, `O‘chirish` permission bilan gate qilinadi; O‘chirish soft-trash tasdig‘ini ochadi.

Entry edit linked yoki standalone turini o‘zgartirmaydi. `Kiritilgan sana` original immutable `entered_at`, read-only ko‘rsatiladi. Worker correction grid initial keyboard UX bilan bir xil; optimistic version conflict `Ma’lumot boshqa qurilmada o‘zgartirilgan` kabi xavfsiz matn bo‘ladi; silent overwrite yo‘q.

Korzinka jadvali O‘chirilgan sana, Kiritilgan sana, Partiya №, Patta №, Model, Ish soni, O‘chirgan foydalanuvchi va Amallar ustunlarini ko‘rsatadi. `Qayta tiklash` safe action; `Butunlay o‘chirish` alohida strong `ConfirmDialog` va `Bu amalni ortga qaytarib bo‘lmaydi.` matniga ega. Purge faqat mavjud domain service orqali bajariladi.

### Model qo‘shish va Model hisob varag‘i

Model qo‘shish sahifasi kompakt `Model nomi` formasi, server validation/duplicate-name xabari va pending/success holatiga ega. Faqat `models.manage` ko‘rinadi va ishlaydi. Yangi model yaratish serverdan keyin sync mirror’ga tushadi; offline’da create/save disabled, mavjud local Pattalar va Model hisob esa ishlashda davom etadi.

Model hisob varag‘i screenshot’dagi grouped spreadsheet: worker ID/`F.I.O.` sticky; har operation group’da operation name/action, `Amaldagi narx` qatori va editable `Soni` jami ko‘rinadi. Cell total model/worker/operation bo‘yicha barcha active Patta Entry assignment’lari va manual adjustment’lardan tuziladi. Patta-derived son va manual added alohida manba bo‘lib qoladi; cell’da manual value bo‘lsa indicator ko‘rinadi. Model hisob barcha sanalardagi active source’larni jamlaydi (oy filtri yo‘q); `Jami dona` va snapshot narxlarga tayangan gross `Jami so‘m` ko‘rsatiladi. Bu ish haqi/net payroll emas.

`Soni` cell’ni double-click qilish (keyboard’da Enter) shu worker/model/operation uchun detail dialog ochadi: Patta’dan kelgan miqdor, manual qo‘shimchalar ro‘yxati va `+ Qo‘lda qo‘shish`. Manual add quantity input yangi versioned record yaratadi. Mavjud manual record tahriri faqat quantity’sini o‘zgartiradi; original sana/narx/worker/operation/model saqlanadi. Trash jami qiymatdan chiqaradi, restore qaytaradi. Worker row’ni double-click/keyboard activate qilish worker’ning barcha modellari va operatsiyalari bo‘yicha breakdown ochadi; har qatorda `Patta` va `Qo‘lda qo‘shilgan` miqdor/qiymatlar ajratiladi.

`Amaldagi narx` input o‘zgarishi explicit save va version conflict bilan existing API’ga boradi; offlayn price edit disabled. Yangi manual add offline’da main process local effective-price mirror’dan snapshot olib, adjustment + queue’ni atomic yozadi. Tahrirlangan manual record original price snapshotini saqlaydi. `Jami dona` va snapshot narxlardan hisoblangan gross `Jami so‘m` ko‘rinadi. Bu qiymatga Nuqson deduction, avans, jarima yoki net salary formulasi qo‘llanmaydi. Operation faolsizlantirish tarixni qoldiradi.

### Konveyer hisobi

Yuqorida model va konveyer filtrlari; jadval qatorlari `Konveyer`, `Model`, `Patta soni`, `Mustaqil Entry soni`, `Qo‘lda qo‘shilgan`, `Ish soni`. Bo‘sh konveyer `Noma’lum`. Har source record bir marta sanaladi, `ish_soni` operation row soniga ko‘paytirilmaydi. Empty/loading/error state’lar umumiy design system’dan olinadi. Bu sahifada input/mutation yo‘q.

## States, format va accessibility

- Normal UI Uzbek Latin, sentence-case full name; price `50 000 so‘m`, quantity `125 dona`, sana yagona `uz-UZ` formatter bilan.
- Oflayn holat operatorni bloklamaydi; local functionality ishlaydi. Sync conflict alohida warning, conflict payload/stack ko‘rsatilmaydi.
- Har route full-screen spinner o‘rniga inline loading/skeleton; action button pending state’ga ega.
- Empty state’lar keyingi qadamni ko‘rsatadi: `Hali Patta kiritilmagan`, `Korzinka bo‘sh`, `Bu modelda hisob ma’lumoti yo‘q`.
- Barcha input label’li; tab order deterministik; `Enter`, `Tab`, `Shift+Tab`, xavfsiz joylarda `Escape`; keyboard focus ring doim ko‘rinadi.
- Dialog focus trap va xavfsiz Escape close; icon-only control aria-label/tooltip bilan. Rang yolg‘iz signal emas. Reduced-motion hurmat qilinadi.
- Jadval header sticky, qator hover/focus, compact cell padding; identity columns sticky. Card layout data table o‘rnini bosmaydi.

## Test va review rejasi

### Automated

Renderer component/integration testlari kamida quyidagilarni tekshiradi:

- Login success/pending/offline/wrong credential/company/device holatlari va parol cleanup.
- Linked Patta lookup, auto metadata, standalone mode, optional identifiers, manual model/Ish soni, Rang/Razmer optional va OFF’da mavjud Pattaga lookup qilinmasligi.
- Badge valid/`Topilmadi`, Enter → keyingi focus, oxirgi Enter → save + focus reset, worker_id’siz save bloklanishi.
- `Nuqson` va `O‘chirish` mustaqil ishlashi, custom operation qo‘shish, linked va standalone edit.
- Version conflict matni, history qidiruv/filter/pagination, trash confirmation, restore va purge confirmation.
- Model hisob linked+standalone all-history aggregation; manual `Soni` add/edit/trash/restore; worker row source breakdown; snapshot narxlardan `Jami so‘m`; operation price update’dagi version conflict/offline disable; operation deactivate tarixni saqlashi.
- Model create permission/API holatlari va Konveyer hisobi: unknown conveyor/manual adjustment, model grouping, source bo‘yicha record counts hamda quantity operation qatorlari bilan ko‘paymasligi.
- Offline/pending/conflict badge, cached permission bo‘yicha navigation/action visibility, permission yo‘q bo‘lganda fail-closed UI.
- `Umumiy Oylik Hisobot`, net payroll va `Oyni yopish` action navigation/UI’da yo‘qligi; Model hisob gross snapshot valuation’i esa tekshiriladi.

Main/API/sync tests V1/V2 backward compatibility, V2-to-V3 upgrade-required/cursor preservation, nullable Patta FK faqat Standalone’da, linked duplicate, standalone `ish_soni`/quantity equality, model/operation price snapshot, manual adjustment schema/quantity/price snapshot/version/permission/trash/restore, badge history timestamp, actor-name snapshot sync, all-history aggregation, Model create/price change/deactivate via existing API, Konveyer unique-entry totals, permission projection va unauthorized server mutation’ni rad etishni tekshiradi. V3 ikki-client testida PC-1 offline manual adjustment yaratadi, duplicate event qayta yuborilganda bitta contribution qoladi va PC-2 pull orqali ayni record/source split’ni oladi.

### Visual/runtime

- Desktop `lint`, `typecheck`, `test`, `build`, Electron runtime smoke.
- Har major screen 1280×720, 1366×768 va 1920×1080’da ko‘riladi: clipping, keyboard focus, table density/sticky, modal placement, Uz Latin va layout overflow.
- Patta print preview/print output 1, 2, 3, 13 Pattada tekshiriladi; 13 ta = 7 sahifa, oxirgi sahifa bitta Patta va bo‘sh ikkinchi slot. `@page A4`, qora-oqda o‘qilishi va UI chrome yo‘qligi tekshiriladi.
- Yangi heavyweight visual testing framework talab qilinmaydi; mavjud test vositalari va manual screenshot review ishlatiladi.

## Scope’dan tashqari

`Umumiy Oylik Hisobot`, net payroll/ish haqi formulalari, `Oyni yopish`/period lock va auto-updater kiritilmaydi. Model hisob uchun foydalanuvchi tasdiqlagan manual added source va gross `Jami so‘m` snapshot narxlaridan hisoblanadi; avans/jarima/Nuqson deduction yo‘q. `Konveyer hisobi` Patta Entry va Manual adjustment’lardan read-only hisobot; Konveyer uchun yangi mutation/domain entity qo‘shilmaydi. Patta `ish_soni`/`quantity_snapshot`, allocator, worker identity, badge history, entered_at, linked Entry duplicate qoidasi, sync idempotency/conflict, trash semantikasi va historical price snapshot invariants o‘zgarmaydi.
