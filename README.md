# 🤖 BriefBot — Briefing Stratégique IA

Outil de collecte de brief par chat IA pour consultants SEO / web. L'IA guide tes clients à travers 10 phases de briefing structuré et génère un document stratégique complet (.doc).

## ✨ Fonctionnalités

- **Chat IA guidé** — 10 phases couvrant identité, offre, personas, SWOT, UX, SEO, etc.
- **Mode Client** — Ton client reçoit un lien, discute avec l'IA en autonomie
- **Mode Consultant** — Tu reprends la conversation, l'IA devient technique et analytique
- **Injection de contexte** — Colle une transcription d'appel, l'IA ne repose pas les mêmes questions
- **Export .doc** — Document stratégique complet généré par l'IA
- **Multi-projets** — Un dashboard pour gérer tous tes clients
- **Persistance** — Tout est sauvegardé, reprends à tout moment

## 🏗️ Stack technique

| Service | Rôle | Coût |
|---------|------|------|
| **Next.js** | Frontend + API routes | Gratuit |
| **Vercel** | Hébergement | Gratuit (hobby) |
| **Supabase** | Base de données PostgreSQL | Gratuit (tier gratuit) |
| **Anthropic API** | IA (Claude Sonnet) | ~0.20€ par session |

## 🚀 Setup pas-à-pas (15 minutes)

### 1. Créer un compte Supabase (gratuit)

1. Va sur [supabase.com](https://supabase.com) → **Start your project**
2. Crée un nouveau projet (choisis une région EU pour la latence)
3. Note le **mot de passe** du projet (tu en auras besoin)
4. Une fois le projet créé, va dans **Settings → API** et note :
   - `Project URL` → c'est ton `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → c'est ton `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → c'est ton `SUPABASE_SERVICE_ROLE_KEY`

### 2. Créer les tables dans Supabase

1. Dans Supabase, va dans **SQL Editor**
2. Clique sur **New Query**
3. Copie-colle tout le contenu du fichier `supabase/schema.sql`
4. Clique sur **Run** ✅

### 3. Créer une clé API Anthropic

1. Va sur [console.anthropic.com](https://console.anthropic.com)
2. Va dans **Settings → API Keys**
3. Crée une nouvelle clé → note-la (commence par `sk-ant-`)
4. Ajoute du crédit (5$ suffisent pour des dizaines de sessions)

### 4. Créer le repo GitHub

```bash
# Clone ou crée le repo
git init briefbot
cd briefbot
# Copie tous les fichiers du projet ici
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TON-USERNAME/briefbot.git
git push -u origin main
```

### 5. Déployer sur Vercel (gratuit)

1. Va sur [vercel.com](https://vercel.com) → **Add New Project**
2. Importe ton repo GitHub `briefbot`
3. Dans **Environment Variables**, ajoute :

| Variable | Valeur |
|----------|--------|
| `ANTHROPIC_API_KEY` | `sk-ant-xxx...` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJ...` |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` |
| `CONSULTANT_PASSWORD` | Le mot de passe que tu veux pour accéder au dashboard |

4. Clique **Deploy** → attend 1-2 minutes → c'est en ligne ! 🎉

### 6. (Optionnel) Domaine personnalisé

Dans Vercel → Settings → Domains → ajoute `brief.tondomaine.fr`

## 📖 Comment utiliser

### En tant que consultant (toi)

1. Va sur `ton-app.vercel.app` (ou ton domaine)
2. Entre ton mot de passe consultant
3. **Crée un projet** → remplis le nom, le client, l'URL du site, et optionnellement colle un contexte (transcription d'appel, notes...)
4. **Copie le lien client** (bouton 🔗) → envoie-le à ton client par email/WhatsApp
5. **Reprends la conversation** à tout moment en mode Consultant
6. **Exporte le brief** en .doc quand c'est prêt

### En tant que client (Jacques, etc.)

1. Reçoit un lien type `ton-app.vercel.app/p/abc123def456`
2. L'ouvre dans son navigateur
3. Discute avec BriefBot qui le guide phase par phase
4. Peut revenir plus tard, tout est sauvegardé

## 🔧 Mise à jour avec Claude Code

```bash
# Dans le terminal
cd briefbot
claude  # Lance Claude Code

# Dis à Claude ce que tu veux modifier, par exemple :
# "Ajoute une phase 11 sur les réseaux sociaux"
# "Change le system prompt pour qu'il pose plus de questions sur le SEO local"
# "Ajoute un export PDF en plus du .doc"

# Puis déploie
git add .
git commit -m "description du changement"
git push  # Vercel redéploie automatiquement
```

## 📁 Structure du projet

```
briefbot/
├── src/
│   ├── app/
│   │   ├── page.js              # Dashboard consultant (protégé par mdp)
│   │   ├── layout.js            # Layout racine
│   │   ├── globals.css           # Styles globaux + Tailwind
│   │   ├── p/[token]/page.js    # Page client (accès via lien)
│   │   └── api/
│   │       ├── chat/route.js     # Proxy Anthropic + sauvegarde messages
│   │       ├── export/route.js   # Génération du .doc
│   │       └── projects/
│   │           ├── route.js      # CRUD projets
│   │           └── phase/route.js # Changement de phase
│   ├── lib/
│   │   ├── supabase.js          # Client Supabase
│   │   └── phases.js            # Config phases + system prompt
│   └── components/
│       └── Chat.jsx             # Composant chat réutilisable
├── supabase/
│   └── schema.sql               # Schema de la base de données
├── .env.example                 # Template variables d'environnement
├── package.json
├── tailwind.config.js
└── README.md
```

## 🎛️ Personnalisation

### Modifier les phases
Édite `src/lib/phases.js` → tableau `PHASES` et le system prompt dans `buildSystemPrompt()`.

### Modifier le style du document exporté
Édite `src/app/api/export/route.js` → le CSS dans `fullDoc` et le prompt dans `buildExportPrompt()`.

### Ajouter de l'auth plus robuste
Remplace le simple mot de passe par Supabase Auth (email/mdp ou magic link).

---

Fait avec ❤️ par un consultant SEO qui en avait marre de perdre des heures en briefing.
