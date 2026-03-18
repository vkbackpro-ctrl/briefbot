'use client';

import { useState, useEffect, useRef } from 'react';
import { PHASES } from '@/lib/phases';

// ─── Markdown-like rendering ───
function renderMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-slate-100 px-1.5 py-0.5 rounded text-sm">$1</code>')
    .replace(/\n/g, '<br/>');
}

// ─── Message Bubble ───
function MessageBubble({ message }) {
  const isUser = message.role === 'user';
  const isConsultant = message.mode === 'consultant';

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''} mb-5 animate-fade-in`}>
      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold shadow-sm ${
        isUser
          ? isConsultant
            ? 'bg-blue-600 text-white'
            : 'bg-slate-700 text-white'
          : 'bg-gradient-to-br from-amber-400 to-orange-500 text-white'
      }`}>
        {isUser ? (isConsultant ? '🔧' : '👤') : '🤖'}
      </div>
      <div className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-sm ${
        isUser
          ? isConsultant
            ? 'bg-blue-600 text-white rounded-tr-md'
            : 'bg-slate-700 text-white rounded-tr-md'
          : 'bg-white border border-slate-200 text-slate-800 rounded-tl-md'
      }`}>
        <div
          className="text-sm leading-relaxed"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        />
        {message.created_at && (
          <div className={`text-[10px] mt-1.5 ${isUser ? 'text-white/50' : 'text-slate-400'}`}>
            {new Date(message.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
            {isConsultant && !isUser ? '' : isConsultant ? ' · Consultant' : ''}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Phase Chip ───
function PhaseChip({ phase, isActive, isComplete, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 flex items-center gap-2.5 group ${
        isActive
          ? 'bg-amber-50 border border-amber-300 shadow-sm'
          : isComplete
          ? 'bg-emerald-50/60 border border-emerald-200 hover:bg-emerald-50'
          : 'bg-white/60 border border-slate-200 hover:bg-slate-50 hover:border-slate-300'
      }`}
    >
      <span className="text-lg flex-shrink-0">{isComplete ? '✅' : phase.icon}</span>
      <div className="min-w-0">
        <div className={`text-xs font-semibold truncate ${
          isActive ? 'text-amber-800' : isComplete ? 'text-emerald-700' : 'text-slate-700'
        }`}>
          {phase.name}
        </div>
        <div className="text-[10px] text-slate-400 truncate">{phase.desc}</div>
      </div>
    </button>
  );
}

// ─── Main Chat Component ───
export default function Chat({ project: initialProject, initialMessages, mode: defaultMode, showModeToggle = false }) {
  const [project, setProject] = useState(initialProject);
  const [messages, setMessages] = useState(initialMessages || []);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(defaultMode || 'client');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Send initial message if no history
  useEffect(() => {
    if (messages.length === 0 && !loading) {
      sendInitialMessage();
    }
  }, []);

  const sendInitialMessage = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          message: 'Bonjour ! Je suis prêt à commencer le briefing pour ' + project.client_name + '.',
          mode,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      setMessages([
        { role: 'user', content: 'Bonjour ! Je suis prêt à commencer le briefing.', mode, created_at: new Date().toISOString() },
        { role: 'assistant', content: data.content, mode, created_at: new Date().toISOString() },
      ]);
    } catch (e) {
      setError('Erreur : ' + e.message);
    }
    setLoading(false);
  };

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: 'user', content: input.trim(), mode, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          message: userMsg.content,
          mode,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const aiMsg = { role: 'assistant', content: data.content, mode, created_at: new Date().toISOString() };
      setMessages(prev => [...prev, aiMsg]);

      // Update phase detection
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
    setLoading(false);
    inputRef.current?.focus();
  };

  const goToPhase = async (phaseId) => {
    if (loading) return;

    // Update phase on server
    await fetch('/api/projects/phase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, phaseId }),
    });

    setProject(prev => ({ ...prev, current_phase: phaseId }));

    const phaseName = PHASES.find(p => p.id === phaseId)?.name;
    const phaseMsg = `Je souhaite maintenant travailler sur la Phase ${phaseId} — ${phaseName}. Quelles questions as-tu pour moi sur ce sujet ?`;

    const userMsg = { role: 'user', content: phaseMsg, mode, created_at: new Date().toISOString() };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, message: phaseMsg, mode }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setMessages(prev => [...prev, { role: 'assistant', content: data.content, mode, created_at: new Date().toISOString() }]);
    } catch (e) {
      setError('Erreur : ' + e.message);
    }
    setLoading(false);
  };

  const currentPhase = PHASES.find(p => p.id === (project.current_phase ?? 0));

  return (
    <div className="h-screen flex bg-slate-50 overflow-hidden">
      {/* Sidebar */}
      {sidebarOpen && (
        <div className="w-64 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
          {/* Project info */}
          <div className="p-4 border-b border-slate-100">
            <h2 className="font-bold text-slate-800 text-sm truncate">{project.name}</h2>
            <p className="text-xs text-slate-400 truncate">{project.client_name}</p>
            {project.url && (
              <a href={project.url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-500 hover:underline truncate block mt-1">
                {project.url}
              </a>
            )}
          </div>

          {/* Mode toggle (consultant only) */}
          {showModeToggle && (
            <div className="px-4 py-3 border-b border-slate-100">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Mode</label>
              <div className="flex mt-1.5 bg-slate-100 rounded-lg p-0.5">
                <button
                  onClick={() => setMode('client')}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${
                    mode === 'client' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'
                  }`}
                >
                  👤 Client
                </button>
                <button
                  onClick={() => setMode('consultant')}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-md transition-all ${
                    mode === 'consultant' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'
                  }`}
                >
                  🔧 Consultant
                </button>
              </div>
            </div>
          )}

          {/* Phases */}
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">Phases du brief</label>
            {PHASES.map(phase => (
              <PhaseChip
                key={phase.id}
                phase={phase}
                isActive={(project.current_phase ?? 0) === phase.id}
                isComplete={(project.phases_completed || []).includes(phase.id)}
                onClick={() => goToPhase(phase.id)}
              />
            ))}
          </div>

        </div>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="h-14 bg-white border-b border-slate-200 flex items-center px-4 gap-3 flex-shrink-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600 hover:bg-slate-200 transition-all text-sm"
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-slate-800">{project.client_name}</span>
            <span className="text-xs text-slate-400 ml-2">
              Phase {project.current_phase ?? 0} — {currentPhase?.name}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${
              mode === 'consultant' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
            }`}>
              {mode === 'consultant' ? '🔧 Consultant' : '👤 Client'}
            </div>
            <div className="text-[10px] text-slate-400">
              {(project.phases_completed || []).filter(id => id > 0).length}/11 phases
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border-b border-red-200 text-red-700 text-xs px-4 py-2 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="font-bold ml-3">✕</button>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {messages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}

          {loading && (
            <div className="flex gap-3 mb-5 animate-fade-in">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white text-sm flex-shrink-0">
                🤖
              </div>
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
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
              }}
              placeholder={mode === 'consultant' ? 'Posez une question ou demandez une analyse...' : 'Répondez aux questions de BriefBot...'}
              rows={1}
              className="flex-1 px-4 py-3 border border-slate-300 rounded-xl text-sm resize-none bg-slate-50 focus:bg-white transition-colors"
              style={{ minHeight: '44px', maxHeight: '120px' }}
              onInput={e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }}
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || loading}
              className={`px-5 py-3 rounded-xl text-sm font-bold transition-all flex-shrink-0 ${
                input.trim() && !loading
                  ? 'bg-slate-800 text-white hover:bg-slate-700 shadow-md'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed'
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
