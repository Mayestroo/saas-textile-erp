# Lokal test uchun demo ma’lumotlar

## Holat

Foydalanuvchi tasdiqlagan dizayn; yozma spec user review’ini kutmoqda.

## Maqsad

Lokal Textile ERP muhitida kirib ishlatish mumkin bo‘lgan tenant admini va sinov ma’lumotlarini bitta takroriy buyruq bilan tayyorlash. Sinov to‘plami bitta faol model, uning narxlari belgilangan amallari, uchta faol ishchi va har bir ishchiga alohida jetondan iborat bo‘ladi.

Sinovdagi shaxs nomlari uydirma bo‘ladi. Ma’lumotlar faqat lokal development tenantiga yoziladi; tenant biznes ma’lumotlari Master bazaga ko‘chirilmaydi.

## Repo konteksti

`npm run dev:tenant` va `local-dev-tenant-bootstrap.cli.ts` yangi lokal tenant hamda Argon2id bilan hash qilingan admin parolini yaratadi. Parol faqat yangi tenant yaratilganda terminalga chiqariladi; mavjud tenant uchun parol o‘zgartirilmaydi. Provisioning tenant RBAC, migrations va admin user’ni tayyorlaydi, lekin model, operation, ishchi va jetonlarni seed qilmaydi.

Model, operation/narx, worker va badge uchun tenant API’da alohida domain service’lar mavjud. Ularni ishlatish audit tarixi, immutable narx tarixi va sync projection yozuvlarini saqlaydi. Test login uchun desktop qabul sinovi ham faol operationli modelni talab qiladi.

## Tavsiya etilgan arxitektura

Yangi `dev:setup-local-demo` CLI komandasi lokal muhitni tekshiradi, tenant’ni topadi yoki yo‘q bo‘lsa mavjud provisioning flow orqali yaratadi, keyin demo katalogini takroriy tayyorlaydi.

### Xavfsizlik chegarasi

Komanda faqat `NODE_ENV=development` holatida va Master hamda tenant PostgreSQL manzillari loopback (`localhost`, `127.0.0.1` yoki `::1`) bo‘lganda ishlaydi. Master database nomi `_test` bilan tugamasligi hamda kutilgan lokal tenant slug’i tekshiriladi. Tekshiruvlardan biri bajarilmasa, hech qanday yozuv qilmasdan xato bilan to‘xtaydi.

Tenant mavjud bo‘lmasa, CLI mavjud `CompaniesService.createAndProvision()` oqimini chaqiradi va xavfsiz tasodifiy admin parolini yaratadi. Email CLI argumentidan olinadi yoki `admin@<slug>.local` ishlatiladi. Email/parol faqat yangi foydalanuvchi yaratilganda chiqariladi. Tenant mavjud bo‘lsa, parol qayta yaratilmaydi yoki yangilanmaydi; berilgan emaildagi faol admin topilmasa, CLI aniq xato bilan to‘xtaydi.

### Demo ma’lumotlar va idempotentlik

CLI seed uchun ajratilgan, aniq belgilangan nomlardan foydalanadi. Har bir entity mavjud bo‘lsa qayta ishlatiladi, yetishmasa yaratiladi. Bir xil nomdagi boshqa mahalliy ishchiga badge tasodifan biriktirilmasligi uchun ishchilar rezerv qilingan sinov nomlari va alohida badge raqamlari bilan taniladi. Badge band bo‘lib, belgilangan test ishchisiga tegishli bo‘lmasa, CLI uni ko‘chirib o‘tkazmaydi va xato bilan to‘xtaydi.

Yozuvlar `ModelsService`, `OperationsService`, `WorkersService` va `BadgeHistoryService` orqali yaratiladi. Narxlar operation yaratilishidagi amaldagi tarix yozuvi sifatida saqlanadi; badge intervali DB vaqtida boshlanadi. Seeder mavjud entity’larni update/deactivate qilmaydi va hech qanday ma’lumotni o‘chirmaydi. Takroriy ishga tushirish qo‘shimcha dublikat model, operation, ishchi yoki ochiq badge intervali hosil qilmaydi.

### Buyruq va natija

Buyruq repo root’dan ishga tushadi, masalan:

```powershell
npm run dev:setup-local-demo -- --slug textile-dev --company-name "Textile Dev" --email admin@textile-dev.local
```

Default qiymatlar mavjud `dev:tenant` konvensiyasiga mos keladi. Muvaffaqiyatda CLI tenant URL’i, admin email, model identifikatori, ishchi/jetonlar va qaysi yozuvlar yaratilgani yoki qayta ishlatilganini chiqaradi. Parol faqat yangi tenant ochilgan birinchi ishga tushirishda ko‘rsatiladi; terminal chiqishini saqlash foydalanuvchining zimmasida.

Model `Trikotaj sinov modeli` bo‘ladi. Undagi faol amallar: `Bichish` — 300 so‘m, `Tikish` — 1 500 so‘m, `Qadoqlash` — 500 so‘m. Uch ishchi Uzbek Latin’dagi uydirma `Lokal sinov ishchisi 1–3` nomlari va 9001–9003 jetonlari bilan yaratiladi. Test ma’lumotlari production xarakteridagi haqiqiy odam yoki korxona ma’lumoti emas.

## Muqobil yondashuvlar

1. **Mavjud `dev:tenant`ni kengaytirish.** Yangi tenantni bir bosqichda tayyorlaydi, ammo joriy CLI mavjud slug topilganda to‘xtaydi va takroriy seed talabini qondirmaydi.
2. **Alohida takroriy demo CLI (tavsiya).** Eski provisioning yo‘lini saqlaydi, mavjud tenantda ham xavfsiz ishlaydi, domain service’lar orqali audit va sync yozuvlarini to‘g‘ri yuritadi. Production/runtime API kontraktlariga tegmaydi.
3. **Raw SQL fixture.** Tez yoziladi, lekin audit, narx tarixi va sync projection qoidalarini chetlab o‘tadi; shuning uchun tanlanmaydi.

## Xatolar va tranzaksiya

Provisioning xatosi mavjud state machine orqali saqlanadi. Demo entity’lar alohida domain tranzaksiyalarida yaratilgani uchun bir necha qismdan keyingi xatoda oldingi to‘g‘ri yozuvlar qolishi mumkin; qayta ishga tushirish mavjud qismlarni qayta ishlatib, qolganlarini yakunlaydi. Badge raqami to‘qnashuvi yoki tenant/admin mos kelmasligi avtomatik tuzatilmaydi va foydalanuvchiga sabab bilan ko‘rsatiladi. Maxfiy parollar log yoki DB plaintext’iga yozilmaydi.

## Tekshiruv

- Development/loopback guard’i noto‘g‘ri muhitlarda yozuvdan oldin to‘xtashini tekshirish.
- Yangi tenant flow’i admin login uchun credential’ni faqat birinchi yaratishda chiqarishini tekshirish.
- Ikki marta seed bajarilganda model, operation, worker, badge va audit/sync yozuvlari dublikat bo‘lmasligini tekshirish.
- Begona ishchiga biriktirilgan badge qayta tayinlanmasligini tekshirish.
- API typecheck, lint va tegishli tenant service testlarini ishga tushirish; mavjud dedicated `_test` PostgreSQL parametrlari bo‘lsa worker/model integration testlarini ham bajarish.

## Scope’dan tashqari

Production/remote serverga seeding, ishchi payroll/Patta yozuvlari, Master database’ga tenant operational data yozish, mavjud parolni reset qilish, ma’lumotlarni hard-delete/reset qilish va runtime API contract’larini o‘zgartirish kirmaydi.
