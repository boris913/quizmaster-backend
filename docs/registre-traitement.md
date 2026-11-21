# Registre des activités de traitement — Kwizora

> **Avertissement.** Ce document est un brouillon technique rédigé à partir du
> code (issue #9). Ce n'est **pas un avis juridique**. Il doit être relu et
> validé par un **délégué à la protection des données (DPO)** avant toute
> communication présentant Kwizora comme « conforme RGPD ». Les éléments
> marqués **TODO** sont à compléter par le mainteneur.

Dernière mise à jour technique : 2026-11-20 (migration `008_ai_generations.sql`,
génération de quiz par IA, issue #11).

## 1. Responsable du traitement et contacts

| Rôle | Identité |
|---|---|
| Éditeur de Kwizora | **TODO (mainteneur)** : nom / structure, adresse |
| Contact protection des données | **TODO (mainteneur)** : adresse e-mail dédiée |
| Responsable de traitement pour l'usage en classe | **TODO (DPO)** : à qualifier. Dans le cadre scolaire, le responsable est en général l'établissement ou l'autorité académique, l'éditeur intervenant alors comme sous-traitant (art. 28 RGPD). |
| DPO compétent | **TODO** : DPO de l'académie / de l'établissement utilisateur |

## 2. Finalités

1. Permettre à un enseignant de créer des quiz et d'animer des sessions de
   quiz en direct avec sa classe.
2. Permettre aux élèves de participer à une session **sans créer de compte**,
   avec un simple pseudo.
3. Calculer les scores, le classement et les résultats de fin de session.
4. Fournir à l'enseignant des statistiques pédagogiques (taux de réussite par
   question, temps de réponse), y compris après anonymisation.
5. Assurer la sécurité et le bon fonctionnement du service (authentification,
   journaux techniques).

Aucune finalité publicitaire, aucun profilage, aucune revente de données.

## 3. Base légale

- **Élèves et usage en classe** : mission d'intérêt public de l'enseignant
  (art. 6.1.e RGPD — mission d'enseignement). **TODO (DPO)** : à confirmer.
- **Compte enseignant** : exécution des conditions d'utilisation du service
  (art. 6.1.b) ou mission d'intérêt public selon le cadre d'usage.
  **TODO (DPO)** : à confirmer.

## 4. Personnes concernées et données traitées

Les données ci-dessous sont celles effectivement stockées par le backend
(tables Supabase, voir `migrations/`).

### 4.1 Enseignants (table `users`)

| Donnée | Détail |
|---|---|
| Pseudo | identifiant de connexion choisi librement (unique) |
| Mot de passe | **jamais stocké en clair** : uniquement un hash bcrypt (coût 12) |
| Dates | création, mise à jour du compte |

Aucune adresse e-mail n'est collectée à ce jour. Le jeton de connexion (JWT,
durée `JWT_EXPIRES_IN`, 7 jours par défaut) est conservé côté navigateur.

### 4.2 Contenus pédagogiques (tables `quizzes`, `questions`)

Titres, questions, réponses proposées, bonnes réponses, minuteurs. Pas de
donnée personnelle attendue (l'enseignant ne doit pas y saisir de nom d'élève).

### 4.3 Élèves / participants (tables `participants`, `participant_answers`)

| Donnée | Détail |
|---|---|
| Pseudo | saisi librement par l'élève ; **l'interface invite à ne pas utiliser son nom complet** |
| Score, statut, date d'arrivée | calculés par le service |
| `socket_id` | identifiant technique de connexion temps réel |
| Réponses | options choisies pour chaque question |
| Temps de réponse | en millisecondes, calculé côté serveur |
| Points, justesse, date de réponse | calculés par le service |

Pas de compte élève, pas d'e-mail, pas d'adresse IP stockée en base, pas de
cookie publicitaire.

### 4.4 Sessions (table `sessions`)

Code d'accès à la session, statut, dates de début / fin, date d'anonymisation
(`anonymized_at`).

### 4.5 Génération de quiz par IA (table `ai_generations`, issue #11)

`POST /api/quizzes/generate` envoie au fournisseur d'IA (Anthropic, API
Claude) **uniquement le contenu pédagogique fourni par l'enseignant** : le
texte collé ou le texte extrait côté serveur de son PDF de cours (60 000
caractères au plus), le niveau de classe, le nombre et les types de questions
souhaités. Le PDF lui-même n'est pas transmis.

- **Aucune donnée élève** n'est envoyée (ni pseudo, ni réponse, ni score) ;
  aucun identifiant d'enseignant n'est transmis au fournisseur.
- L'enseignant ne doit pas soumettre de document contenant des données
  personnelles (copies d'élèves nominatives, etc.) : l'interface doit le
  rappeler.
- Rien n'est enregistré par Kwizora à part une ligne de quota par
  génération : `user_id`, date, nombre de questions (table `ai_generations`).
  Ni le cours ni les questions générées ne sont stockés : le brouillon est
  renvoyé à l'enseignant, qui l'enregistre lui-même via le CRUD habituel.

### 4.6 Journaux techniques

Le backend journalise des événements techniques (connexion/déconnexion de
socket, identifiants de session et de participant, pseudo de l'enseignant qui
rejoint une session, erreurs). Les adresses IP peuvent être journalisées par
l'hébergeur. **TODO (mainteneur)** : durée de conservation des journaux chez
l'hébergeur (voir [hebergement.md](hebergement.md)).

## 5. Durées de conservation

| Données | Durée | Mécanisme |
|---|---|---|
| Pseudo et `socket_id` des participants | **30 jours après la fin de la session**, puis anonymisation (`pseudo` → « Joueur N » selon le rang, `socket_id` → vide) | fonction `anonymize_old_participants(30)`, planifiée chaque jour à 03:15 UTC via `pg_cron` (migration `002_retention_purge.sql`) |
| Réponses, scores, temps de réponse | conservés sous forme anonymisée tant que la session existe (statistiques pédagogiques) | — |
| Session complète (participants + réponses) | jusqu'à suppression par l'enseignant | `DELETE /api/sessions/:id` : suppression définitive en cascade |
| Quiz et questions | jusqu'à suppression par l'enseignant | `DELETE /api/quizzes/:id` (cascade sur questions et sessions) |
| Compte enseignant | **TODO (mainteneur)** : durée d'inactivité avant suppression, procédure de suppression de compte (pas d'endpoint à ce jour) | — |
| Quota de génération IA (`ai_generations` : utilisateur, date, nombre de questions) | jusqu'à suppression du compte enseignant (cascade) | **TODO (mainteneur)** : purge possible des lignes de plus de 12 mois |
| Contenu envoyé au fournisseur d'IA | non conservé par Kwizora ; conservation chez le fournisseur selon ses conditions | **TODO (mainteneur)** : vérifier la durée de conservation de l'API Anthropic et l'option de non-conservation (ZDR) |
| Journaux techniques | **TODO (mainteneur)** : selon l'hébergeur | — |
| Sauvegardes de la base | **TODO (mainteneur)** : durée de rétention des sauvegardes Supabase selon l'offre | — |

Remarques :

- Une session restée au statut `waiting`, `active` ou `paused` (non terminée)
  n'est pas anonymisée automatiquement. **TODO** : prévoir le cas des sessions
  abandonnées.
- L'anonymisation ne s'applique pas aux sauvegardes déjà réalisées avant son
  exécution.

## 6. Destinataires

- L'enseignant créateur de la session : seul destinataire des résultats
  nominatifs (pseudos) via l'API (contrôle de propriété, 404 pour les autres).
- Les participants d'une même session voient le classement (pseudos et scores)
  pendant la session.
- Les sous-traitants techniques ci-dessous, pour l'hébergement uniquement.

## 7. Sous-traitants et transferts

| Sous-traitant | Rôle | Région / pays | Garanties |
|---|---|---|---|
| Supabase | base de données PostgreSQL | **TODO (mainteneur)** : région du projet Supabase | **TODO** : DPA Supabase, mécanisme de transfert si hors UE |
| Hébergeur du backend (NestJS) | exécution de l'API et du temps réel | **TODO (mainteneur)** | **TODO** |
| Hébergeur du frontend (Next.js) | diffusion de l'interface | **TODO (mainteneur)** | **TODO** |
| Anthropic (API Claude) | génération de brouillons de quiz à partir du cours fourni par l'enseignant (`POST /api/quizzes/generate`). **Aucune donnée élève.** | États-Unis | **TODO (mainteneur/DPO)** : DPA Anthropic (conditions commerciales de l'API), mécanisme de transfert hors UE (clauses contractuelles types / Data Privacy Framework), durée de conservation des requêtes |

Détails et procédure de vérification : [hebergement.md](hebergement.md).

## 8. Mesures de sécurité

- Accès à la base uniquement depuis le backend, avec la clé `service_role`
  (variable d'environnement, jamais renvoyée par l'API ni journalisée) ; RLS
  activée sur toutes les tables.
- Fonction d'anonymisation non exécutable par les rôles publics `anon` /
  `authenticated`.
- Mots de passe enseignants hachés (bcrypt).
- Routes enseignant protégées par JWT, avec contrôle de propriété (404 si la
  ressource appartient à un autre enseignant).
- CORS restreint aux origines du frontend (`CORS_ORIGINS`), pour l'API HTTP et
  pour Socket.io.
- Temps de réponse et score calculés côté serveur.
- Clé du fournisseur d'IA (`ANTHROPIC_API_KEY`) uniquement côté serveur,
  jamais renvoyée par l'API ni journalisée ; PDF contrôlés (type MIME,
  signature `%PDF`, 10 Mo au plus) avant extraction du texte.
- **TODO (mainteneur)** : HTTPS imposé chez l'hébergeur, gestion des accès au
  tableau de bord Supabase (MFA), procédure en cas de violation de données.

## 9. Droits des personnes

Droits d'accès, de rectification, d'effacement, de limitation et d'opposition
(art. 15 à 21 RGPD).

- **Élèves** : n'ayant pas de compte, ils ne sont identifiables que par leur
  pseudo dans une session. Les demandes passent par l'enseignant, qui peut
  supprimer la session et toutes ses données (`DELETE /api/sessions/:id`).
- **Enseignants** : suppression de leurs quiz et sessions depuis le tableau de
  bord. **TODO (mainteneur)** : procédure de suppression du compte.
- Contact : **TODO (mainteneur)**. Réclamation possible auprès de la CNIL
  (www.cnil.fr).

## 10. Analyse d'impact (AIPD)

**TODO (DPO)** : évaluer si une AIPD est nécessaire (données de mineurs,
usage scolaire).
