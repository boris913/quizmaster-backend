# QuizMaster Backend

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
2. Aller dans **SQL Editor** et exécuter le fichier `supabase-schema.sql`
3. Copier `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` depuis **Settings → API**

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
└── common/
    ├── types/index.ts             # Interfaces TypeScript
    ├── utils/scoring.util.ts      # Calcul points, classement
    ├── guards/
    │   ├── jwt-auth.guard.ts      # Guard HTTP
    │   └── ws-jwt.guard.ts        # Guard WebSocket
    └── decorators/
        ├── public.decorator.ts
        └── current-user.decorator.ts
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
| POST | `/api/quizzes/:id/questions` | Ajouter des questions |
| DELETE | `/api/quizzes/:id/questions/:qId` | Supprimer une question |
| POST | `/api/quizzes/:id/questions/reorder` | Réordonner |
| POST | `/api/quizzes/:id/import` | Import Markdown |

### Sessions

| Méthode | Route | Auth | Description |
|---------|-------|------|-------------|
| POST | `/api/sessions` | JWT | Créer une session |
| GET | `/api/sessions` | JWT | Mes sessions |
| GET | `/api/sessions/:id` | JWT | Détail session |
| GET | `/api/sessions/:id/participants` | JWT | Liste participants |
| GET | `/api/sessions/:id/leaderboard` | JWT | Classement |
| GET | `/api/sessions/:id/results` | JWT | Résultats finaux |
| POST | `/api/sessions/join` | Public | Rejoindre (pseudo + password) |
| DELETE | `/api/sessions/:id` | JWT | Terminer session |

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
  timeTakenMs: number      // temps mesuré côté client (validé serveur)
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
  question: { id, text, type, options, max_points, timer_seconds },
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

---

## Algorithme de Scoring

```
Si réponse FAUSSE ou TIMEOUT → 0 points

Si réponse CORRECTE :
  points = maxPoints × (1 - timeTakenMs / (timerSeconds × 1000))
  minimum = maxPoints × 0.10   (10% garanti)
  points = Math.max(points, minimum)
```

**Exemple :**
- Question : 100 pts max, 30 secondes
- Réponse en 5s → `100 × (1 - 5/30) = 83 pts`
- Réponse en 25s → `100 × (1 - 25/30) = 17 pts`
- Réponse en 29s → `max(3, 10) = 10 pts` (minimum garanti)

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

### Format `Reponses.md` (optionnel, si réponses séparées)

```markdown
## Question 1
C

## Question 2
A,B
```

---

## Déploiement

### Railway / Render

1. Push du repo sur GitHub
2. Connecter Railway/Render au repo
3. Variables d'environnement :
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `JWT_SECRET`
   - `FRONTEND_URL`
   - `PORT=3001`
4. Build command : `npm run build`
5. Start command : `npm run start:prod`
