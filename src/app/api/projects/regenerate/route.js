import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getServiceSupabase } from '@/lib/supabase';
import { PHASES } from '@/lib/phases';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CHAT_MODEL = 'claude-haiku-4-5-20251001';

export async function POST(request) {
  try {
    const { projectId, password } = await request.json();

    if (password !== process.env.CONSULTANT_PASSWORD) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
    }

    const sb = getServiceSupabase();

    const { data: project } = await sb
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (!project) {
      return NextResponse.json({ error: 'Projet non trouvé' }, { status: 404 });
    }

    // Récupérer tous les messages
    const { data: messages } = await sb
      .from('messages')
      .select('role, content, mode, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (!messages || messages.length < 2) {
      return NextResponse.json({ error: 'Pas assez de messages' }, { status: 400 });
    }

    const fullConversation = messages
      .map(m => `${m.role === 'user' ? (m.mode === 'consultant' ? 'CONSULTANT' : 'CLIENT') : 'BRIEFBOT'}: ${m.content}`)
      .join('\n\n');

    // Tronquer si trop long
    const conv = fullConversation.length > 30000
      ? fullConversation.substring(0, 12000) + '\n\n[...]\n\n' + fullConversation.substring(fullConversation.length - 15000)
      : fullConversation;

    const completedPhases = project.phases_completed || [];
    if (completedPhases.length === 0) {
      return NextResponse.json({ error: 'Aucune phase complétée' }, { status: 400 });
    }

    // Générer tous les résumés en un seul appel (plus efficace)
    const phasesList = completedPhases
      .sort((a, b) => a - b)
      .map(id => {
        const p = PHASES.find(ph => ph.id === id);
        return `Phase ${id} — ${p?.name || 'Inconnue'} (${p?.desc || ''})`;
      })
      .join('\n');

    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `À partir de cette conversation de briefing, génère un résumé structuré pour CHAQUE phase listée ci-dessous.

PHASES À RÉSUMER :
${phasesList}

FORMAT OBLIGATOIRE — utilise exactement ce format pour chaque phase :
===PHASE_X===
- bullet point 1
- bullet point 2
...
===FIN_PHASE_X===

Remplace X par le numéro de la phase.

RÈGLES :
- Reprends CHAQUE information concrète mentionnée : noms, chiffres, URLs, villes, dates, budgets, concurrents, mots-clés
- Bullet points concis mais EXHAUSTIFS
- Uniquement les FAITS collectés, pas de commentaires ou recommandations
- Si une info a été donnée pour une phase, elle DOIT apparaître dans le résumé de cette phase
- Français uniquement

CONVERSATION :
${conv}`
      }],
    });

    const resultText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    // Parser les résumés
    const summaries = {};
    for (const phaseId of completedPhases) {
      const regex = new RegExp(`===PHASE_${phaseId}===[\\s\\S]*?(?:===FIN_PHASE_${phaseId}===|===PHASE_|$)`, 'i');
      const match = resultText.match(regex);
      if (match) {
        let summary = match[0]
          .replace(new RegExp(`===PHASE_${phaseId}===`, 'i'), '')
          .replace(new RegExp(`===FIN_PHASE_${phaseId}===`, 'i'), '')
          .trim();
        if (summary) {
          summaries[String(phaseId)] = summary;
        }
      }
    }

    // Sauvegarder
    await sb
      .from('projects')
      .update({ phase_summaries: summaries })
      .eq('id', projectId);

    // Coût
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const costMicro = Math.round(inputTokens * 0.80 + outputTokens * 4);

    await sb.rpc('increment_project_cost', { project_id: projectId, amount: costMicro });
    await sb.rpc('increment_project_tokens', { project_id: projectId, amount: inputTokens + outputTokens });

    return NextResponse.json({
      success: true,
      phases_summarized: Object.keys(summaries).map(Number),
      count: Object.keys(summaries).length,
      cost_usd: costMicro / 1000000,
    });
  } catch (err) {
    console.error('Regenerate summaries error:', err);

    if (err.status === 429) {
      return NextResponse.json(
        { error: 'API surchargée, réessayez dans quelques secondes.' },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: 'Erreur : ' + (err.message || 'Inconnue') },
      { status: 500 }
    );
  }
}
