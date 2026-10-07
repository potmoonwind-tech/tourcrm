/** The region's airports by code, in the app's languages; any other code (or a name) stays as typed.
 * The same list as the server's (app/programme.py AIRPORTS). */
const AIRPORTS: Record<string, Record<'en' | 'ka' | 'zh', string>> = {
  TBS: { en: 'Tbilisi International Airport', ka: 'თბილისის საერთაშორისო აეროპორტი', zh: '第比利斯国际机场' },
  KUT: { en: 'Kutaisi International Airport', ka: 'ქუთაისის საერთაშორისო აეროპორტი', zh: '库塔伊西国际机场' },
  BUS: { en: 'Batumi International Airport', ka: 'ბათუმის საერთაშორისო აეროპორტი', zh: '巴统国际机场' },
  EVN: { en: 'Zvartnots International Airport (Yerevan)', ka: 'ზვართნოცის საერთაშორისო აეროპორტი (ერევანი)', zh: '兹瓦尔特诺茨国际机场（埃里温）' },
  GYD: { en: 'Heydar Aliyev International Airport (Baku)', ka: 'ჰეიდარ ალიევის საერთაშორისო აეროპორტი (ბაქო)', zh: '盖达尔·阿利耶夫国际机场（巴库）' },
}

export function airportName(code: string | null | undefined, lang: string = 'en'): string {
  const names = AIRPORTS[(code ?? '').trim().toUpperCase()]
  return names ? names[(lang as 'en' | 'ka' | 'zh')] ?? names.en : (code ?? '').trim()
}
