# Rapport Telegram quotidien — mise en place

Durée : environ 3 minutes. Tu n'auras **jamais** à coller le jeton dans le chat.

## 1. Créer le bot
1. Ouvre Telegram (téléphone ou ordinateur).
2. Recherche **@BotFather** (badge bleu officiel) et ouvre la conversation.
3. Envoie `/newbot`.
4. Donne un nom, par ex. `Rappel Alertes Rapport`.
5. Donne un identifiant finissant par `bot`, par ex. `rappel_alertes_carole_bot`.
6. BotFather affiche un **jeton** (du type `123456:ABC…`). Ne le copie pas dans le chat.

## 2. Transmettre le jeton en sécurité
Mogul t'enverra un **formulaire sécurisé** : colle le jeton uniquement dans ce formulaire. Il sera enregistré dans `.env.local` (fichier non publié sur GitHub) et, pour l'envoi automatique depuis GitHub, dans un *secret* GitHub Actions.

## 3. Trouver ton identifiant de conversation (chat id)
1. Dans Telegram, ouvre ton nouveau bot et appuie sur **Démarrer**, puis envoie « bonjour ».
2. Mogul lance : `node scripts/telegram-report.mjs --get-chat-id` — l'identifiant s'affiche (ce n'est pas un secret).

## 4. Configuration (fait par Mogul)
- `.env.local` à la racine du projet (modèle : `.env.example`) :
  ```
  TELEGRAM_BOT_TOKEN=...
  TELEGRAM_CHAT_ID=...
  ```
- Test sans envoi : `node scripts/telegram-report.mjs --dry-run`
- Envoi réel : `node scripts/telegram-report.mjs`
- Planification : chaque jour à 9 h (Europe/Madrid).

## Suspendre le rapport
Dans Telegram, bloque le bot ou demande à Mogul de désactiver la tâche. Pour révoquer le jeton : @BotFather → `/revoke`.
