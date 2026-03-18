import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getServiceSupabase } from '@/lib/supabase';
import { buildSystemPrompt, PHASES } from '@/lib/phases';
import { TOOLS, executeTool } from '@/lib/tools';

export const maxDuration = 60;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const INPUT_COST_MICRO = 3;
const OUTPUT_COST_MICRO = 15;

// Nombre max de messages récents à envoyer (phase en cours uniquement)
const MAX_RECENT_MESSAGES = 16;

// ── Retry avec exponential backoff ──
async function callAnthropicWithRetry(params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        const wait = Math.pow(2, i) * 1500 + Math.random() * 500;
        console.log(`[Rate Limit] Retry ${i + 1}/${maxRetries} dans ${Math.round(wait)}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// ── Construire les messages avec résumés des phases précédentes ──
function buildSmartMessages(allMessages, phaseSummaries) {
  const summaries = phaseSummaries || {};
  const summaryKeys = Object.keys(summaries).sort((a, b) => Number(a) - Number(b));

  // S'il y a des résumés de phases, on les injecte comme contexte
  // puis on ne garde que les messages récents
  if (summaryKeys.length > 0) {
    const summaryText = summaryKeys
      .map(phaseId => {
        const phaseName = PHASES.find(p => p.id === Number(phaseId))?.name || `Phase ${phaseId}`;
        return `## Résumé Phase ${phaseId} — ${phaseName}\n${summaries[phaseId]}`;
      })
      .join('\n\n');

    const contextMessage = {
      role: 'user',
      content: `[CONTEXTE — Résumés des phases précédentes. Ces informations ont déjà été collectées, NE PAS reposer ces questions.]\n\n${summaryText}\n\n[FIN DU CONTEXTE — Continue la conversation à partir d'ici.]`,
    };

    // Garder seulement les messages récents (phase en cours)
    const recentMessages = allMessages.slice(-MAX_RECENT_MESSAGES);

    return [contextMessage, ...recentMessages];
  }

  // Pas de résumés encore → garder les messages classiques (tronqués si besoin)
  if (allMessages.length <= MAX_RECENT_MESSAGES + 4) return allMessages;

  const start = allMessages.slice(0, 4);
  const end = allMessages.slice(-MAX_RECENT_MESSAGES);
  const skipped = allMessages.length - 4 - MAX_RECENT_MESSAGES;

  return [
    ...start,
    { role: 'user', content: `[${skipped} messages omis — les informations clés sont dans les résumés de phase quand disponibles.]` },
    ...end,
  ];
}

// ── Générer un résumé de phase (appel léger) ──
async function generatePhaseSummary(sb, projectId, phaseId, allMessages) {
  const phaseName = PHASES.find(p => p.id === phaseId)?.name || `Phase ${phaseId}`;

  // Prendre les derniers messages pertinents (ceux de cette phase)
  const recentConv = allMessages.slice(-30)
    .map(m => `${m.role === 'user' ? 'CLIENT' : 'BRIEFBOT'}: ${m.content}`)
    .join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Résume en bullet points TOUTES les informations clés collectées pendant la Phase ${phaseId} — ${phaseName} de ce briefing.

RÈGLES :
- Reprends CHAQUE information concrète : noms, chiffres, URLs, villes, dates, budgets
- Format : bullet points concis mais exhaustifs
- Ne mets PAS de commentaires ou recommandations, uniquement les FAITS collectés
- Si le client a donné un chiffre ou un nom, il DOIT apparaître
- Français uniquement

Conversation récente :
${recentConv.substring(0, 8000)}`
      }],
    });

    const summary = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    // Coût du résumé
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const costMicro = inputTokens * INPUT_COST_MICRO + outputTokens * OUTPUT_COST_MICRO;

    await sb.rpc('increment_project_cost', { project_id: projectId, amount: costMicro });
    await sb.rpc('increment_project_tokens', { project_id: projectId, amount: inputTokens + outputTokens });

    // Sauvegarder le résumé dans le projet
    const { data: proj } = await sb
      .from('projects')
      .select('phase_summaries')
      .eq('id', projectId)
      .single();

    const existingSummaries = proj?.phase_summaries || {};
    existingSummaries[String(phaseId)] = summary;

    await sb
      .from('projects')
      .update({ phase_summaries: existingSummaries })
      .eq('id', projectId);

    console.log(`[Phase Summary] Phase ${phaseId} résumée (${summary.length} chars, coût: ${costMicro}µ$)`);

    return summary;
  } catch (err) {
    console.error(`[Phase Summary] Erreur résumé phase ${phaseId}:`, err.message);
    return null;
  }
}

export async function POST(request) {
  try {
    const { projectId, message, mode } = await request.json();

    if (!projectId || !message) {
      return NextResponse.json({ error: 'projectId et message requis' }, { status: 400 });
    }

    const sb = getServiceSupabase();

    const { data: project, error: projErr } = await sb
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projErr || !project) {
      return NextResponse.json({ error: 'Projet non trouvé' }, { status: 404 });
    }

    const currentCost = project.cost_micro_usd || 0;
    const budget = project.budget_micro_usd || 5000000;
    if (currentCost >= budget) {
      return NextResponse.json({
        error: 'Budget atteint pour ce projet.',
        limit_reached: true,
        cost_usd: currentCost / 1000000,
        budget_usd: budget / 1000000,
      }, { status: 429 });
    }

    // Sauvegarder le message utilisateur
    await sb.from('messages').insert({
      project_id: projectId,
      role: 'user',
      content: message,
      mode: mode || 'client',
    });

    // Récupérer l'historique
    const { data: history } = await sb
      .from('messages')
      .select('role, content')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    const allMessages = (history || []).map(m => ({
      role: m.role,
      content: m.content,
    }));

    // Construire les messages intelligemment :
    // résumés des phases complétées + messages récents uniquement
    const apiMessages = buildSmartMessages(allMessages, project.phase_summaries);

    const systemPrompt = buildSystemPrompt(project, mode || 'client');

    // ── Boucle tool use ──
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let loopMessages = [...apiMessages];
    let maxIterations = 5;

    let response = await callAnthropicWithRetry({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        }
      ],
      messages: loopMessages,
      tools: TOOLS,
    });

    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

    let iterations = 0;
    while (response.stop_reason === 'tool_use' && iterations < maxIterations) {
      iterations++;

      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`[Tool Use] ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
        const result = await executeTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result).substring(0, 15000),
        });
      }

      loopMessages.push({ role: 'assistant', content: response.content });
      loopMessages.push({ role: 'user', content: toolResults });

      response = await callAnthropicWithRetry({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          }
        ],
        messages: loopMessages,
        tools: TOOLS,
      });

      totalInputTokens += response.usage?.input_tokens || 0;
      totalOutputTokens += response.usage?.output_tokens || 0;
    }

    // Extraire le texte final
    const aiText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    // Calculer le coût réel
    const costMicro = totalInputTokens * INPUT_COST_MICRO + totalOutputTokens * OUTPUT_COST_MICRO;
    const totalTokens = totalInputTokens + totalOutputTokens;

    const { data: newCostMicro, error: costRpcErr } = await sb.rpc('increment_project_cost', {
      project_id: projectId,
      amount: costMicro,
    });

    await sb.rpc('increment_project_tokens', {
      project_id: projectId,
      amount: totalTokens,
    });

    const actualCostMicro = costRpcErr ? currentCost + costMicro : newCostMicro;

    // Sauvegarder la réponse
    await sb.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      content: aiText,
      mode: mode || 'client',
    });

    // Détecter la complétion de phase → générer un résumé automatiquement
    const phaseMatch = aiText.match(/✅\s*Phase\s*(\d+)/);
    const currentPhases = project.phases_completed || [];
    let updatedPhases = [...currentPhases];
    let newCurrentPhase = project.current_phase ?? 0;

    if (phaseMatch) {
      const completedId = parseInt(phaseMatch[1]);
      if (!updatedPhases.includes(completedId)) {
        updatedPhases.push(completedId);

        // Trouver la prochaine phase non complétée (pas juste +1)
        const allPhaseIds = PHASES.map(p => p.id);
        const nextUncompleted = allPhaseIds.find(id => id > 0 && !updatedPhases.includes(id));
        newCurrentPhase = nextUncompleted !== undefined ? nextUncompleted : 10;

        // Générer le résumé de la phase complétée (en arrière-plan)
        generatePhaseSummary(sb, projectId, completedId, allMessages)
          .catch(err => console.error('[Phase Summary] Background error:', err));
      }
    }

    // Détecter aussi quand l'IA indique être sur une phase [Phase X — ...]
    const phaseIndicator = aiText.match(/\[Phase\s*(\d+)\s*[—–-]/);
    if (phaseIndicator) {
      const indicatedPhase = parseInt(phaseIndicator[1]);
      if (indicatedPhase !== newCurrentPhase) {
        newCurrentPhase = indicatedPhase;
      }
    }

    // Si l'IA confirme qu'une phase est déjà complétée (revisitée),
    // s'assurer qu'elle est bien dans phases_completed
    const alreadyDoneMatch = aiText.match(/[Pp]hase\s*(\d+).*(?:déjà complétée|déjà été couverte|déjà abordée|déjà collecté)/);
    if (alreadyDoneMatch) {
      const doneId = parseInt(alreadyDoneMatch[1]);
      if (!updatedPhases.includes(doneId)) {
        updatedPhases.push(doneId);
      }
    }

    // Mettre à jour le projet si quelque chose a changé
    if (updatedPhases.length !== currentPhases.length || newCurrentPhase !== (project.current_phase ?? 0)) {
      await sb
        .from('projects')
        .update({
          phases_completed: updatedPhases,
          current_phase: newCurrentPhase,
        })
        .eq('id', projectId);
    }

    return NextResponse.json({
      content: aiText,
      cost_usd: actualCostMicro / 1000000,
      budget_usd: budget / 1000000,
      cost_this_message_usd: costMicro / 1000000,
      tokens_used: totalTokens,
      tokens_this_message: totalTokens,
      tokens_input: totalInputTokens,
      tokens_output: totalOutputTokens,
      tools_used: iterations > 0,
    });
  } catch (err) {
    console.error('Chat API error:', err);

    if (err.status === 429) {
      return NextResponse.json(
        { error: 'L\'API Claude est temporairement surchargée. Réessayez dans quelques secondes.' },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: 'Erreur serveur : ' + (err.message || 'Inconnue') },
      { status: 500 }
    );
  }
}
