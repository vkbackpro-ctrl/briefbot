'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { PHASES } from '@/lib/phases';

// Markdown rendering
function renderMd(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
}

export default function ClientPage() {
  const params = useParams();
  const token = params.token;

  const [project, setProject] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const chatEndRef = useRef(null);

  // Load project by token
  useEffect(() => {
    loadProject();
  }, [token]);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatLoading]);

  const loadProject = async () => {
    setLoading(true);
    try {
      const { data: proj } = await supabase
        .from('projects')
        .select('*')
        .eq('share_token', token)
        .single();

      if (!proj) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setProject(proj);

      const { data: msgs } = await supabase
        .from('messages')
        .select('*')
        .eq('project_id', proj.id)
        .order('created_at', { ascending: true });

      setMessages(msgs || []);

      // If no messages, send initial
      if (!msgs || msgs.length === 0) {
        setChatLoading(true);
        try {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId: proj.id,
              message: `Bonjour ! Je suis prêt à commencer le briefing pour ${proj.client_name}.`,
              mode: 'client',
            }),
          });
          const data = await res.json();
          if (data.content) {
            // Reload messages from DB
            const { data: updatedMsgs } = await supabase
              .from('messages')
              .select('*')
              .eq('project_id', proj.id)
              .order('created_at', { ascending: true });
            setMessages(updatedMsgs || []);
          }
        } catch (e) {
          setError('Erreur de connexion');
        }
        setChatLoading(false);
      }
    } catch (e) {
      setNotFound(true);
    }
    setLoading(false);
  };

  const sendMessage = async () => {
    if (!input.trim() || chatLoading) return;
    const userMsg = { role: 'user', content: input.trim(), mode: 'client', created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setChatLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          message: userMsg.content,
          mode: 'client',
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const aiMsg = { role: 'assistant', content: data.content, mode: 'client', created_at: new Date().toISOString() };
      setMessages(prev => [...prev, aiMsg]);

      // Update phase
      const phaseMatch = data.content.match(/✅\s*Phase\s*(\d+)/);
      if (phaseMatch) {
        const completedId = parseInt(phaseMatch[1]);
        setProject(prev => ({
          ...prev,
          phases_completed: [...new Set([...(prev.phases_completed || []), completedId])],
          current_phase: Math.min(completedId + 1, 11),
        }));
      }
    } catch (e) {
      setError('Erreur : ' + e.message);
    }
    setChatLoading(false);
  };

  const goToPhase = async (phaseId) => {
    if (chatLoading) return;
    await fetch('/api/projects/phase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, phaseId }),
    });
    setProject(prev => ({ ...prev, current_phase: phaseId }));

    const phaseName = PHASES.find(p => p.id === phaseId)?.name;
    const msg = `Je souhaite maintenant travailler sur la Phase ${phaseId} — ${phaseName}.`;
    const userMsg = { role: 'user', content: msg, mode: 'client', created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setChatLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, message: msg, mode: 'client' }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setMessages(prev => [...prev, { role: 'assistant', content: data.content, mode: 'client', created_at: new Date().toISOString() }]);
    } catch (e) {
      setError('Erreur : ' + e.message);
    }
    setChatLoading(false);
  };

  // ─── Loading / Not found ───
  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-orange-50">
        <div className="text-center">
          <div className="text-4xl mb-3">🤖</div>
          <div className="text-slate-600 font-medium">Chargement du briefing...</div>
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-orange-50">
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4">🔍</div>
          <h1 className="text-xl font-bold text-slate-800 mb-2">Projet introuvable</h1>
          <p className="text-slate-500 text-sm">Ce lien de briefing n'existe pas ou a été supprimé. Vérifiez le lien avec votre consultant.</p>
        </div>
      </div>
    );
  }

  // ─── Chat ───
  const currentPhase = PHASES.find(p => p.id === (project.current_phase ?? 0));

  return (
    <div className="h-screen flex bg-slate-50 overflow-hidden">
      {/* Sidebar */}
      {sidebarOpen && (
        <div className="w-64 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
          <div className="p-4 border-b border-slate-100">
            <div className="inline-flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-full px-3 py-1 text-[10px] font-semibold text-amber-700 mb-3">
              🤖 BRIEFBOT
            </div>
            <h2 className="font-bold text-slate-800 text-sm truncate">{project.name}</h2>
            <p className="text-xs text-slate-400 mt-0.5">Briefing pour {project.client_name}</p>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">Progression</label>
            {PHASES.map(phase => (
              <button
                key={phase.id}
                onClick={() => goToPhase(phase.id)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-all flex items-center gap-2 ${
                  (project.current_phase ?? 0) === phase.id
                    ? 'bg-amber-50 border border-amber-300'
                    : (project.phases_completed || []).includes(phase.id)
                    ? 'bg-emerald-50/60 border border-emerald-200 hover:bg-emerald-50'
                    : 'bg-white/60 border border-slate-200 hover:bg-slate-50'
                }`}
              >
                <span className="text-base">{(project.phases_completed || []).includes(phase.id) ? '✅' : phase.icon}</span>
                <div className="min-w-0">
                  <div className={`text-xs font-semibold truncate ${
                    (project.current_phase ?? 0) === phase.id ? 'text-amber-800'
                    : (project.phases_completed || []).includes(phase.id) ? 'text-emerald-700' : 'text-slate-700'
                  }`}>{phase.name}</div>
                  <div className="text-[10px] text-slate-400 truncate">{phase.desc}</div>
                </div>
              </button>
            ))}
          </div>

          <div className="p-4 border-t border-slate-100">
            <div className="text-center text-[10px] text-slate-400">
              {(project.phases_completed || []).filter(id => id > 0).length}/11 phases complétées
            </div>
            <div className="w-full bg-slate-200 rounded-full h-1.5 mt-2">
              <div className="bg-gradient-to-r from-amber-500 to-orange-500 h-1.5 rounded-full transition-all" style={{ width: `${((project.phases_completed || []).filter(id => id > 0).length / 11) * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="h-14 bg-white border-b border-slate-200 flex items-center px-4 gap-3 flex-shrink-0">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600 hover:bg-slate-200 text-sm">
            {sidebarOpen ? '◀' : '▶'}
          </button>
          <div className="flex-1">
            <span className="text-sm font-semibold text-slate-800">{project.client_name}</span>
            <span className="text-xs text-slate-400 ml-2">Phase {project.current_phase ?? 0} — {currentPhase?.name}</span>
          </div>
          <div className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700">
            👤 Briefing en cours
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border-b border-red-200 text-red-700 text-xs px-4 py-2">
            {error} <button onClick={() => setError(null)} className="font-bold ml-3">✕</button>
          </div>
        )}

        {/* Messages */}
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
                  ? 'bg-slate-700 text-white rounded-tr-md'
                  : 'bg-white border border-slate-200 text-slate-800 rounded-tl-md'
              }`}>
                <div className="text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />
                {m.created_at && (
                  <div className={`text-[10px] mt-1.5 ${m.role === 'user' ? 'text-white/50' : 'text-slate-400'}`}>
                    {new Date(m.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
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

        {/* Input */}
        <div className="border-t border-slate-200 bg-white p-4">
          <div className="flex gap-3 items-end max-w-4xl mx-auto">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              placeholder="Répondez aux questions de BriefBot..."
              rows={1}
              className="flex-1 px-4 py-3 border border-slate-300 rounded-xl text-sm resize-none bg-slate-50 focus:bg-white transition-colors"
              style={{ minHeight: '44px', maxHeight: '120px' }}
              onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }}
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || chatLoading}
              className={`px-5 py-3 rounded-xl text-sm font-bold transition-all ${
                input.trim() && !chatLoading ? 'bg-slate-800 text-white hover:bg-slate-700 shadow-md' : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }`}
            >
              Envoyer
            </button>
          </div>
          <div className="text-center mt-2 text-[10px] text-slate-400">
            Entrée pour envoyer · Shift+Entrée pour un saut de ligne
          </div>
        </div>
      </div>
    </div>
  );
}
