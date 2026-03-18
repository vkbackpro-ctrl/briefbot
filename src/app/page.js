'use client';

import { useState, useEffect, useRef } from 'react';

// ─── Cost helpers ───
function microToUsd(micro) {
  return (micro || 0) / 1000000;
}

function formatUsd(usd) {
  if (usd >= 1) return '$' + usd.toFixed(2);
  if (usd >= 0.01) return '$' + usd.toFixed(2);
  return '$' + usd.toFixed(3);
}

function costPercentage(costMicro, budgetMicro) {
  if (!budgetMicro) return 0;
  return Math.min(Math.round(((costMicro || 0) / budgetMicro) * 100), 100);
}

function costBarColor(pct) {
  if (pct >= 90) return 'from-red-500 to-red-600';
  if (pct >= 70) return 'from-amber-500 to-orange-500';
  return 'from-emerald-500 to-green-500';
}

// ─── Cost display component ───
function CostBar({ costMicro, budgetMicro, showDetail = false, size = 'normal' }) {
  const cost = costMicro || 0;
  const budget = budgetMicro || 5000000;
  const pct = costPercentage(cost, budget);
  const isSmall = size === 'small';

  return (
    <div className={isSmall ? '' : 'space-y-1'}>
      <div className="flex items-center justify-between">
        <span className={`font-semibold ${isSmall ? 'text-[10px] text-slate-500' : 'text-xs text-slate-600'}`}>
          {formatUsd(microToUsd(cost))} / {formatUsd(microToUsd(budget))}
        </span>
        <span className={`font-bold ${isSmall ? 'text-[10px]' : 'text-xs'} ${
          pct >= 90 ? 'text-red-600' : pct >= 70 ? 'text-amber-600' : 'text-emerald-600'
        }`}>
          {pct}%
        </span>
      </div>
      <div className={`w-full bg-slate-200 rounded-full ${isSmall ? 'h-1 mt-0.5' : 'h-2'}`}>
        <div
          className={`h-full rounded-full bg-gradient-to-r ${costBarColor(pct)} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showDetail && (
        <div className="text-[10px] text-slate-400">
          Coût réel API Claude (input $3/M + output $15/M)
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [storedPw, setStoredPw] = useState('');
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState('list');
  const [selectedProject, setSelectedProject] = useState(null);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [mode, setMode] = useState('consultant');
  const [exporting, setExporting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [copied, setCopied] = useState(null);
  const [editingLimit, setEditingLimit] = useState(null);
  const [newLimitValue, setNewLimitValue] = useState('');
  const [limitReached, setLimitReached] = useState(false);

  // New project form
  const [newName, setNewName] = useState('');
  const [newClient, setNewClient] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newContext, setNewContext] = useState('');
  const [newTokensLimit, setNewTokensLimit] = useState('1000000');
  const [newBudgetUsd, setNewBudgetUsd] = useState('5');
  const TOTAL_CONTENT_PHASES = 10; // Phases 1-10 (Phase 0 = profiling, pas comptée dans la progression)

  const chatEndRef = useRef(null);

  useEffect(() => {
    const pw = sessionStorage.getItem('briefbot_pw');
    if (pw) {
      setStoredPw(pw);
      setAuthenticated(true);
      loadProjects(pw);
    }
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatLoading]);

  const login = async () => {
    if (!password.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects?pw=${encodeURIComponent(password)}`);
      if (res.ok) {
        const data = await res.json();
        sessionStorage.setItem('briefbot_pw', password);
        setStoredPw(password);
        setAuthenticated(true);
        setProjects(data.projects || []);
      } else {
        setError('Mot de passe incorrect');
      }
    } catch (e) {
      setError('Erreur de connexion');
    }
    setLoading(false);
  };

  const loadProjects = async (pw) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects?pw=${encodeURIComponent(pw || storedPw)}`);
      const data = await res.json();
      setProjects(data.projects || []);
    } catch (e) {
      setError('Erreur de chargement');
    }
    setLoading(false);
  };

  const createProject = async () => {
    if (!newName.trim() || !newClient.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          client_name: newClient.trim(),
          url: newUrl.trim(),
          context: newContext.trim(),
          tokens_limit: parseInt(newTokensLimit) || 1000000,
          budget_usd: parseFloat(newBudgetUsd) || 5,
          password: storedPw,
        }),
      });
      const data = await res.json();
      if (data.project) {
        setNewName(''); setNewClient(''); setNewUrl(''); setNewContext(''); setNewBudgetUsd('5');
        await loadProjects();
        openProject(data.project);
      }
    } catch (e) {
      setError('Erreur de création');
    }
    setLoading(false);
  };

  const deleteProject = async (id) => {
    if (!confirm('Supprimer ce projet et toutes ses données ?')) return;
    await fetch('/api/projects', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: id, password: storedPw }),
    });
    await loadProjects();
  };

  const updateBudget = async (projectId) => {
    const newBudget = parseFloat(newLimitValue);
    if (!newBudget || newBudget < 1) return;
    await fetch('/api/projects', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, budget_usd: newBudget, password: storedPw }),
    });
    setEditingLimit(null);
    setNewLimitValue('');
    await loadProjects();
    if (selectedProject?.id === projectId) {
      setSelectedProject(prev => ({ ...prev, budget_micro_usd: Math.round(newBudget * 1000000) }));
    }
  };

  const openProject = async (project) => {
    setSelectedProject(project);
    setView('chat');
    setLimitReached(false);
    const { supabase } = await import('@/lib/supabase');
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('project_id', project.id)
      .order('created_at', { ascending: true });
    setMessages(data || []);
  };

  const copyShareLink = (token) => {
    const url = `${window.location.origin}/p/${token}`;
    navigator.clipboard.writeText(url);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  };

  // ─── Chat ───
  const sendMessage = async () => {
    if (!chatInput.trim() || chatLoading || limitReached) return;
    const userMsg = { role: 'user', content: chatInput.trim(), mode, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setChatInput('');
    setChatLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selectedProject.id, message: userMsg.content, mode }),
      });
      const data = await res.json();

      if (data.limit_reached) {
        setLimitReached(true);
        setError('⚠️ Budget API atteint pour ce projet.');
        // Remove the user message we optimistically added
        setMessages(prev => prev.slice(0, -1));
        setChatLoading(false);
        return;
      }

      if (data.error) throw new Error(data.error);

      const aiMsg = { role: 'assistant', content: data.content, mode, created_at: new Date().toISOString() };
      setMessages(prev => [...prev, aiMsg]);

      // Update cost locally
      if (data.cost_usd != null) {
        setSelectedProject(prev => ({ ...prev, cost_micro_usd: Math.round(data.cost_usd * 1000000) }));
      }

      const phaseMatch = data.content.match(/✅\s*Phase\s*(\d+)/);
      if (phaseMatch) {
        const completedId = parseInt(phaseMatch[1]);
        setSelectedProject(prev => ({
          ...prev,
          phases_completed: [...new Set([...(prev.phases_completed || []), completedId])],
          current_phase: Math.min(completedId + 1, 10),
        }));
      }
    } catch (e) {
      setError('Erreur : ' + e.message);
    }
    setChatLoading(false);
  };

  const goToPhase = async (phaseId) => {
    if (chatLoading || limitReached) return;
    await fetch('/api/projects/phase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: selectedProject.id, phaseId }),
    });
    setSelectedProject(prev => ({ ...prev, current_phase: phaseId }));

    const PHASES = (await import('@/lib/phases')).PHASES;
    const phaseName = PHASES.find(p => p.id === phaseId)?.name;
    const msg = `Je souhaite maintenant travailler sur la Phase ${phaseId} — ${phaseName}.`;
    const userMsg = { role: 'user', content: msg, mode, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setChatLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selectedProject.id, message: msg, mode }),
      });
      const data = await res.json();
      if (data.limit_reached) {
        setLimitReached(true);
        setError('⚠️ Budget API atteint.');
        setMessages(prev => prev.slice(0, -1));
        setChatLoading(false);
        return;
      }
      if (data.error) throw new Error(data.error);
      setMessages(prev => [...prev, { role: 'assistant', content: data.content, mode, created_at: new Date().toISOString() }]);
      if (data.cost_usd != null) {
        setSelectedProject(prev => ({ ...prev, cost_micro_usd: Math.round(data.cost_usd * 1000000) }));
      }
    } catch (e) {
      setError('Erreur : ' + e.message);
    }
    setChatLoading(false);
  };

  const [exportProgress, setExportProgress] = useState('');
  const [exportHistory, setExportHistory] = useState([]);
  const [showExportHistory, setShowExportHistory] = useState(false);

  const loadExportHistory = async (projId) => {
    try {
      const res = await fetch(`/api/export?projectId=${projId}&pw=${encodeURIComponent(storedPw)}`);
      const data = await res.json();
      setExportHistory(data.exports || []);
    } catch { setExportHistory([]); }
  };

  const redownloadExport = async (exportId, fmt) => {
    try {
      const res = await fetch(`/api/export?exportId=${exportId}&pw=${encodeURIComponent(storedPw)}&format=${fmt}`);
      if (!res.ok) throw new Error('Erreur téléchargement');

      if (fmt === 'pdf') {
        const data = await res.json();
        const iframe = document.createElement('iframe');
        Object.assign(iframe.style, { position: 'fixed', left: '-9999px', top: '0', width: '0', height: '0', border: 'none' });
        document.body.appendChild(iframe);
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        iframeDoc.open(); iframeDoc.write(data.html); iframeDoc.close();
        await new Promise(r => { iframe.onload = r; setTimeout(r, 1000); });
        iframe.contentWindow.focus(); iframe.contentWindow.print();
        setTimeout(() => document.body.removeChild(iframe), 2000);
      } else {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Brief_${selectedProject.client_name.replace(/\s+/g, '_')}_export.doc`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e) { setError('Erreur : ' + e.message); }
  };

  const handleExport = async (format = 'doc') => {
    if (exporting || messages.length < 2) return;
    setExporting(true);
    setError(null);
    setExportProgress('');

    try {
      // ── Générer le document en 3 parties (chacune < 10s) ──
      const htmlParts = [];
      const totalParts = 3;

      for (let part = 0; part < totalParts; part++) {
        setExportProgress(`Génération ${part + 1}/${totalParts}...`);

        const res = await fetch('/api/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: selectedProject.id, password: storedPw, format, part }),
        });

        if (!res.ok) {
          let errMsg = `Erreur ${res.status}`;
          try {
            const errData = await res.json();
            errMsg = errData.error || errMsg;
          } catch {
            if (res.status === 504) errMsg = `Partie ${part + 1} a pris trop de temps. Réessayez.`;
            else errMsg = `Erreur serveur (${res.status}). Réessayez.`;
          }
          throw new Error(errMsg);
        }

        const data = await res.json();
        if (data.error) throw new Error(data.error);
        htmlParts.push(data.html);

        // Update cost display
        if (data.cost_usd != null) {
          setSelectedProject(prev => ({ ...prev, cost_micro_usd: Math.round(data.cost_usd * 1000000) }));
        }
      }

      // ── Assembler le document final ──
      setExportProgress('Sauvegarde...');
      const fullHtml = htmlParts.join('\n\n');

      // Sauvegarder dans l'historique
      await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selectedProject.id, password: storedPw, format, action: 'save', htmlContent: fullHtml }),
      }).catch(() => {}); // Silencieux si ça échoue

      const styles = `
        body { font-family: Calibri, sans-serif; color: #1a1a1a; line-height: 1.7; padding: 50px; max-width: 800px; margin: 0 auto; }
        h1 { color: #1e3a5f; font-size: 28px; border-bottom: 3px solid #e8913a; padding-bottom: 10px; margin-top: 40px; }
        h2 { color: #2c5282; font-size: 22px; margin-top: 30px; }
        h3 { color: #4a6fa5; font-size: 18px; }
        table { border-collapse: collapse; width: 100%; margin: 15px 0; }
        th, td { border: 1px solid #cbd5e0; padding: 10px 14px; text-align: left; }
        th { background-color: #edf2f7; color: #2d3748; font-weight: 600; }
        tr:nth-child(even) { background-color: #f7fafc; }
        ul, ol { padding-left: 24px; }
        li { margin-bottom: 6px; }
        blockquote { border-left: 4px solid #e8913a; padding: 12px 16px; background: #fef7ed; margin: 16px 0; font-style: italic; }`;

      const filename = `Brief_${selectedProject.client_name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}`;

      if (format === 'pdf') {
        const pdfHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${filename}</title><style>@media print{@page{margin:15mm}}${styles}</style></head><body>${fullHtml}</body></html>`;

        const iframe = document.createElement('iframe');
        Object.assign(iframe.style, { position: 'fixed', left: '-9999px', top: '0', width: '0', height: '0', border: 'none' });
        document.body.appendChild(iframe);
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        iframeDoc.open();
        iframeDoc.write(pdfHtml);
        iframeDoc.close();
        await new Promise(resolve => { iframe.onload = resolve; setTimeout(resolve, 1000); });
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(() => document.body.removeChild(iframe), 2000);
      } else {
        const docHtml = `\ufeff<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style>${styles}</style></head><body>${fullHtml}</body></html>`;
        const blob = new Blob([docHtml], { type: 'application/msword' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.doc`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setError('Erreur export : ' + e.message);
    }
    setExporting(false);
    setExportProgress('');
  };

  // Markdown
  const renderMd = (text) => {
    if (!text) return '';
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br/>');
  };

  // ─── LOGIN ───
  if (!authenticated) {
    return (
      <div className="h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-orange-50/40">
        <div className="w-full max-w-sm mx-auto px-6">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 bg-white border border-slate-200 rounded-full px-4 py-1.5 text-xs font-semibold text-slate-500 mb-4 shadow-sm">🤖 BRIEFBOT</div>
            <h1 className="text-2xl font-bold text-slate-800">Dashboard Consultant</h1>
          </div>
          {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl mb-4">{error}</div>}
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && login()} placeholder="Mot de passe consultant" className="w-full px-4 py-3 border border-slate-300 rounded-xl text-sm mb-3" autoFocus />
          <button onClick={login} disabled={loading} className="w-full py-3 bg-slate-800 text-white rounded-xl text-sm font-bold hover:bg-slate-700 transition-all">
            {loading ? 'Connexion...' : 'Accéder'}
          </button>
        </div>
      </div>
    );
  }

  // ─── NEW PROJECT ───
  if (view === 'new') {
    return (
      <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-orange-50/40 overflow-auto">
        <div className="max-w-xl mx-auto px-6 py-12">
          <button onClick={() => setView('list')} className="text-sm text-slate-500 hover:text-slate-700 mb-6">← Retour</button>
          <h1 className="text-2xl font-bold text-slate-800 mb-1">Nouveau projet</h1>
          <p className="text-slate-500 text-sm mb-8">Le reste sera collecté par l'IA pendant le briefing.</p>

          <div className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Nom du projet *</label>
              <input type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Ex: Refonte MonkeyKwest" className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Nom du client *</label>
              <input type="text" value={newClient} onChange={e => setNewClient(e.target.value)} placeholder="Ex: MonkeyKwest" className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">URL du site actuel</label>
              <input type="text" value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="Ex: https://monkeykwest.com" className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white" />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Budget API</label>
              <p className="text-xs text-slate-400 mb-2">Coût réel de l'API Claude. ~$5 = 3-4 briefings complets. Modifiable plus tard.</p>
              <div className="flex gap-2">
                {[{ value: '5', label: '$5' }, { value: '10', label: '$10' }, { value: '20', label: '$20' }].map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => setNewBudgetUsd(value)}
                    className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all ${
                      newBudgetUsd === value ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1.5">Contexte initial <span className="font-normal text-slate-400">(optionnel)</span></label>
              <p className="text-xs text-slate-400 mb-2">Transcription d'appel, notes, brief existant…</p>
              <textarea value={newContext} onChange={e => setNewContext(e.target.value)} placeholder="Collez vos notes ici..." rows={6} className="w-full px-4 py-3 border border-slate-300 rounded-xl text-sm bg-white resize-none" />
            </div>
            <button
              onClick={createProject}
              disabled={!newName.trim() || !newClient.trim() || loading}
              className={`w-full py-3 rounded-xl text-sm font-bold transition-all shadow-md ${
                newName.trim() && newClient.trim() ? 'bg-slate-800 text-white hover:bg-slate-700' : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }`}
            >
              {loading ? 'Création...' : 'Créer et démarrer →'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── CHAT ───
  if (view === 'chat' && selectedProject) {
    const PHASES = require('@/lib/phases').PHASES;
    const currentPhase = PHASES.find(p => p.id === (selectedProject.current_phase ?? 0));

    return (
      <div className="h-screen flex bg-slate-50 overflow-hidden">
        {sidebarOpen && (
          <div className="w-64 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
            <div className="p-4 border-b border-slate-100">
              <button onClick={() => { setView('list'); setSelectedProject(null); loadProjects(); }} className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1 mb-3">← Projets</button>
              <h2 className="font-bold text-slate-800 text-sm truncate">{selectedProject.name}</h2>
              <p className="text-xs text-slate-400 truncate">{selectedProject.client_name}</p>
              <button onClick={() => copyShareLink(selectedProject.share_token)} className="mt-2 text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-2 py-1 rounded-md hover:bg-amber-100 transition-all">
                {copied === selectedProject.share_token ? '✅ Copié !' : '🔗 Copier le lien client'}
              </button>
            </div>

            {/* Cost counter */}
            <div className="px-4 py-3 border-b border-slate-100">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Coût API</label>
              <div className="mt-2">
                <CostBar costMicro={selectedProject.cost_micro_usd} budgetMicro={selectedProject.budget_micro_usd} showDetail={true} />
              </div>
              <button
                onClick={() => { setEditingLimit(selectedProject.id); setNewLimitValue(String(microToUsd(selectedProject.budget_micro_usd || 5000000))); }}
                className="mt-2 text-[10px] text-blue-600 hover:underline"
              >
                Modifier le budget
              </button>
              {editingLimit === selectedProject.id && (
                <div className="mt-2 flex gap-1.5 animate-fade-in">
                  <div className="flex-1 flex items-center gap-1">
                    <span className="text-xs text-slate-500">$</span>
                    <input
                      type="number"
                      step="0.5"
                      min="1"
                      value={newLimitValue}
                      onChange={e => setNewLimitValue(e.target.value)}
                      className="flex-1 px-2 py-1 border border-slate-300 rounded-md text-xs"
                      placeholder="Ex: 10"
                    />
                  </div>
                  <button onClick={() => updateBudget(selectedProject.id)} className="px-2 py-1 bg-blue-600 text-white rounded-md text-xs font-semibold">OK</button>
                  <button onClick={() => setEditingLimit(null)} className="px-2 py-1 text-slate-500 text-xs">✕</button>
                </div>
              )}
            </div>

            {/* Mode toggle */}
            <div className="px-4 py-3 border-b border-slate-100">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Mode</label>
              <div className="flex mt-1.5 bg-slate-100 rounded-lg p-0.5">
                <button onClick={() => setMode('client')} className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${mode === 'client' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>👤 Client</button>
                <button onClick={() => setMode('consultant')} className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${mode === 'consultant' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>🔧 Consultant</button>
              </div>
            </div>

            {/* Phases */}
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">Phases</label>
              {PHASES.map(phase => (
                <button
                  key={phase.id}
                  onClick={() => goToPhase(phase.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg transition-all flex items-center gap-2 ${
                    (selectedProject.current_phase ?? 0) === phase.id
                      ? 'bg-amber-50 border border-amber-300'
                      : (selectedProject.phases_completed || []).includes(phase.id)
                      ? 'bg-emerald-50/60 border border-emerald-200 hover:bg-emerald-50'
                      : 'bg-white/60 border border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <span className="text-base">{(selectedProject.phases_completed || []).includes(phase.id) ? '✅' : phase.icon}</span>
                  <div className="min-w-0">
                    <div className={`text-xs font-semibold truncate ${
                      (selectedProject.current_phase ?? 0) === phase.id ? 'text-amber-800' : (selectedProject.phases_completed || []).includes(phase.id) ? 'text-emerald-700' : 'text-slate-700'
                    }`}>{phase.name}</div>
                  </div>
                </button>
              ))}
            </div>

            <div className="p-3 border-t border-slate-100 space-y-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Exporter le brief</label>
              {exportProgress && (
                <div className="text-[10px] text-amber-600 font-semibold animate-pulse">{exportProgress}</div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => handleExport('doc')}
                  disabled={exporting || messages.length < 2}
                  className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
                    exporting ? 'bg-amber-100 text-amber-600'
                    : messages.length < 2 ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-gradient-to-r from-amber-500 to-orange-500 text-white hover:from-amber-600 hover:to-orange-600 shadow-md'
                  }`}
                >
                  {exporting ? exportProgress || '⏳...' : '.doc'}
                </button>
                <button
                  onClick={() => handleExport('pdf')}
                  disabled={exporting || messages.length < 2}
                  className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-all ${
                    exporting ? 'bg-amber-100 text-amber-600'
                    : messages.length < 2 ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                    : 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white hover:from-blue-600 hover:to-indigo-600 shadow-md'
                  }`}
                >
                  {exporting ? exportProgress || '⏳...' : '.pdf'}
                </button>
              </div>
              <button
                onClick={() => { loadExportHistory(selectedProject.id); setShowExportHistory(!showExportHistory); }}
                className="text-[10px] text-slate-500 hover:text-slate-700 mt-1 underline"
              >
                {showExportHistory ? 'Masquer l\'historique' : 'Historique des exports'}
              </button>
              {showExportHistory && (
                <div className="mt-2 space-y-1.5 max-h-40 overflow-y-auto">
                  {exportHistory.length === 0 ? (
                    <div className="text-[10px] text-slate-400 italic">Aucun export</div>
                  ) : exportHistory.map(exp => (
                    <div key={exp.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-2.5 py-1.5 border border-slate-200">
                      <div className="min-w-0">
                        <div className="text-[10px] font-semibold text-slate-600">
                          {new Date(exp.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </div>
                        <div className="text-[9px] text-slate-400">.{exp.format}</div>
                      </div>
                      <div className="flex gap-1">
                        <button onClick={() => redownloadExport(exp.id, 'doc')} className="text-[9px] bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded hover:bg-amber-100">.doc</button>
                        <button onClick={() => redownloadExport(exp.id, 'pdf')} className="text-[9px] bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded hover:bg-blue-100">.pdf</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-14 bg-white border-b border-slate-200 flex items-center px-4 gap-3 flex-shrink-0">
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600 hover:bg-slate-200 text-sm">
              {sidebarOpen ? '◀' : '▶'}
            </button>
            <div className="flex-1">
              <span className="text-sm font-semibold text-slate-800">{selectedProject.client_name}</span>
              <span className="text-xs text-slate-400 ml-2">Phase {selectedProject.current_phase ?? 0} — {currentPhase?.name}</span>
            </div>
            <div className="flex items-center gap-3">
              {/* Mini cost bar in top bar */}
              <div className="w-24 hidden sm:block">
                <CostBar costMicro={selectedProject.cost_micro_usd} budgetMicro={selectedProject.budget_micro_usd} size="small" />
              </div>
              <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${mode === 'consultant' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
                {mode === 'consultant' ? '🔧 Consultant' : '👤 Client'}
              </div>
            </div>
          </div>

          {error && (
            <div className={`border-b text-xs px-4 py-2 flex items-center justify-between ${
              limitReached ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-red-50 border-red-200 text-red-700'
            }`}>
              <span>{error}</span>
              <button onClick={() => { setError(null); setLimitReached(false); }} className="font-bold ml-3">✕</button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-6 py-6">
            {messages.map((m, i) => (
              <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''} mb-5 animate-fade-in`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-sm shadow-sm ${
                  m.role === 'user'
                    ? m.mode === 'consultant' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-white'
                    : 'bg-gradient-to-br from-amber-400 to-orange-500 text-white'
                }`}>
                  {m.role === 'user' ? (m.mode === 'consultant' ? '🔧' : '👤') : '🤖'}
                </div>
                <div className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-sm ${
                  m.role === 'user'
                    ? m.mode === 'consultant' ? 'bg-blue-600 text-white rounded-tr-md' : 'bg-slate-700 text-white rounded-tr-md'
                    : 'bg-white border border-slate-200 text-slate-800 rounded-tl-md'
                }`}>
                  <div className="text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
                  <div className={`text-[10px] mt-1.5 ${m.role === 'user' ? 'text-white/50' : 'text-slate-400'}`}>
                    {m.created_at && new Date(m.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                    {m.mode === 'consultant' && m.role === 'user' ? ' · Consultant' : ''}
                  </div>
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex gap-3 mb-5 animate-fade-in">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-sm">🤖</div>
                <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-md px-5 py-3.5 shadow-sm">
                  <div className="flex gap-1.5">
                    <span className="typing-dot w-2 h-2 rounded-full bg-amber-500 inline-block" />
                    <span className="typing-dot w-2 h-2 rounded-full bg-amber-500 inline-block" />
                    <span className="typing-dot w-2 h-2 rounded-full bg-amber-500 inline-block" />
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="border-t border-slate-200 bg-white p-4">
            {limitReached ? (
              <div className="text-center py-3 text-sm text-amber-700 bg-amber-50 rounded-xl border border-amber-200">
                ⚠️ Budget atteint ({formatUsd(microToUsd(selectedProject.cost_micro_usd))}). <button onClick={() => { setEditingLimit(selectedProject.id); setNewLimitValue(String(microToUsd(selectedProject.budget_micro_usd || 5000000) * 2)); setSidebarOpen(true); }} className="font-bold underline">Augmenter le budget</button>
              </div>
            ) : (
              <div className="flex gap-3 items-end max-w-4xl mx-auto">
                <textarea
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                  placeholder={mode === 'consultant' ? 'Question ou analyse...' : 'Répondez à BriefBot...'}
                  rows={1}
                  className="flex-1 px-4 py-3 border border-slate-300 rounded-xl text-sm resize-none bg-slate-50 focus:bg-white transition-colors"
                  style={{ minHeight: '44px', maxHeight: '120px' }}
                  onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }}
                />
                <button
                  onClick={sendMessage}
                  disabled={!chatInput.trim() || chatLoading}
                  className={`px-5 py-3 rounded-xl text-sm font-bold transition-all ${
                    chatInput.trim() && !chatLoading ? 'bg-slate-800 text-white hover:bg-slate-700 shadow-md' : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  Envoyer
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── PROJECT LIST ───
  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-orange-50/40 overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-white border border-slate-200 rounded-full px-4 py-1.5 text-xs font-semibold text-slate-500 mb-4 shadow-sm">🤖 BRIEFBOT — Dashboard</div>
          <h1 className="text-3xl font-bold text-slate-800 mb-2">Mes projets</h1>
          <p className="text-slate-500 text-sm">Briefings stratégiques en cours</p>
        </div>

        <div className="flex gap-3 mb-8 justify-center">
          <button onClick={() => setView('new')} className="bg-slate-800 text-white px-5 py-2.5 rounded-xl text-sm font-semibold hover:bg-slate-700 transition-all shadow-md">+ Nouveau projet</button>
          <button onClick={() => loadProjects()} className="bg-white text-slate-700 border border-slate-300 px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-50">🔄 Actualiser</button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl mb-6">{error} <button onClick={() => setError(null)} className="font-bold ml-3">✕</button></div>
        )}

        {loading ? (
          <div className="text-center py-16 text-slate-400">Chargement...</div>
        ) : projects.length === 0 ? (
          <div className="text-center py-16 text-slate-400">
            <div className="text-5xl mb-4">📋</div>
            <p className="font-medium">Aucun projet</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {projects.map(p => (
              <div
                key={p.id}
                className="bg-white rounded-xl border border-slate-200 p-4 hover:shadow-md transition-all group cursor-pointer"
                onClick={() => openProject(p)}
              >
                <div className="flex items-center gap-4">
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white font-bold text-lg shadow-sm flex-shrink-0">
                    {p.client_name?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-slate-800 truncate">{p.name}</div>
                    <div className="text-xs text-slate-400">
                      {p.client_name} · Phase {p.current_phase ?? 0}/10
                    </div>
                  </div>
                  <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                    <button onClick={() => copyShareLink(p.share_token)} className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1.5 rounded-lg hover:bg-amber-100">
                      {copied === p.share_token ? '✅' : '🔗'}
                    </button>
                    <button onClick={() => deleteProject(p.id)} className="text-xs bg-red-50 text-red-500 px-2.5 py-1.5 rounded-lg hover:bg-red-100">🗑</button>
                  </div>
                </div>
                {/* Cost bar on project card */}
                <div className="mt-3 px-1">
                  <CostBar costMicro={p.cost_micro_usd} budgetMicro={p.budget_micro_usd} size="small" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
