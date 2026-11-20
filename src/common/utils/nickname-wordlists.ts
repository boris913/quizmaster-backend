// ============================================================
// Listes de mots pour la modération et la génération des pseudos (issue #5)
//
// Toutes les entrées de modération sont écrites sous forme NORMALISÉE :
// minuscules, sans accents, sans chiffres ni ponctuation (voir
// `normalizeForModeration` dans nickname.util.ts). Les lettres répétées sont
// réduites automatiquement à la comparaison : inutile d'écrire les variantes.
//
// Ces listes sont volontairement limitées aux termes courants. Elles sont
// destinées à être complétées au fil des signalements des enseignants.
// ============================================================

/**
 * Termes graves (insultes fortes, termes sexuels explicites, injures
 * discriminatoires) : refusés même à l'intérieur d'un mot (« sous-chaîne »).
 * Ne mettre ici que des termes assez longs et spécifiques pour ne pas
 * apparaître par hasard dans des mots courants ; sinon, ajouter les mots
 * légitimes concernés à `NICKNAME_EXCEPTIONS`.
 */
export const SEVERE_TERMS: readonly string[] = [
  // Français
  "connard",
  "connasse",
  "encule",
  "enfoire",
  "salope",
  "salaud",
  "pute",
  "putain",
  "pouffiasse",
  "batard",
  "bite",
  "couille",
  "nique",
  "niquer",
  "pedophile",
  "pedale",
  "tapette",
  "gouine",
  "negre",
  "bougnoul",
  "youpin",
  "bamboula",
  "nazi",
  "hitler",
  "sodomie",
  "branleur",
  "branlette",
  "fellation",
  // Anglais
  "fuck",
  "motherfucker",
  "cunt",
  "bitch",
  "whore",
  "slut",
  "nigger",
  "nigga",
  "faggot",
  "rapist",
  "pussy",
  "penis",
  "vagina",
  "dildo",
  "porn",
  "asshole",
  "bastard",
  "wanker",
  "cock",
  "dickhead",
];

/**
 * Termes modérés : refusés seulement comme mot entier (séparé par un espace,
 * un tiret, un underscore, un changement de casse « camelCase ») ou si le
 * pseudo entier se réduit à ce terme. Ils sont trop courts ou trop ambigus
 * pour être cherchés à l'intérieur d'un mot (« con » dans « Constance »).
 */
export const MILD_TERMS: readonly string[] = [
  // Français
  "con",
  "conne",
  "merde",
  "merdeux",
  "cul",
  "abruti",
  "debile",
  "cretin",
  "idiot",
  "imbecile",
  "pd",
  "fdp",
  "ntm",
  "chatte",
  "tg",
  "nul",
  "naze",
  "boloss",
  "bouffon",
  "gogol",
  "mongol",
  "triso",
  "pisse",
  "caca",
  "zizi",
  "sexe",
  "sexy",
  // Anglais
  "shit",
  "ass",
  "damn",
  "retard",
  "crap",
  "piss",
  "sex",
  "fag",
  "wtf",
  "stfu",
  "moron",
  "dumb",
  "loser",
  "kys",
];

/**
 * Mots légitimes qui contiennent un terme grave en sous-chaîne. Ils sont
 * neutralisés avant la recherche des sous-chaînes. Forme normalisée.
 */
export const NICKNAME_EXCEPTIONS: readonly string[] = [
  // « pute »
  "depute",
  "computer",
  "dispute",
  "disputer",
  "repute",
  "imputer",
  "amputer",
  // « bite »
  "habite",
  "habiter",
  "habitant",
  "orbite",
  "cohabite",
  "subite",
  "subitement",
  "bitume",
  // « nique »
  "unique",
  "technique",
  "clinique",
  "tunique",
  "panique",
  "monique",
  "veronique",
  "dominique",
  "chronique",
  // « couille » (aucune exception courante)
  // « cock »
  "cocker",
  "cockpit",
  "cocktail",
  "peacock",
  "hitchcock",
  "hancock",
  "woodcock",
  "babcock",
  // « cunt »
  "scunthorpe",
  // « porn »
  "pornic",
  // « rapist »
  "therapist",
  // « negre » / « nigger » (« Niger » est un pays)
  "niger",
  "nigeria",
  // « gouine » (à cheval sur deux mots : « Pingouin Espiègle »)
  "pingouin",
  // « nazi »
  "nazim",
  "nazir",
  // « bitch »
  // « slut »
  // « penis »
  "penistone",
  // « salaud » / « batard » : aucune exception courante
  // « pedale »
  "pedaler",
  "pedalo",
  "pedalier",
  // « tapette »
  // « bastard »
];

// ============================================================
// GÉNÉRATEUR DE PSEUDOS (mode « generated »)
// Noms d'animaux et adjectifs positifs ou neutres, accordés en genre.
// ============================================================

export type Gender = "m" | "f";

export interface GeneratorNoun {
  word: string;
  gender: Gender;
}

export interface GeneratorAdjective {
  m: string;
  f: string;
}

const m = (word: string): GeneratorNoun => ({ word, gender: "m" });
const f = (word: string): GeneratorNoun => ({ word, gender: "f" });

/** Noms d'animaux (un seul mot, sans espace), avec leur genre grammatical. */
export const GENERATOR_NOUNS: readonly GeneratorNoun[] = [
  m("Hibou"),
  f("Loutre"),
  m("Renard"),
  f("Chouette"),
  m("Lynx"),
  f("Panthère"),
  m("Castor"),
  f("Baleine"),
  m("Dauphin"),
  f("Tortue"),
  m("Koala"),
  f("Girafe"),
  m("Panda"),
  f("Gazelle"),
  m("Tigre"),
  f("Hirondelle"),
  m("Lion"),
  f("Abeille"),
  m("Loup"),
  f("Coccinelle"),
  m("Ours"),
  f("Libellule"),
  m("Faucon"),
  f("Mouette"),
  m("Aigle"),
  f("Grenouille"),
  m("Pingouin"),
  f("Fourmi"),
  m("Manchot"),
  f("Marmotte"),
  m("Hérisson"),
  f("Belette"),
  m("Écureuil"),
  f("Hermine"),
  m("Lapin"),
  f("Cigogne"),
  m("Blaireau"),
  f("Mésange"),
  m("Chamois"),
  f("Antilope"),
  m("Bison"),
  f("Pieuvre"),
  m("Gecko"),
  f("Méduse"),
  m("Morse"),
  f("Raie"),
  m("Requin"),
  f("Sardine"),
  m("Saumon"),
  f("Truite"),
  m("Flamant"),
  f("Autruche"),
  m("Paon"),
  f("Perruche"),
  m("Perroquet"),
  f("Colombe"),
  m("Moineau"),
  f("Fauvette"),
  m("Rouge-gorge"),
  f("Alouette"),
  m("Pélican"),
  f("Gerboise"),
  m("Héron"),
  f("Tourterelle"),
  m("Toucan"),
  f("Pie"),
  m("Corbeau"),
  f("Licorne"),
  m("Dragon"),
  f("Salamandre"),
  m("Lézard"),
  f("Couleuvre"),
  m("Caméléon"),
  f("Chenille"),
  m("Papillon"),
  f("Cigale"),
  m("Grillon"),
  f("Sauterelle"),
  m("Scarabée"),
  f("Luciole"),
  m("Escargot"),
  f("Crevette"),
  m("Homard"),
  f("Langouste"),
  m("Crabe"),
  f("Étoile-de-mer"),
  m("Kangourou"),
  f("Mangouste"),
  m("Suricate"),
  f("Biche"),
  m("Cerf"),
  f("Chèvre"),
  m("Mouton"),
  f("Brebis"),
  m("Poney"),
  f("Jument"),
  m("Zèbre"),
  f("Otarie"),
  m("Dromadaire"),
  f("Oie"),
  m("Canard"),
  f("Caille"),
  m("Lama"),
  f("Souris"),
];

/** Adjectifs positifs ou neutres, forme masculine et forme féminine. */
export const GENERATOR_ADJECTIVES: readonly GeneratorAdjective[] = [
  { m: "Curieux", f: "Curieuse" },
  { m: "Malin", f: "Maligne" },
  { m: "Rapide", f: "Rapide" },
  { m: "Joyeux", f: "Joyeuse" },
  { m: "Brillant", f: "Brillante" },
  { m: "Courageux", f: "Courageuse" },
  { m: "Agile", f: "Agile" },
  { m: "Calme", f: "Calme" },
  { m: "Rusé", f: "Rusée" },
  { m: "Sage", f: "Sage" },
  { m: "Vaillant", f: "Vaillante" },
  { m: "Espiègle", f: "Espiègle" },
  { m: "Gourmand", f: "Gourmande" },
  { m: "Étonnant", f: "Étonnante" },
  { m: "Patient", f: "Patiente" },
  { m: "Prudent", f: "Prudente" },
  { m: "Généreux", f: "Généreuse" },
  { m: "Rêveur", f: "Rêveuse" },
  { m: "Studieux", f: "Studieuse" },
  { m: "Audacieux", f: "Audacieuse" },
  { m: "Astucieux", f: "Astucieuse" },
  { m: "Lumineux", f: "Lumineuse" },
  { m: "Mystérieux", f: "Mystérieuse" },
  { m: "Pétillant", f: "Pétillante" },
  { m: "Souriant", f: "Souriante" },
  { m: "Bavard", f: "Bavarde" },
  { m: "Discret", f: "Discrète" },
  { m: "Élégant", f: "Élégante" },
  { m: "Fier", f: "Fière" },
  { m: "Gentil", f: "Gentille" },
  { m: "Habile", f: "Habile" },
  { m: "Intrépide", f: "Intrépide" },
  { m: "Jovial", f: "Joviale" },
  { m: "Loyal", f: "Loyale" },
  { m: "Magique", f: "Magique" },
  { m: "Noble", f: "Noble" },
  { m: "Original", f: "Originale" },
  { m: "Paisible", f: "Paisible" },
  { m: "Robuste", f: "Robuste" },
  { m: "Serein", f: "Sereine" },
  { m: "Têtu", f: "Têtue" },
  { m: "Vif", f: "Vive" },
  { m: "Zen", f: "Zen" },
  { m: "Attentif", f: "Attentive" },
  { m: "Créatif", f: "Créative" },
  { m: "Inventif", f: "Inventive" },
  { m: "Sportif", f: "Sportive" },
  { m: "Doré", f: "Dorée" },
  { m: "Argenté", f: "Argentée" },
  { m: "Bleu", f: "Bleue" },
  { m: "Vert", f: "Verte" },
  { m: "Violet", f: "Violette" },
  { m: "Orange", f: "Orange" },
  { m: "Rose", f: "Rose" },
  { m: "Écarlate", f: "Écarlate" },
  { m: "Turquoise", f: "Turquoise" },
  { m: "Pourpre", f: "Pourpre" },
  { m: "Étoilé", f: "Étoilée" },
  { m: "Tacheté", f: "Tachetée" },
  { m: "Rayé", f: "Rayée" },
  { m: "Moucheté", f: "Mouchetée" },
  { m: "Câlin", f: "Câline" },
  { m: "Dynamique", f: "Dynamique" },
  { m: "Énergique", f: "Énergique" },
  { m: "Fantastique", f: "Fantastique" },
  { m: "Héroïque", f: "Héroïque" },
  { m: "Pacifique", f: "Pacifique" },
  { m: "Poétique", f: "Poétique" },
  { m: "Pratique", f: "Pratique" },
  { m: "Sympathique", f: "Sympathique" },
  { m: "Cosmique", f: "Cosmique" },
  { m: "Électrique", f: "Électrique" },
  { m: "Polaire", f: "Polaire" },
  { m: "Solaire", f: "Solaire" },
  { m: "Lunaire", f: "Lunaire" },
  { m: "Tropical", f: "Tropicale" },
  { m: "Royal", f: "Royale" },
  { m: "Musical", f: "Musicale" },
  { m: "Génial", f: "Géniale" },
  { m: "Amical", f: "Amicale" },
  { m: "Agité", f: "Agitée" },
  { m: "Appliqué", f: "Appliquée" },
  { m: "Décidé", f: "Décidée" },
  { m: "Inspiré", f: "Inspirée" },
  { m: "Réfléchi", f: "Réfléchie" },
  { m: "Ravi", f: "Ravie" },
  { m: "Endormi", f: "Endormie" },
  { m: "Pressé", f: "Pressée" },
  { m: "Masqué", f: "Masquée" },
  { m: "Ailé", f: "Ailée" },
  { m: "Futé", f: "Futée" },
  { m: "Enjoué", f: "Enjouée" },
  { m: "Farceur", f: "Farceuse" },
  { m: "Chanteur", f: "Chanteuse" },
  { m: "Danseur", f: "Danseuse" },
  { m: "Voyageur", f: "Voyageuse" },
  { m: "Explorateur", f: "Exploratrice" },
  { m: "Observateur", f: "Observatrice" },
  { m: "Admirable", f: "Admirable" },
  { m: "Adorable", f: "Adorable" },
];
