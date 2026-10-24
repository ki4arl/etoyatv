'use strict';

/** ISO-3166-1 alpha-2 → Russian name (admin searchable picker). */
const GEO_COUNTRY_OPTIONS = [
  {
    "code": "AU",
    "name": "Австралия"
  },
  {
    "code": "AT",
    "name": "Австрия"
  },
  {
    "code": "AZ",
    "name": "Азербайджан"
  },
  {
    "code": "AX",
    "name": "Аландские острова"
  },
  {
    "code": "AL",
    "name": "Албания"
  },
  {
    "code": "DZ",
    "name": "Алжир"
  },
  {
    "code": "VI",
    "name": "Американские Виргинские острова"
  },
  {
    "code": "AS",
    "name": "Американское Самоа"
  },
  {
    "code": "AI",
    "name": "Ангилья"
  },
  {
    "code": "AO",
    "name": "Ангола"
  },
  {
    "code": "AD",
    "name": "Андорра"
  },
  {
    "code": "AQ",
    "name": "Антарктида"
  },
  {
    "code": "AG",
    "name": "Антигуа и Барбуда"
  },
  {
    "code": "AR",
    "name": "Аргентина"
  },
  {
    "code": "AM",
    "name": "Армения"
  },
  {
    "code": "AW",
    "name": "Аруба"
  },
  {
    "code": "AF",
    "name": "Афганистан"
  },
  {
    "code": "BS",
    "name": "Багамы"
  },
  {
    "code": "BD",
    "name": "Бангладеш"
  },
  {
    "code": "BB",
    "name": "Барбадос"
  },
  {
    "code": "BH",
    "name": "Бахрейн"
  },
  {
    "code": "BY",
    "name": "Беларусь"
  },
  {
    "code": "BZ",
    "name": "Белиз"
  },
  {
    "code": "BE",
    "name": "Бельгия"
  },
  {
    "code": "BJ",
    "name": "Бенин"
  },
  {
    "code": "BM",
    "name": "Бермуды"
  },
  {
    "code": "BG",
    "name": "Болгария"
  },
  {
    "code": "BO",
    "name": "Боливия"
  },
  {
    "code": "BQ",
    "name": "Бонэйр, Синт-Эстатиус и Саба"
  },
  {
    "code": "BA",
    "name": "Босния и Герцеговина"
  },
  {
    "code": "BW",
    "name": "Ботсвана"
  },
  {
    "code": "BR",
    "name": "Бразилия"
  },
  {
    "code": "IO",
    "name": "Британская территория в Индийском океане"
  },
  {
    "code": "VG",
    "name": "Британские Виргинские острова"
  },
  {
    "code": "BN",
    "name": "Бруней"
  },
  {
    "code": "BF",
    "name": "Буркина-Фасо"
  },
  {
    "code": "BI",
    "name": "Бурунди"
  },
  {
    "code": "BT",
    "name": "Бутан"
  },
  {
    "code": "VU",
    "name": "Вануату"
  },
  {
    "code": "VA",
    "name": "Ватикан"
  },
  {
    "code": "GB",
    "name": "Великобритания"
  },
  {
    "code": "HU",
    "name": "Венгрия"
  },
  {
    "code": "VE",
    "name": "Венесуэла"
  },
  {
    "code": "UM",
    "name": "Внешние малые острова США"
  },
  {
    "code": "TL",
    "name": "Восточный Тимор"
  },
  {
    "code": "VN",
    "name": "Вьетнам"
  },
  {
    "code": "GA",
    "name": "Габон"
  },
  {
    "code": "HT",
    "name": "Гаити"
  },
  {
    "code": "GY",
    "name": "Гайана"
  },
  {
    "code": "GM",
    "name": "Гамбия"
  },
  {
    "code": "GH",
    "name": "Гана"
  },
  {
    "code": "GP",
    "name": "Гваделупа"
  },
  {
    "code": "GT",
    "name": "Гватемала"
  },
  {
    "code": "GN",
    "name": "Гвинея"
  },
  {
    "code": "GW",
    "name": "Гвинея-Бисау"
  },
  {
    "code": "DE",
    "name": "Германия"
  },
  {
    "code": "GG",
    "name": "Гернси"
  },
  {
    "code": "GI",
    "name": "Гибралтар"
  },
  {
    "code": "HN",
    "name": "Гондурас"
  },
  {
    "code": "HK",
    "name": "Гонконг"
  },
  {
    "code": "GD",
    "name": "Гренада"
  },
  {
    "code": "GL",
    "name": "Гренландия"
  },
  {
    "code": "GR",
    "name": "Греция"
  },
  {
    "code": "GE",
    "name": "Грузия"
  },
  {
    "code": "GU",
    "name": "Гуам"
  },
  {
    "code": "DK",
    "name": "Дания"
  },
  {
    "code": "JE",
    "name": "Джерси"
  },
  {
    "code": "DJ",
    "name": "Джибути"
  },
  {
    "code": "DM",
    "name": "Доминика"
  },
  {
    "code": "DO",
    "name": "Доминиканская Республика"
  },
  {
    "code": "CD",
    "name": "ДР Конго"
  },
  {
    "code": "EG",
    "name": "Египет"
  },
  {
    "code": "ZM",
    "name": "Замбия"
  },
  {
    "code": "EH",
    "name": "Западная Сахара"
  },
  {
    "code": "ZW",
    "name": "Зимбабве"
  },
  {
    "code": "IL",
    "name": "Израиль"
  },
  {
    "code": "IN",
    "name": "Индия"
  },
  {
    "code": "ID",
    "name": "Индонезия"
  },
  {
    "code": "JO",
    "name": "Иордания"
  },
  {
    "code": "IQ",
    "name": "Ирак"
  },
  {
    "code": "IR",
    "name": "Иран"
  },
  {
    "code": "IE",
    "name": "Ирландия"
  },
  {
    "code": "IS",
    "name": "Исландия"
  },
  {
    "code": "ES",
    "name": "Испания"
  },
  {
    "code": "IT",
    "name": "Италия"
  },
  {
    "code": "YE",
    "name": "Йемен"
  },
  {
    "code": "CV",
    "name": "Кабо-Верде"
  },
  {
    "code": "KZ",
    "name": "Казахстан"
  },
  {
    "code": "KH",
    "name": "Камбоджа"
  },
  {
    "code": "CM",
    "name": "Камерун"
  },
  {
    "code": "CA",
    "name": "Канада"
  },
  {
    "code": "QA",
    "name": "Катар"
  },
  {
    "code": "KE",
    "name": "Кения"
  },
  {
    "code": "CY",
    "name": "Кипр"
  },
  {
    "code": "KI",
    "name": "Кирибати"
  },
  {
    "code": "CN",
    "name": "Китай"
  },
  {
    "code": "KP",
    "name": "КНДР"
  },
  {
    "code": "CC",
    "name": "Кокосовые острова"
  },
  {
    "code": "CO",
    "name": "Колумбия"
  },
  {
    "code": "KM",
    "name": "Коморы"
  },
  {
    "code": "CG",
    "name": "Конго"
  },
  {
    "code": "CR",
    "name": "Коста-Рика"
  },
  {
    "code": "CI",
    "name": "Кот-д’Ивуар"
  },
  {
    "code": "CU",
    "name": "Куба"
  },
  {
    "code": "KW",
    "name": "Кувейт"
  },
  {
    "code": "KG",
    "name": "Кыргызстан"
  },
  {
    "code": "CW",
    "name": "Кюрасао"
  },
  {
    "code": "LA",
    "name": "Лаос"
  },
  {
    "code": "LV",
    "name": "Латвия"
  },
  {
    "code": "LS",
    "name": "Лесото"
  },
  {
    "code": "LR",
    "name": "Либерия"
  },
  {
    "code": "LB",
    "name": "Ливан"
  },
  {
    "code": "LY",
    "name": "Ливия"
  },
  {
    "code": "LT",
    "name": "Литва"
  },
  {
    "code": "LI",
    "name": "Лихтенштейн"
  },
  {
    "code": "LU",
    "name": "Люксембург"
  },
  {
    "code": "MU",
    "name": "Маврикий"
  },
  {
    "code": "MR",
    "name": "Мавритания"
  },
  {
    "code": "MG",
    "name": "Мадагаскар"
  },
  {
    "code": "YT",
    "name": "Майотта"
  },
  {
    "code": "MO",
    "name": "Макао"
  },
  {
    "code": "MW",
    "name": "Малави"
  },
  {
    "code": "MY",
    "name": "Малайзия"
  },
  {
    "code": "ML",
    "name": "Мали"
  },
  {
    "code": "MV",
    "name": "Мальдивы"
  },
  {
    "code": "MT",
    "name": "Мальта"
  },
  {
    "code": "MA",
    "name": "Марокко"
  },
  {
    "code": "MQ",
    "name": "Мартиника"
  },
  {
    "code": "MH",
    "name": "Маршалловы Острова"
  },
  {
    "code": "MX",
    "name": "Мексика"
  },
  {
    "code": "FM",
    "name": "Микронезия"
  },
  {
    "code": "MZ",
    "name": "Мозамбик"
  },
  {
    "code": "MD",
    "name": "Молдова"
  },
  {
    "code": "MC",
    "name": "Монако"
  },
  {
    "code": "MN",
    "name": "Монголия"
  },
  {
    "code": "MS",
    "name": "Монтсеррат"
  },
  {
    "code": "MM",
    "name": "Мьянма"
  },
  {
    "code": "NA",
    "name": "Намибия"
  },
  {
    "code": "NR",
    "name": "Науру"
  },
  {
    "code": "NP",
    "name": "Непал"
  },
  {
    "code": "NE",
    "name": "Нигер"
  },
  {
    "code": "NG",
    "name": "Нигерия"
  },
  {
    "code": "NL",
    "name": "Нидерланды"
  },
  {
    "code": "NI",
    "name": "Никарагуа"
  },
  {
    "code": "NU",
    "name": "Ниуэ"
  },
  {
    "code": "NZ",
    "name": "Новая Зеландия"
  },
  {
    "code": "NC",
    "name": "Новая Каледония"
  },
  {
    "code": "NO",
    "name": "Норвегия"
  },
  {
    "code": "AE",
    "name": "ОАЭ"
  },
  {
    "code": "OM",
    "name": "Оман"
  },
  {
    "code": "BV",
    "name": "Остров Буве"
  },
  {
    "code": "IM",
    "name": "Остров Мэн"
  },
  {
    "code": "NF",
    "name": "Остров Норфолк"
  },
  {
    "code": "CX",
    "name": "Остров Рождества"
  },
  {
    "code": "SH",
    "name": "Остров Святой Елены"
  },
  {
    "code": "HM",
    "name": "Остров Херд и острова Макдональд"
  },
  {
    "code": "KY",
    "name": "Острова Кайман"
  },
  {
    "code": "CK",
    "name": "Острова Кука"
  },
  {
    "code": "PN",
    "name": "Острова Питкэрн"
  },
  {
    "code": "TC",
    "name": "Острова Тёркс и Кайкос"
  },
  {
    "code": "PK",
    "name": "Пакистан"
  },
  {
    "code": "PW",
    "name": "Палау"
  },
  {
    "code": "PS",
    "name": "Палестина"
  },
  {
    "code": "PA",
    "name": "Панама"
  },
  {
    "code": "PG",
    "name": "Папуа — Новая Гвинея"
  },
  {
    "code": "PY",
    "name": "Парагвай"
  },
  {
    "code": "PE",
    "name": "Перу"
  },
  {
    "code": "PL",
    "name": "Польша"
  },
  {
    "code": "PT",
    "name": "Португалия"
  },
  {
    "code": "PR",
    "name": "Пуэрто-Рико"
  },
  {
    "code": "KR",
    "name": "Республика Корея"
  },
  {
    "code": "RE",
    "name": "Реюньон"
  },
  {
    "code": "RU",
    "name": "Россия"
  },
  {
    "code": "RW",
    "name": "Руанда"
  },
  {
    "code": "RO",
    "name": "Румыния"
  },
  {
    "code": "SV",
    "name": "Сальвадор"
  },
  {
    "code": "WS",
    "name": "Самоа"
  },
  {
    "code": "SM",
    "name": "Сан-Марино"
  },
  {
    "code": "ST",
    "name": "Сан-Томе и Принсипи"
  },
  {
    "code": "SA",
    "name": "Саудовская Аравия"
  },
  {
    "code": "MK",
    "name": "Северная Македония"
  },
  {
    "code": "MP",
    "name": "Северные Марианские острова"
  },
  {
    "code": "SC",
    "name": "Сейшелы"
  },
  {
    "code": "BL",
    "name": "Сен-Бартелеми"
  },
  {
    "code": "MF",
    "name": "Сен-Мартен"
  },
  {
    "code": "PM",
    "name": "Сен-Пьер и Микелон"
  },
  {
    "code": "SN",
    "name": "Сенегал"
  },
  {
    "code": "VC",
    "name": "Сент-Винсент и Гренадины"
  },
  {
    "code": "KN",
    "name": "Сент-Китс и Невис"
  },
  {
    "code": "LC",
    "name": "Сент-Люсия"
  },
  {
    "code": "RS",
    "name": "Сербия"
  },
  {
    "code": "SG",
    "name": "Сингапур"
  },
  {
    "code": "SX",
    "name": "Синт-Мартен"
  },
  {
    "code": "SY",
    "name": "Сирия"
  },
  {
    "code": "SK",
    "name": "Словакия"
  },
  {
    "code": "SI",
    "name": "Словения"
  },
  {
    "code": "SB",
    "name": "Соломоновы Острова"
  },
  {
    "code": "SO",
    "name": "Сомали"
  },
  {
    "code": "SD",
    "name": "Судан"
  },
  {
    "code": "SR",
    "name": "Суринам"
  },
  {
    "code": "US",
    "name": "США"
  },
  {
    "code": "SL",
    "name": "Сьерра-Леоне"
  },
  {
    "code": "TJ",
    "name": "Таджикистан"
  },
  {
    "code": "TH",
    "name": "Таиланд"
  },
  {
    "code": "TW",
    "name": "Тайвань"
  },
  {
    "code": "TZ",
    "name": "Танзания"
  },
  {
    "code": "TG",
    "name": "Того"
  },
  {
    "code": "TK",
    "name": "Токелау"
  },
  {
    "code": "TO",
    "name": "Тонга"
  },
  {
    "code": "TT",
    "name": "Тринидад и Тобаго"
  },
  {
    "code": "TV",
    "name": "Тувалу"
  },
  {
    "code": "TN",
    "name": "Тунис"
  },
  {
    "code": "TM",
    "name": "Туркменистан"
  },
  {
    "code": "TR",
    "name": "Турция"
  },
  {
    "code": "UG",
    "name": "Уганда"
  },
  {
    "code": "UZ",
    "name": "Узбекистан"
  },
  {
    "code": "UA",
    "name": "Украина"
  },
  {
    "code": "WF",
    "name": "Уоллис и Футуна"
  },
  {
    "code": "UY",
    "name": "Уругвай"
  },
  {
    "code": "FO",
    "name": "Фарерские острова"
  },
  {
    "code": "FJ",
    "name": "Фиджи"
  },
  {
    "code": "PH",
    "name": "Филиппины"
  },
  {
    "code": "FI",
    "name": "Финляндия"
  },
  {
    "code": "FK",
    "name": "Фолклендские острова"
  },
  {
    "code": "FR",
    "name": "Франция"
  },
  {
    "code": "GF",
    "name": "Французская Гвиана"
  },
  {
    "code": "PF",
    "name": "Французская Полинезия"
  },
  {
    "code": "TF",
    "name": "Французские Южные территории"
  },
  {
    "code": "HR",
    "name": "Хорватия"
  },
  {
    "code": "CF",
    "name": "ЦАР"
  },
  {
    "code": "TD",
    "name": "Чад"
  },
  {
    "code": "ME",
    "name": "Черногория"
  },
  {
    "code": "CZ",
    "name": "Чехия"
  },
  {
    "code": "CL",
    "name": "Чили"
  },
  {
    "code": "CH",
    "name": "Швейцария"
  },
  {
    "code": "SE",
    "name": "Швеция"
  },
  {
    "code": "SJ",
    "name": "Шпицберген и Ян-Майен"
  },
  {
    "code": "LK",
    "name": "Шри-Ланка"
  },
  {
    "code": "EC",
    "name": "Эквадор"
  },
  {
    "code": "GQ",
    "name": "Экваториальная Гвинея"
  },
  {
    "code": "ER",
    "name": "Эритрея"
  },
  {
    "code": "SZ",
    "name": "Эсватини"
  },
  {
    "code": "EE",
    "name": "Эстония"
  },
  {
    "code": "ET",
    "name": "Эфиопия"
  },
  {
    "code": "ZA",
    "name": "ЮАР"
  },
  {
    "code": "GS",
    "name": "Южная Георгия и Южные Сандвичевы острова"
  },
  {
    "code": "SS",
    "name": "Южный Судан"
  },
  {
    "code": "JM",
    "name": "Ямайка"
  },
  {
    "code": "JP",
    "name": "Япония"
  }
];

module.exports = { GEO_COUNTRY_OPTIONS };
