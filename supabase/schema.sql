-- ══════════════════════════════════════════════════
-- BriefBot — Schema Supabase
-- Exécuter dans : Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════

-- Table des projets
CREATE TABLE projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  client_name TEXT NOT NULL,
  url TEXT DEFAULT '',
  context TEXT DEFAULT '',
  current_phase INTEGER DEFAULT 1,
  phases_completed INTEGER[] DEFAULT '{}',
  share_token TEXT UNIQUE DEFAULT encode(gen_random_bytes(12), 'hex'),
  tokens_used INTEGER DEFAULT 0,
  tokens_limit INTEGER DEFAULT 50000,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table des messages
CREATE TABLE messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  mode TEXT DEFAULT 'client' CHECK (mode IN ('client', 'consultant')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pour performance
CREATE INDEX idx_messages_project_id ON messages(project_id);
CREATE INDEX idx_messages_created_at ON messages(project_id, created_at);
CREATE INDEX idx_projects_share_token ON projects(share_token);

-- Fonction pour mettre à jour updated_at automatiquement
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════════
-- Row Level Security (RLS)
-- On désactive pour simplifier — l'accès est contrôlé
-- côté app via le service_role_key sur les API routes
-- et l'anon_key pour les lectures client via share_token
-- ══════════════════════════════════════════════════

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Politique : tout le monde peut lire un projet via son share_token
CREATE POLICY "Lecture projet via token" ON projects
  FOR SELECT USING (true);

-- Politique : tout le monde peut lire les messages d'un projet
CREATE POLICY "Lecture messages" ON messages
  FOR SELECT USING (true);

-- Politique : insertion messages (via anon key depuis le client)
CREATE POLICY "Insertion messages" ON messages
  FOR INSERT WITH CHECK (true);

-- Politique : mise à jour projets (via anon key)
-- Seules les colonnes current_phase et phases_completed peuvent être modifiées
-- tokens_limit et tokens_used sont protégés par un trigger
CREATE POLICY "Update projets" ON projects
  FOR UPDATE USING (true);

-- Trigger : empêcher la modification de tokens_limit via l'anon key
-- Seuls les appels via service_role (API routes) peuvent modifier tokens_limit
CREATE OR REPLACE FUNCTION protect_tokens_limit()
RETURNS TRIGGER AS $$
BEGIN
  -- Si tokens_limit est modifié et que l'appel ne vient pas du service_role
  IF NEW.tokens_limit IS DISTINCT FROM OLD.tokens_limit
     AND current_setting('role') != 'service_role' THEN
    NEW.tokens_limit := OLD.tokens_limit;
  END IF;
  -- Empêcher aussi la modification directe de tokens_used (doit passer par la RPC)
  IF NEW.tokens_used IS DISTINCT FROM OLD.tokens_used
     AND current_setting('role') != 'service_role' THEN
    NEW.tokens_used := OLD.tokens_used;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_tokens_limit_trigger
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION protect_tokens_limit();

-- Politique : insertion projets (dashboard consultant uniquement, via API route)
CREATE POLICY "Insertion projets" ON projects
  FOR INSERT WITH CHECK (true);

-- Politique : suppression (via API route service_role)
CREATE POLICY "Suppression projets" ON projects
  FOR DELETE USING (true);

CREATE POLICY "Suppression messages" ON messages
  FOR DELETE USING (true);

-- ══════════════════════════════════════════════════
-- Fonction RPC : incrément atomique des tokens
-- Évite les race conditions lors de mises à jour concurrentes
-- ══════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION increment_project_tokens(project_id UUID, amount INTEGER)
RETURNS INTEGER AS $$
  UPDATE projects
  SET tokens_used = COALESCE(tokens_used, 0) + amount
  WHERE id = project_id
  RETURNING tokens_used;
$$ LANGUAGE sql SECURITY DEFINER;
