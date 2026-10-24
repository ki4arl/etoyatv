'use strict';

/**
 * Forbidden-words seed for usernames / channel names / content filter.
 *
 * Strategy:
 * - Long stems (≥4) catch Russian declensions/conjugations via substring match in wordFilter.
 * - Short roots get explicit case/verb forms generated.
 * - Translit + EN variants expanded with common suffixes.
 * - Compounds / leet / slogans as literals.
 */

const RU_CASE_ENDINGS = [
  '', 'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о',
  'ой', 'ей', 'ом', 'ём', 'ем', 'ами', 'ями', 'ах', 'ях',
  'ов', 'ев', 'ёв', 'ам', 'ям',
  'ый', 'ий', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
  'ого', 'его', 'ому', 'ему', 'ым', 'им', 'ую', 'юю',
  'ых', 'их', 'ыми', 'ими',
  'ка', 'ки', 'ке', 'ку', 'кой', 'ок', 'ков',
  'ик', 'ика', 'ики', 'иков', 'ец', 'ца', 'цы',
];

const RU_VERB_ENDINGS = [
  '', 'ть', 'ти', 'л', 'ла', 'ло', 'ли',
  'у', 'ю', 'ешь', 'ёт', 'ет', 'ем', 'ёте', 'ете', 'ут', 'ют',
  'ал', 'ала', 'ало', 'али', 'ял', 'яла', 'яли',
  'нул', 'нула', 'нули', 'ни', 'ите',
  'ать', 'ять', 'ить', 'еть', 'уть',
  'анный', 'анная', 'анное', 'анные', 'еный', 'ённый',
  'ающий', 'яющий', 'ующий',
];

/** Stems ≥4 chars — wordFilter.includes already covers склонения */
const RU_STEMS_LONG = [
  'бляд', 'блядин', 'блядств', 'блядюг', 'блядун',
  'хуйн', 'хуев', 'хуёв', 'хуесос', 'хуеплёт', 'хуеплет', 'хуил', 'хуище', 'хуйло',
  'пизд', 'пиздюк', 'пиздюл', 'пиздёж', 'пиздеж', 'распизд', 'пиздабол',
  'ебан', 'ёбан', 'ебл', 'еблан', 'ебанут', 'ебаш', 'ебись', 'ёбись',
  'заеб', 'заёб', 'уебан', 'уёбан', 'уебищ', 'уёбищ', 'долбоёб', 'долбоеб',
  'мудак', 'мудил', 'мудозвон', 'гандон', 'гондон',
  'сучар', 'сучен', 'сучк',
  'шлюх', 'проститут', 'путана', 'шалав',
  'дроч', 'онанизм', 'мастурб',
  'педик', 'пидор', 'пидар', 'педрил', 'гомик',
  'мраз', 'падл', 'подонок', 'выродок', 'ублюд', 'скотин',
  'дебил', 'идиот', 'кретин', 'чмошник', 'даун',
  'жопк', 'сран', 'говн', 'дерьм', 'дрисн',
  'мандовош', 'залуп', 'херн', 'херов',
  'трах', 'выеб', 'отсос', 'отлиз',
  'минет', 'куннилингус', 'анальн', 'фелляц',
  'сперм', 'оргазм', 'кончай',
  'сиськ', 'титьк', 'письк', 'писюн',
  'нигер', 'ниггер',
  'жидов', 'жидён', 'жиден',
  'хачик', 'чурбан',
  'москал', 'рашист', 'рашизм',
  'нацист', 'нацизм', 'фашист', 'фашизм', 'скинхед', 'скинхэд',
  'гитлер', 'террор', 'террорист', 'терроризм',
  'зоофил', 'зоофили', 'педофил', 'педофили',
  'инцест', 'насильн', 'изнасиловат', 'изнасилован',
  'порнух',
  'наркот', 'героин', 'кокаин', 'амфетамин', 'метамфетамин',
  'суицид', 'самоубийств',
  'гнид', 'сволот', 'падлюк',
  'выёбыва', 'выебыва', 'охуен', 'охуев',
  'пиздец', 'нахуй', 'похуй', 'впизду',
  'конченый', 'конченые', 'кончен',
  // extra slang / hate / sexual / spam stems
  'скотин', 'козёл', 'козел', 'козлин',
  'имбецил', 'олигофрен', 'психопат', 'шизик',
  'бомж', 'бомжар', 'нищет', 'нищеброд',
  'сдохн', 'подохн', 'зарежу',
  'расчлен', 'садист', 'маньяк',
  'говноед', 'говнюк', 'говнюч', 'срач',
  'пердун', 'бздун', 'вонюч',
  'шлюшк', 'проститутк', 'бордел', 'бордель',
  'онанист', 'дрочил', 'дрочер', 'малафь',
  'гомосек', 'педераст',
  'некрофил', 'некрофили',
  'лесбиян', 'лесбух',
  'черножоп', 'узкоглаз', 'косоглаз',
  'кацап', 'бульбаш', 'пиндос',
  'ватник',
  'шахид', 'шахидк', 'джихад', 'джихадист',
  'наркошан', 'торчок', 'наркоман', 'наркодилер',
  'мефедрон', 'альфапвп',
  'казинобот', 'крипторазвод', 'фишинг',
  'доксинг', 'сватер',
];

/** Short roots — generate explicit forms */
const RU_SHORT = [
  'хуй', 'хуе', 'хуё', 'хуя', 'хую', 'хуем', 'хуём', 'хуйня',
  'еб', 'ёб', 'еби', 'ёби', 'ебу', 'ебёт', 'ебет',
  'сук', 'сука', 'суки', 'суке', 'суку', 'сукой',
  'жоп', 'жопа', 'жопы', 'жопе', 'жопу', 'жопой',
  'пидр', 'пидры', 'пидров',
  'хач', 'хачи', 'хача',
  'жид', 'жиды', 'жида', 'жиду', 'жидом',
  'тварь', 'твари', 'тварей',
  'хер', 'херы', 'херу', 'хером',
  'манда', 'манды', 'манде', 'манду',
  'чурк', 'чурка', 'чурки', 'чурке',
  'хохл', 'хохол', 'хохла', 'хохлы',
  'ссать', 'ссыт', 'ссышь', 'ссал',
  'срать', 'срёт', 'срет', 'срал',
];

const TRANSLIT_STEMS = [
  'blyad', 'blyat', 'blyadin', 'blyadstv',
  'hui', 'huy', 'xyu', 'xyi', 'huin', 'huev', 'huesos', 'hueplet', 'huilo',
  'pizd', 'pizdec', 'pizdyuk', 'pizdyul', 'raspizd', 'pizdabol',
  'ebat', 'ebal', 'eban', 'eblo', 'eblan', 'ebanut', 'ebash',
  'zaeb', 'zaebal', 'uebok', 'ueban', 'uebish', 'dolboeb',
  'mudak', 'mudila', 'gandon', 'gondon',
  'suka', 'suchar', 'suchka',
  'shluh', 'shalav',
  'droch', 'drocher',
  'pedik', 'pidor', 'pidar', 'pidr', 'gomik',
  'mraz', 'ublud', 'debil',
  'naxui', 'nahui', 'nahuy', 'poshelnahui',
  'nazi', 'hitler', 'faggot', 'nigger', 'nigga',
  'pedo', 'pedophil', 'incest', 'rapist',
  'porno', 'porn', 'onlyfans',
  'cocaine', 'heroin', 'fentanyl', 'meth',
  'suicide', 'terrorist', 'churka', 'khach', 'zhid',
];

const TRANSLIT_ENDS = [
  '', 'a', 'i', 'u', 'e', 'y', 'ov', 'ev', 'om', 'ami', 'ah',
  'ka', 'ki', 'ku', 'ok', 'ik',
  'at', 'et', 'it', 'ut', 'al', 'ala', 'ali', 'nul', 'nut',
  'anyi', 'enyj', 'nyi', 'ing', 'er', 'ers', 'ed', 's',
];

const EN_BASE = [
  'fuck', 'fucker', 'fucking', 'fucked', 'motherfucker', 'fucktard', 'fuckface', 'fuckboy', 'fuckgirl',
  'shit', 'bullshit', 'shithead', 'shitty', 'shitface', 'dipshit',
  'bitch', 'bitches', 'bitching', 'sonofabitch',
  'bastard', 'asshole', 'assholes', 'dickhead', 'dickwad', 'dickface',
  'cunt', 'cunts', 'whore', 'whores', 'slut', 'sluts', 'slutty',
  'cock', 'cocks', 'cocksucker', 'blowjob', 'handjob', 'deepthroat',
  'pussy', 'pussies', 'vagina', 'penis', 'dildo', 'vibrator',
  'nazi', 'nazis', 'nazism', 'neonazi', 'whitepower', 'kkk',
  'terrorist', 'terrorism', 'bombing',
  'retard', 'retarded', 'retards',
  'faggot', 'faggots', 'fagot',
  'nigger', 'niggers', 'nigga', 'niggas',
  'rape', 'raped', 'raping', 'rapist', 'rapists',
  'pedophile', 'pedophilia', 'paedophile', 'childporn', 'childsex', 'jailbait',
  'bestiality', 'zoophilia', 'necrophilia', 'incest',
  'killall', 'schoolshooter', 'massmurder', 'killmyself',
  'pornhub', 'xvideos', 'xnxx', 'camgirl', 'sexcam', 'sexshop',
  'cocaine', 'heroin', 'methamphetamine', 'fentanyl',
  'hitler', 'heilhitler', 'siegheil', 'whitepower88',
];

const EN_SUFFIXES = ['', 's', 'es', 'ed', 'ing', 'er', 'ers', 'y', 'ies', 'ly'];

const EXTRA_LITERALS = [
  'ебтвоюмать', 'ёбтвоюмать', 'ебалмать', 'впизду', 'нахуй', 'нахер', 'похуй',
  'охуеть', 'охуел', 'охуенно', 'пиздатая', 'хуета', 'хуетень',
  'заебись', 'отъебись', 'отъёбись', 'пошёлнахуй', 'пошелнахуй',
  'убитьвсех', 'смертьжидам', 'смертьнеграм', 'deathjews', 'killniggers',
  'heilhitler', 'siegheil', '1488', '14words', 'whitepower88',
  'childrape', 'rapekids', 'underageporn', 'lolicon', 'shotacon',
  'freebitcoin', 'getrichquick', 'casinohack',
  'f4ck', 'fuk', 'fvck', 'sh1t', 'b1tch', 'n1gger', 'n1gga', 'a55hole',
  'p0rn', 'pr0n', 'h1tler', 'n4zi',
  'suckmydick', 'lickmypussy', 'ilovefucking',
  'xxx', 'xxxtube', 'sexcam', 'onlyfans',
  'игил', 'isis', 'alqaeda',
  'жидёнок', 'жиденок',
  'kurwa', 'kurwy', 'jebac', 'pierdol', 'pierdolic',
  'хуйло', 'пиздабол', 'падлюка', 'сволота', 'гнида',
  'блять', 'блядь', 'сука', 'пиздец',
  'ебать', 'ёбать', 'ебаный', 'ёбаный', 'ебаная', 'ёбаная',
  'хуярить', 'хуярил', 'хуярит',
  'запиздил', 'запиздила', 'распиздяй',
  'отпиздил', 'отпиздила', 'наебал', 'наёбал', 'наебала',
  'выебал', 'выебала', 'выебать',
  'чмо', 'чмошник', 'лох', 'лошара', 'дрочер',
  'спермотоксикоз', 'вафлёр', 'вафлер', 'вафля',
  'бздун', 'пердун', 'сраный', 'сраная',
  'fuckoff', 'goofyourself', 'kys', 'diebitch',
  'weedshop', 'darknetmarket', 'buydrugs',
];

function uniquePush(set, w) {
  const t = String(w || '').trim().toLowerCase();
  if (!t || t.length < 3 || t.length > 48) return;
  if (/^\d+$/.test(t)) return;
  set.add(t);
}

function expandShortRu(set, root) {
  for (const end of RU_CASE_ENDINGS) uniquePush(set, root + end);
  for (const end of RU_VERB_ENDINGS) uniquePush(set, root + end);
}

function expandTranslit(set, stem) {
  // Stems + suffixes only (no full prefix grid — keeps list usable for filter)
  for (const e of TRANSLIT_ENDS) uniquePush(set, stem + e);
  // High-signal prefixed forms only
  for (const p of ['po', 'za', 'na', 'ot', 'vy', 'do', 'pro', 'pere', 'ras', 'raz']) {
    uniquePush(set, p + stem);
    uniquePush(set, p + stem + 'al');
    uniquePush(set, p + stem + 'at');
  }
}

function expandEn(set, word) {
  for (const s of EN_SUFFIXES) uniquePush(set, word + s);
}

function buildForbiddenWordsSet() {
  const set = new Set();

  // Long stems + light case endings (substring match covers most declensions;
  // endings help content replace and catch compounds)
  const lightEnds = [
    '', 'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о', 'ой', 'ей', 'ом', 'ём',
    'ами', 'ов', 'ев', 'ам', 'ах', 'ый', 'ий', 'ая', 'ое', 'ые',
    'ка', 'ки', 'ок', 'ик', 'ец', 'уха', 'юга', 'ёнок', 'енок',
    'ство', 'щин', 'щина', 'нутый', 'нутая',
  ];
  for (const s of RU_STEMS_LONG) {
    for (const e of lightEnds) uniquePush(set, s + e);
  }
  for (const s of RU_SHORT) expandShortRu(set, s);

  // Common prefixed compounds for high-signal stems only
  const prefTargets = [
    'еб', 'ёб', 'ебан', 'ёбан', 'пизд', 'хуй', 'хуе', 'хуё', 'бляд', 'дроч', 'трах', 'муд',
  ];
  const prefs = ['по', 'за', 'на', 'от', 'вы', 'до', 'про', 'пере', 'об', 'под', 'при', 'раз', 'рас', 'из', 'с', 'у', 'в', 'о'];
  for (const stem of prefTargets) {
    for (const p of prefs) {
      uniquePush(set, p + stem);
      for (const end of ['ал', 'ала', 'али', 'ать', 'ить', 'нул', 'анный', 'а', 'и', 'у', '']) {
        uniquePush(set, p + stem + end);
      }
    }
  }

  for (const s of TRANSLIT_STEMS) expandTranslit(set, s);
  for (const w of EN_BASE) expandEn(set, w);
  for (const w of EXTRA_LITERALS) uniquePush(set, w);

  // ё ↔ е dual
  for (const w of [...set]) {
    if (w.includes('ё')) uniquePush(set, w.replace(/ё/g, 'е'));
  }
  return set;
}

function uniqueSorted(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const w = String(raw || '').trim().toLowerCase();
    if (!w || w.length < 3) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  out.sort((a, b) => a.localeCompare(b, 'ru'));
  return out;
}

function getForbiddenWordsSeedCsv() {
  return uniqueSorted([...buildForbiddenWordsSet()]).join(', ');
}

module.exports = {
  buildForbiddenWordsSet,
  getForbiddenWordsSeedCsv,
  uniqueSorted
};
