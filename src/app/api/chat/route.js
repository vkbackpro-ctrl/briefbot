import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getServiceSupabase } from '@/lib/supabase';
import { buildSystemPrompt } from '@/lib/phases';
import { TOOLS, executeTool } from '@/lib/tools';

// Augmenter le timeout Vercel pour les appels API avec tool use
export const maxDuration = 120;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Pricing Claude Sonnet en micro-dollars par token
// $3/M input = 3 µ$/token, $15/M output = 15 µ$/token
const INPUT_COST_MICRO = 3;
const OUTPUT_COST_MICRO = 15;

// Nombre max de messages d'historique envoyés à l'API
// Au-delà, on garde un résumé des premiers + les N derniers
const MAX_HISTORY_MESSAGES = 30;

// ── Retry avec exponential backoff ──
async function callAnthropicWithRetry(params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        const wait = Math.pow(2, i) * 1500 + Math.random() * 500; // 1.5s, 3s, 6s
        console.log(`[Rate Limit] Retry ${i + 1}/${maxRetries} dans ${Math.round(wait)}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// ── Tronquer l'historique pour rester sous la limite ──
function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;

  // Garder les 4 premiers messages (contexte initial + profiling Phase 0)
  // + les N derniers messages (conversation récente)
  const keepStart = 4;
  const keepEnd = MAX_HISTORY_MESSAGES - keepStart - 1; // -1 pour le message résumé
  const start = messages.slice(0, keepStart);
  const end = messages.slice(-keepEnd);

  // Insérer un message résumé entre les deux
  const skipped = messages.length - keepStart - keepEnd;
  const summary = {
    role: 'user',
    content: `[Note système : ${skipped} messages intermédiaires ont été omis pour optimiser la conversation. Les informations clés ont été collectées dans les phases précédentes. Continue avec le contexte disponible.]`,
  };

  return [...start, summary, ...end];
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

    // Vérifier le budget (système en micro-dollars)
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

    // Tronquer l'historique si trop long
    const apiMessages = trimHistory(allMessages);

    // System prompt avec cache_control pour le prompt caching
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

    // Calculer le coût réel en micro-dollars
    const costMicro = totalInputTokens * INPUT_COST_MICRO + totalOutputTokens * OUTPUT_COST_MICRO;
    const totalTokens = totalInputTokens + totalOutputTokens;

    // Incrémenter le coût réel
    const { data: newCostMicro, error: costRpcErr } = await sb.rpc('increment_project_cost', {
      project_id: projectId,
      amount: costMicro,
    });

    // Incrémenter aussi les tokens (pour référence)
    await sb.rpc('increment_project_tokens', {
      project_id: projectId,
      amount: totalTokens,
    });

    const actualCostMicro = costRpcErr ? currentCost + costMicro : newCostMicro;

    // Sauvegarder la réponse finale
    await sb.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      content: aiText,
      mode: mode || 'client',
    });

    // Détecter la complétion de phase
    const phaseMatch = aiText.match(/✅\s*Phase\s*(\d+)/);
    if (phaseMatch) {
      const completedId = parseInt(phaseMatch[1]);
      const currentPhases = project.phases_completed || [];
      if (!currentPhases.includes(completedId)) {
        await sb
          .from('projects')
          .update({
            phases_completed: [...currentPhases, completedId],
            current_phase: Math.min(completedId + 1, 10),
          })
          .eq('id', projectId);
      }
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

    // Message d'erreur plus clair pour le rate limit
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
