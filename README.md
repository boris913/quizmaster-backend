# Kwizora Backend

Backend NestJS pour l'application de quiz interactif en temps réel.

## Stack

- **NestJS** — Framework Node.js
- **Socket.io** — WebSockets temps réel
- **Supabase** (PostgreSQL) — Base de données
- **JWT** — Authentification

---

## Installation

```bash
npm install
cp .env.example .env
# Remplir les variables dans .env
```

## Démarrage

```bash
# Développement
npm run start:dev

# Production
npm run build
npm run start:prod
```

---

## Configuration Supabase

1. Créer un projet sur [supabase.com](https://supabase.com)
2. Aller dans **SQL Editor** et exécuter, dans l'ordre, les fichiers du dossier
   [`migrations/`](migrations/README.md) (en commençant par `000_initial_schema.sql`)
3. Copier `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` depuis **Settings → API**

### Migrations

Toute évolution du schéma se fait par un **nouveau fichier** `migrations/NNN_description.sql`
(idempotent, jamais d'édition d'une migration existante). `supabase-schema.sql` reste le
schéma de référence initial. Convention complète : [`migrations/README.md`](migrations/README.md).

---

## Tests et qualité

```bash
npm test             # tests unitaires (Jest, fichiers src/**/*.spec.ts)
npm run test:cov     # avec couverture (dossier coverage/)
npm run lint:check   # ESLint sans correction automatique (utilisé par la CI)
npm run lint         # ESLint avec --fix
npm run build        # compilation (exclut les *.spec.ts et src/test-utils)
```

Les services se testent sans base réelle grâce au mock chaînable
`src/test-utils/supabase.mock.ts` :

```typescript
const supabase = createSupabaseMock();
supabase.mockResponse("participants", { data: { id: "p1", score: 10 } });

const moduleRef = await Test.createTestingModule({
  providers: [
    ParticipantService,
    { provide: SUPABASE_CLIENT, useValue: supabase.client },
  ],
}).compile();
```

Chaque `from(table)` consomme la prochaine réponse enregistrée pour cette table (FIFO) ;
les appels sont consultables via `supabase.queriesFor(table)`. Exemple complet :
`src/participant/participant.service.spec.ts`.

### Intégration continue

`.github/workflows/ci.yml` s'exécute sur chaque pull request et sur chaque push sur `main`
(Node 20) : `npm ci`, `npm run lint:check`, `npm test`, `npm run build`. Une PR n'est
mergeable que si ces étapes passent.

---

## Architecture

```
src/
├── main.ts                        # Point d'entrée
├── app.module.ts                  # Module racine
├── database/
│   └── database.module.ts         # Client Supabase global
├── auth/
│   ├── auth.controller.ts         # POST /api/auth/register|login, GET /api/auth/me
│   ├── auth.service.ts
│   ├── auth.module.ts
│   └── dto/auth.dto.ts
├── quiz/
│   ├── quiz.controller.ts         # CRUD quiz + questions
│   ├── quiz.service.ts
│   ├── quiz.module.ts
│   └── dto/quiz.dto.ts
├── session/
│   ├── session.controller.ts      # Créer/rejoindre session
│   ├── session.service.ts
│   ├── session.module.ts
│   └── dto/session.dto.ts
├── participant/
│   ├── participant.service.ts     # Scoring, réponses, timeout
│   └── participant.module.ts
├── gateway/
│   ├── quiz.gateway.ts            # WebSocket (cœur temps réel)
│   └── gateway.module.ts
├── ai/                            # Génération de quiz par IA (issue #11)
│   ├── ai.controller.ts           # POST /api/quizzes/generate, GET …/generate/quota
│   ├── ai.service.ts              # Extraction, appel Claude, validation, erreurs
│   ├── ai-quota.service.ts        # Quota mensuel (table ai_generations)
│   ├── ai.prompt.ts               # Prompt système + schéma de sortie JSON
│   ├── generated-questions.ts     # Validation par CreateQuestionDto
│   └── pdf-text.ts                # Signature %PDF + extraction (unpdf)
├── common/
│   ├── types/index.ts             # Interfaces TypeScript
│   ├── utils/scoring.util.ts      # Calcul points, classement
│   ├── guards/
│   │   ├── jwt-auth.guard.ts      # Guard HTTP
│   │   └── ws-jwt.guard.ts        # Guard WebSocket
│   └── decorators/
│       ├── public.decorator.ts
│       └── current-user.decorator.ts
└── test-utils/
    └── supabase.mock.ts           # Mock chaînable du client Supabase (tests)
```

---

## API REST

### Authentification

| Méthode | Route | Auth | Description |
|---------|-------|------|-------------|
| POST | `/api/auth/register` | Public | Inscription créateur |
| POST | `/api/auth/login` | Public | Connexion |
| GET | `/api/auth/me` | JWT | Profil connecté |

### Quiz

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/quizzes` | Mes quiz |
| POST | `/api/quizzes` | Créer un quiz |
| GET | `/api/quizzes/:id` | Détail + questions |
| PATCH | `/api/quizzes/:id` | Modifier |
| DELETE | `/api/quizzes/:id` | Supprimer |
| POST | `/api/quizzes/:id/questions` | Ajouter des questions (`{ questions: [...] }`, validé par type) |
| POST | `/api/quizzes/:id/questions/image-upload-url` | URL signée d'upload d'une image (issue #7) |
| DELETE | `/api/quizzes/:id/questions/:qId` | Supprimer une question |
| POST | `/api/quizzes/:id/questions/reorder` | Réordonner |
| POST | `/api/quizzes/:id/import` | Import Markdown (JSON) ; `?format=markdown\|csv\|xlsx\|kahoot[&dryRun=true]` + fichier multipart `file` (issue #12) |
| GET | `/api/quizzes/import-template.csv` | Modèle CSV d'import (public) |
| POST | `/api/quizzes/:id/duplicate` | Dupliquer un quiz (questions, ordre, images copiées) |
| POST | `/api/quizzes/:id/share` | Créer / régénérer le lien de partage (`{ share_token }`) |
| DELETE | `/api/quizzes/:id/share` | Révoquer le lien de partage |
| GET | `/api/quizzes/shared/:token` | Aperçu public d'un quiz partagé (sans réponses ni explications) |
| POST | `/api/quizzes/shared/:token/copy` | Copier un quiz partagé dans son compte |
| POST | `/api/quizzes/generate` | Brouillon de questions généré par IA depuis un texte ou un PDF (issue #11) |
| GET | `/api/quizzes/generate/quota` | Quota mensuel de génération IA de l'utilisateur |

### Types de question et images (issue #7)

| Type | `options` | `correct_answers` | Réponse du joueur (`answers`) | Correction |
|------|-----------|-------------------|-------------------------------|------------|
| `single` | 2 à 4, ids A-D | 1 id | `["B"]` | égalité |
| `multiple` | 2 à 4, ids A-D | ≥ 1 id | `["A","C"]` | même ensemble (ordre indifférent) |
| `true_false` | absentes ou `true`/`false` (stockées : Vrai/Faux) | `["true"]` ou `["false"]` | `["true"]` | égalité |
| `ordering` | 3 à 6, ids A-F | tous les ids, dans l'ordre attendu | tous les ids dans l'ordre choisi | séquence exacte (aucun tri) |
| `short_answer` | absentes / `[]` | 1 à 20 variantes (≤ 100 car.) | `["texte"]` (≤ 200 car.) | comparaison normalisée (casse, accents, espaces, ponctuation finale) |
| `poll` | 2 à 6, ids A-F | `[]` | `["A"]` | jamais juste, 0 point, exclu des précisions |

- `ordering` : à l'enregistrement, les ids sont réattribués au hasard (les
  lettres ne trahissent pas l'ordre) ; l'éditeur doit afficher les éléments
  dans l'ordre de `correct_answers`. Les joueurs reçoivent les options
  mélangées, jamais dans l'ordre attendu.
- `image_url` (facultatif, http(s), ≤ 2048 car.) : en pratique la
  `public_url` renvoyée par `POST /api/quizzes/:id/questions/image-upload-url`
  (corps `{ content_type: "image/png"|"image/jpeg"|"image/webp"|"image/gif", size }`,
  2 Mo au plus). Configuration du bucket : `migrations/README.md`.

### Génération de quiz par IA (issue #11)

`POST /api/quizzes/generate` (JWT) génère un **brouillon** de questions à
partir d'un cours. **Rien n'est enregistré** (hors compteur de quota) :
l'enseignant relit le brouillon puis l'enregistre via `POST /api/quizzes` ou
`POST /api/quizzes/:id/questions`.

Requête `multipart/form-data` :

| Champ | Obligatoire | Description |
|-------|-------------|-------------|
| `text` | `text` **ou** `file` | Texte du cours (200 000 caractères au plus) |
| `file` | `text` **ou** `file` | PDF (`application/pdf`, signature `%PDF`, 10 Mo au plus) ; texte extrait côté serveur |
| `level` | oui | Niveau de la classe, ex. `4e` (50 caractères au plus) |
| `count` | oui | Nombre de questions, entier de 1 à 30 |
| `types` | non | Types souhaités : champ répété (`types=single&types=true_false`), `types[]=…` ou liste séparée par des virgules. Valeurs : `single`, `multiple`, `true_false`, `ordering`, `short_answer` (défaut : `single`, `multiple`, `true_false`). `poll` n'est pas générable. |

- Le texte (saisi ou extrait) est normalisé puis **tronqué à 60 000
  caractères** (environ 15 000 jetons, début du document conservé) ; la
  réponse l'indique (`source.truncated`). Minimum : 200 caractères.
- Le modèle répond en sortie structurée (schéma JSON) ; chaque question est
  ensuite validée par `CreateQuestionDto`, avec les mêmes options que
  `POST /api/quizzes/:id/questions`. Les questions invalides, d'un type non
  demandé, en double ou en surplus sont écartées et comptées (`rejected`).
  `max_points` vaut 100 et `timer_seconds` 30 (modifiables avant
  enregistrement).
- Réponse 200 : `{ questions, requested, generated, rejected, source: { type,
  chars, used_chars, truncated }, model, quota: { limit, used, remaining,
  resets_at } }`.
- Erreurs : 400 (champs invalides, ni texte ni PDF, ou les deux), 401, 413
  (PDF > 10 Mo), 415 (pas un PDF : type MIME ou signature), 422 (contenu trop
  court, PDF illisible ou sans texte extractible, refus du modèle), 429
  (quota atteint, détail dans `quota`), 502 (sortie de l'IA illisible ou sans
  question valide), 503 (clé absente ou fournisseur indisponible), 504 (délai
  d'attente dépassé).
- **Quota** : `AI_MONTHLY_QUOTA` générations par enseignant et par mois
  civil UTC (3 par défaut), table `ai_generations` (migration 008). Une
  génération qui échoue ne consomme pas de quota.
- Seul le contenu pédagogique est envoyé à Anthropic (aucune donnée élève) :
  voir [docs/registre-traitement.md](docs/registre-traitement.md).

Variables d'environnement :

| Variable | Défaut | Rôle |
|----------|--------|------|
| `ANTHROPIC_API_KEY` | — | Clé de l'API Claude, côté serveur uniquement. Absente : l'application démarre, l'endpoint répond 503. |
| `AI_MODEL` | `claude-sonnet-5-5` | Modèle utilisé (`claude-haiku-5-5` pour réduire le coût) |
| `AI_MONTHLY_QUOTA` | `3` | Générations par enseignant et par mois |
| `AI_TIMEOUT_MS` | `120000` | Délai d'attente d'un appel (SDK, 1 nouvelle tentative au plus) |

### Sessions

| Méthode | Route | Auth | Description |
|---------|-------|------|-------------|
| POST | `/api/sessions` | JWT | Créer une session |
| GET | `/api/sessions` | JWT | Mes sessions |
| GET | `/api/sessions/:id` | JWT | Détail session |
| GET | `/api/sessions/:id/participants` | JWT | Liste participants |
| GET | `/api/sessions/:id/leaderboard` | JWT | Classement |
| GET | `/api/sessions/:id/results` | JWT | Résultats enrichis (créateur seulement) |
| GET | `/api/sessions/:id/results.csv` | JWT | Export CSV des résultats (créateur seulement) |
| POST | `/api/sessions/join` | Public | Rejoindre (pseudo + password) |
| DELETE | `/api/sessions/:id` | JWT | Supprimer la session et ses données (participants, réponses) |

#### Résultats d'une session

Réservés au créateur de la session : tout autre utilisateur (ou une session
inexistante) reçoit **404**, pour ne pas révéler l'existence de la session.

`GET /api/sessions/:id/results` :

```jsonc
{
  "session": {
    "id": "uuid", "quizTitle": "Géographie", "status": "finished",
    "startedAt": "2026-11-19T09:00:00.000Z", "endedAt": "2026-11-19T09:10:00.000Z",
    "participantCount": 2
  },
  "summary": { "accuracy": 0.5, "avgScore": 150, "completionRate": 0.5 },
  "perQuestion": [{
    "questionId": "uuid", "orderIndex": 0, "text": "Capitale de la France ?", "type": "single",
    "accuracy": 0.5, "avgTimeMs": 3000,
    "answerDistribution": { "A": 0, "B": 1, "C": 0, "D": 0 },
    "correctAnswers": ["B"]
  }],
  "perParticipant": [{
    "participantId": "uuid", "pseudo": "Alice", "score": 250,
    "accuracy": 1, "answered": 1, "timeouts": 0, "avgTimeMs": 3000
  }]
}
```

Règles de calcul :

- `accuracy` (0..1, 4 décimales) = réponses correctes / lignes de réponse ; un
  timeout compte comme une réponse fausse. Les questions de type `poll`
  (sondage, sans bonne réponse) sont exclues de toutes les précisions et ont
  `accuracy: 0`.
- `avgTimeMs` = moyenne des temps des réponses données (timeouts exclus),
  arrondie à la milliseconde ; 0 sans réponse.
- `answerDistribution` : nombre de participants ayant coché chaque option
  (toutes les options du quiz sont présentes, à 0 si personne ne l'a choisie ;
  en choix multiple, une réponse compte pour chaque option cochée).
- `completionRate` = réponses données / (participants × questions jouées) ;
  une question non atteinte (session arrêtée avant) n'est pas comptée.
- `avgScore` : moyenne des scores des participants (2 décimales).
- `perParticipant` est trié par score décroissant et inclut les participants
  déconnectés.
- Participants et réponses sont lus par pages de 1000 lignes (`.range()`,
  ordre stable par `id`) : la limite `max-rows` de Supabase ne tronque pas le
  rapport d'une grande classe.

`GET /api/sessions/:id/results.csv` : fichier `text/csv; charset=utf-8`
téléchargé en pièce jointe (`Content-Disposition: attachment;
filename="resultats-<quiz>-<date>.csv"`). Séparateur `;`, UTF-8 avec BOM et
virgule décimale (ouverture directe dans Excel en français). Une ligne par
participant : rang, pseudo, score, précision (%), réponses, sans réponse,
temps moyen (s), puis une colonne par question (options choisies et verdict).
Les cellules contenant `;`, `"` ou un saut de ligne sont entre guillemets
(guillemets doublés) ; celles commençant par `=`, `+`, `-` ou `@` sont
préfixées d'une apostrophe (injection de formules).

---

## WebSocket Events

### Connexion

Le client se connecte à `ws://localhost:3001`

### Émis par le client

#### Participant

```typescript
// Rejoindre une session
socket.emit('participant:join', {
  sessionId: string,
  participantId: string,
  role: 'participant'
})

// Soumettre une réponse
socket.emit('answer:submit', {
  sessionId: string,
  participantId: string,
  questionId: string,
  answers: string[],       // ex: ['A'] ou ['A', 'C']
  // timeTakenMs (optionnel) est ignoré : le temps est mesuré côté serveur
})
```

#### Créateur

```typescript
// Rejoindre le panneau de contrôle
socket.emit('creator:join', {
  sessionId: string,
  token: string            // JWT Bearer
})

// Lancer une question
socket.emit('question:start', {
  sessionId: string,
  questionIndex: number    // 0-based
})

// Terminer le quiz
socket.emit('quiz:end', {
  sessionId: string
})

// Pause / Reprise
socket.emit('session:pause', { sessionId: string })
socket.emit('session:resume', { sessionId: string })
```

### Émis par le serveur

```typescript
// Participant rejoint (broadcast à tous)
'participant:joined' → { participant, total_participants }

// Lancement d'une question (broadcast à tous)
'question:start' → {
  question: { id, text, type, options, image_url, max_points, timer_seconds, order_index },
  // ordering : options mélangées ; short_answer : options = []
  question_number: number,
  total_questions: number,
  timer_seconds: number,
  started_at: timestamp
}

// Résultat réponse (uniquement au participant)
'answer:result' → {
  is_correct: boolean,
  points_earned: number,
  time_taken_ms: number,
  correct_answers: string[],
  waiting_for_timer: true
}

// Fin de question + classement (broadcast à tous)
'question:ended' → {
  question_id: string,
  correct_answers: string[],
  leaderboard: [{
    rank, participant_id, pseudo, score, last_points, answered_current
  }]
}

// Un participant a répondu (uniquement au créateur)
'participant:answered' → {
  participant_id, answered_count, total_count
}

// Quiz terminé (broadcast à tous)
'quiz:finished' → {
  final_leaderboard: [{ rank, participant_id, pseudo, score }]
}

// Erreurs
'error' → { message: string }
```

Quand la session masque le classement (`show_leaderboard = false`), les
événements joueurs changent : voir [Classement masqué](#classement-masqué).

---

## Algorithme de Scoring

```
Si réponse FAUSSE, TIMEOUT ou arrivée après la fin du timer → 0 points

Si réponse CORRECTE dans le temps imparti :
  timeTakenMs = heure de réception serveur - sessions.question_start_time
  points = maxPoints × (1 - timeTakenMs / (timerSeconds × 1000))
  minimum = maxPoints × 0.10   (10% garanti)
  points = Math.max(points, minimum), borné à [0, maxPoints]
```

Le temps de réponse est toujours mesuré par le serveur ; aucune durée envoyée
par le client n'est prise en compte. Un timer de durée nulle ou négative donne
0 point.

**Exemple :**
- Question : 100 pts max, 30 secondes
- Réponse en 5s → `100 × (1 - 5/30) = 83 pts`
- Réponse en 25s → `100 × (1 - 25/30) = 17 pts`
- Réponse en 29s → `max(3, 10) = 10 pts` (minimum garanti)

### Modes de score

Choisi à la création de la session (`POST /api/sessions`), stocké dans
`sessions.scoring_mode` (migration `004_scoring_modes.sql`) :

| `scoringMode` | Bonne réponse dans le temps | Hors délai / fausse |
|---------------|-----------------------------|---------------------|
| `speed` (défaut) | formule ci-dessus (vitesse récompensée) | 0 |
| `accuracy` | `maxPoints`, quel que soit le temps | 0 |

```jsonc
// POST /api/sessions
{ "quiz_id": "uuid", "scoringMode": "accuracy", "showLeaderboard": false }
```

Les deux champs sont facultatifs (`speed` et `true` par défaut) ; une autre
valeur est refusée (400).

### Classement masqué

Avec `showLeaderboard: false` (`sessions.show_leaderboard`), Kwizora n'envoie
**aucun classement ni rang aux joueurs**. Le créateur (room `creator:<id>` :
panneau de contrôle et écran de projection) reçoit tous les événements
habituels, classement compris : c'est au frontend de ne pas projeter le
classement dans ce mode.

| Événement (vers les joueurs) | Différence en mode masqué |
|------------------------------|---------------------------|
| `participant:joined` | `participant` réduit à `{ id, pseudo, status }` (pas de score) |
| `answer:result` | sans `rank`, `total_participants`, `gap_to_next`, `gap_to_podium`, `on_podium` |
| `question:ended` | `{ question_id, correct_answers }` (pas de `leaderboard`) |
| `player:score` (nouveau) | `{ score, correctCount, classAccuracy }`, à chaque clôture de question |
| `quiz:finished` | `{ classAccuracy, yourScore }` uniquement |

`classAccuracy` : précision de la classe, pourcentage entier 0-100 = bonnes
réponses / réponses attendues, sur toutes les questions déjà clôturées. Une
réponse attendue = une ligne `participant_answers` (réponse donnée, ou ligne
`timeout` créée à la clôture pour chaque participant présent sans réponse).
Les participants exclus (`kicked`) sont ignorés. `correctCount` = nombre de
bonnes réponses du joueur.

---

## Import Markdown

### Format `Questions.md`

```markdown
Quiz: Titre du Quiz

Question 1 [timer:30] [points:100]
Quelle est la capitale de la France ?
A) Londres
B) Berlin
C) Paris [correct]
D) Madrid

Question 2 [timer:45] [points:150]
Quel(s) événement(s) s'est passé en 1789 ?
A) Révolution Française [correct]
B) Prise de la Bastille [correct]
C) Révolution Américaine
D) Guerre de 100 ans
```

### Types, images et réponses libres (issue #7)

```markdown
Question 3 [type: true_false] [points:50]
La Terre est plate.
= faux
> Explication : elle est (presque) sphérique.

Question 4 [type: ordering] [timer:40]
Rangez du plus petit au plus grand
![Animaux](https://exemple.org/animaux.png)
A) Souris
B) Chat
C) Cheval

Question 5 [type: short_answer]
Capitale de l'Italie ?
= Rome
= Roma

Question 6 [type: poll]
Votre saison préférée ?
A) Printemps
B) Été
```

- Marqueurs d'en-tête `[timer:N]`, `[points:N]`, `[type: T]` dans n'importe
  quel ordre ; `T` ∈ single, multiple, true_false, ordering, short_answer,
  poll. Sans marqueur, le type est déduit (`multiple` si plusieurs
  `[correct]`, sinon `single`).
- `![texte](url)` sous l'en-tête : image de la question (http(s)).
- `= texte` après l'énoncé : réponse attendue (`vrai`/`faux` pour
  true_false, une variante par ligne pour short_answer).
- ordering : options A à F listées **dans l'ordre attendu**.
- Une question typée invalide fait échouer l'import (400, numéro de question).

### Format `Reponses.md` (optionnel, si réponses séparées)

```markdown
## Question 1
C

## Question 2
A,B
```

Ne s'applique qu'aux questions à choix (single/multiple).

---

## Import CSV / XLSX / Kahoot (issue #12)

`POST /api/quizzes/:id/import?format=csv|xlsx|kahoot|markdown[&dryRun=true]`,
corps `multipart/form-data` avec un champ `file` (2 Mo au plus, 200 lignes de
données au plus). Chaque question passe la même validation que
`POST /api/quizzes/:id/questions` ; les lignes valides sont importées, les
autres listées dans `errors: [{ row, message }]` (`row` = numéro de ligne du
tableur, en-tête = 1 ; pour markdown, numéro de question). `dryRun=true` :
analyse seule, rien n'est enregistré.

Modèle : `GET /api/quizzes/import-template.csv` (séparateur `;`, UTF-8 + BOM,
un exemple par type). Colonnes : `type`, `question`, `option_a`…`option_f`,
`bonnes_reponses`, `points`, `timer`, `explication`, `image_url`. Le même
en-tête vaut pour un fichier XLSX (première feuille). CSV : séparateur `;`,
`,` ou tabulation détecté, guillemets RFC 4180, UTF-8 (BOM facultatif) ou
Windows-1252. XLSX : les formules ne sont jamais évaluées (dernière valeur
enregistrée uniquement).

`bonnes_reponses` : lettres (`B`, `A,C`) pour single/multiple ; `vrai`/`faux`
pour true_false ; ordre attendu (`C,A,B`, vide = ordre des colonnes) pour
ordering ; variantes séparées par `|` pour short_answer ; vide pour poll.

Kahoot (`format=kahoot`, `.xlsx`) : modèle tableur de questions Kahoot (en-tête
`Question - max 120 characters`, `Answer 1…4`, `Time limit (sec)`,
`Correct answer(s)`, cherché dans les 30 premières lignes). **Format à
confirmer sur un vrai export** (voir `src/quiz/importers/kahoot.importer.ts`).

---

## Déploiement

### Coolify (VPS, Docker)

Le backend est déployé sur un VPS géré par Coolify, à partir du `Dockerfile`
du dépôt (Node 20, utilisateur non-root, sonde `GET /api/health`). Supabase est
auto-hébergé sur le même serveur. Procédure complète (service Supabase,
variables d'environnement, initialisation de la base, vérifications) :
[docs/deploiement-coolify.md](docs/deploiement-coolify.md).

```bash
docker build -t kwizora-backend .
docker run --env-file .env -p 3001:3001 kwizora-backend
```
